package qanda.backend.application

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
import org.springframework.context.annotation.Configuration
import org.springframework.context.event.EventListener
import org.springframework.http.server.ServerHttpRequest
import org.springframework.http.server.ServerHttpResponse
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.web.socket.*
import org.springframework.web.socket.config.annotation.*
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator
import org.springframework.web.socket.handler.TextWebSocketHandler
import org.springframework.web.socket.server.HandshakeInterceptor
import org.springframework.web.util.UriComponentsBuilder
import io.micrometer.core.instrument.MeterRegistry
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.ApiException
import qanda.backend.platform.http.invalid
import qanda.backend.platform.security.Actor
import qanda.backend.practice.*
import java.time.Clock
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@Configuration
@EnableWebSocket
@ConditionalOnWebApplication(type=ConditionalOnWebApplication.Type.SERVLET)
class PracticeSocketConfiguration(private val socket: PracticeSocket,private val sessions: Sessions): WebSocketConfigurer {
    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        registry.addHandler(socket,"/api/v1/practice/writer-socket").setAllowedOriginPatterns("https://servicewechat.com","https://*.servicewechat.com","https://developers.weixin.qq.com")
            .addInterceptors(object: HandshakeInterceptor {
                override fun beforeHandshake(request: ServerHttpRequest,response: ServerHttpResponse,handler: WebSocketHandler,attributes: MutableMap<String,Any>): Boolean {
                    val actor=sessions.student()
                    val parameters=UriComponentsBuilder.fromUri(request.uri).build().queryParams
                    val id=runCatching { UUID.fromString(parameters.getFirst("sessionId")) }.getOrElse { invalid("/sessionId") }
                    val device=runCatching { UUID.fromString(parameters.getFirst("deviceId")) }.getOrElse { invalid("/deviceId") }
                    sessions.requireDevice(actor,device)
                    attributes["actor"]=actor;attributes["practice"]=id;attributes["device"]=device
                    val room=socket.hasRoom(actor)
                    if(!room) response.setStatusCode(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS)
                    return room
                }
                override fun afterHandshake(request: ServerHttpRequest,response: ServerHttpResponse,handler: WebSocketHandler,exception: Exception?) {}
            })
    }
}

@Component
class PracticeSocket(private val practice: PracticeService,private val presence: WriterPresence,private val sessions: Sessions,
                     private val json: ObjectMapper,private val clock: Clock,private val meters: MeterRegistry): TextWebSocketHandler() {
    private data class Client(val socket: WebSocketSession,val actor: Actor,val id: UUID,val device: UUID,var token: UUID?=null,var epoch: Long=0,var lastSeen: Long=0,var draining: Boolean=false,var bound: Boolean=false)
    private val clients=ConcurrentHashMap<String,Client>()
    init { meters.gauge("qanda.practice.socket.connections",clients) { it.size.toDouble() } }
    fun hasRoom(actor: Actor)=clients.size<2400 && clients.values.count { it.actor.sessionId==actor.sessionId }<2
    override fun afterConnectionEstablished(session: WebSocketSession) {
        val actor=session.attributes["actor"] as Actor
        if(!hasRoom(actor)) { session.close(CloseStatus(1013,"Connection capacity reached"));return }
        val client=Client(ConcurrentWebSocketSessionDecorator(session,2000,16384),actor,session.attributes["practice"] as UUID,session.attributes["device"] as UUID,lastSeen=clock.millis())
        clients[session.id]=client
        meters.counter("qanda.practice.socket.opens").increment()
    }
    override fun handleTextMessage(session: WebSocketSession,message: TextMessage) {
        val client=clients[session.id] ?: return
        synchronized(client) {
        try {
            if(message.payloadLength>2048) { session.close(CloseStatus.TOO_BIG_TO_PROCESS);return }
            val body=json.readTree(message.payload)
            when(body["type"]?.asText()) {
                "BIND" -> {
                    if(client.bound) { session.close(CloseStatus.POLICY_VIOLATION);return }
                    val token=body["writerToken"]?.takeUnless { it.isNull }?.asText()?.let(UUID::fromString)
                    val epoch=body["epoch"]?.asLong() ?: 0
                    val state=practice.connectWriter(client.actor,client.id,client.device,token,epoch)
                    client.token=token;client.epoch=state.writer.epoch;client.lastSeen=clock.millis();client.draining=state.draining && token!=null;client.bound=true
                    send(client,mapOf("type" to "BOUND","state" to state,"leaseMillis" to WriterPresence.LEASE_MILLIS))
                }
                "PING" -> {
                    if(!client.bound) { session.close(CloseStatus.POLICY_VIOLATION);return }
                    if(clock.millis()-client.lastSeen<1000) return
                    client.lastSeen=clock.millis()
                    val token=client.token
                    if(token!=null && !client.draining && !presence.renew(client.id,token)) { send(client,mapOf("type" to "WRITER_CHANGED"));session.close();return }
                    send(client,mapOf("type" to "PONG","leaseMillis" to WriterPresence.LEASE_MILLIS))
                }
                else -> session.close(CloseStatus.BAD_DATA)
            }
        } catch(error: Exception) {
            send(client,mapOf("type" to "ERROR","code" to ((error as? ApiException)?.code ?: "SOCKET_UNAVAILABLE")))
            session.close(CloseStatus.POLICY_VIOLATION)
        }
        }
    }
    private fun send(client: Client,data: Any) { runCatching { if(client.socket.isOpen) client.socket.sendMessage(TextMessage(json.writeValueAsString(data))) }.onFailure { runCatching { client.socket.close() } } }
    @EventListener fun changed(event: WriterSignal) {
        clients.values.filter { it.id==event.sessionId }.forEach { client ->
            synchronized(client) {
            if(event.type=="WRITER_CHANGED" && client.token!=null && client.epoch==event.epoch) return@forEach
            if(event.type=="DRAIN_WRITER" && client.token!=null) { client.draining=true }
            send(client,mapOf("type" to event.type,"epoch" to event.epoch))
            if(event.type=="WRITER_CHANGED" && client.token!=null && client.epoch!=event.epoch) runCatching { client.socket.close() }
            }
        }
    }
    override fun afterConnectionClosed(session: WebSocketSession,status: CloseStatus) { clients.remove(session.id) }
    override fun handleTransportError(session: WebSocketSession,exception: Throwable) { clients.remove(session.id);runCatching { session.close() } }
    @Scheduled(fixedDelay=5000) fun sweep() {
        val expired=clock.millis()-WriterPresence.LEASE_MILLIS
        clients.values.filter { it.lastSeen<expired }.forEach { runCatching { it.socket.close(CloseStatus.SESSION_NOT_RELIABLE) };clients.remove(it.socket.id) }
        presence.sweep()
    }
    @Scheduled(fixedDelay=30000) fun revalidate() {
        val active=clients.values.toList()
        if(active.isEmpty()) return
        val valid=runCatching { sessions.activeStudents(active.map { it.actor.sessionId }.distinct()) }.getOrElse { emptySet() }
        active.filter { it.actor.sessionId !in valid }.forEach { runCatching { it.socket.close(CloseStatus.POLICY_VIOLATION) };clients.remove(it.socket.id) }
    }
}
