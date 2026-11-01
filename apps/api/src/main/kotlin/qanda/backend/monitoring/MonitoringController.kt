package qanda.backend.monitoring

import jakarta.annotation.PreDestroy
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpStatus
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.*
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.media.Content
import io.swagger.v3.oas.annotations.media.Schema
import io.swagger.v3.oas.annotations.responses.ApiResponse
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.ApiException
import qanda.backend.platform.http.ErrorDetails
import qanda.backend.platform.security.Actor
import java.util.concurrent.*

@Service
class SyncStreams(private val health: SyncHealth,private val sessions: Sessions) {
    private data class Client(val emitter: SseEmitter,val actor: Actor,val latest: ArrayBlockingQueue<SyncHealthView> = ArrayBlockingQueue(1))
    private val clients=ConcurrentHashMap<SseEmitter,Client>()
    private val slots=Semaphore(64)
    private val writers=Executors.newVirtualThreadPerTaskExecutor()
    fun subscribe(actor: Actor): SseEmitter {
        if(!slots.tryAcquire()) throw ApiException(HttpStatus.TOO_MANY_REQUESTS,"STREAM_LIMIT","监控连接较多，请稍后重试",details=ErrorDetails(retryAfterSeconds=5))
        val emitter=SseEmitter(0L);val client=Client(emitter,actor)
        clients[emitter]=client
        fun close() { if(clients.remove(emitter)!=null) slots.release() }
        emitter.onCompletion { close() };emitter.onTimeout { close() };emitter.onError { close() }
        client.latest.offer(health.snapshot())
        writers.submit {
            try {
                var checked=0L
                while(clients.containsKey(emitter) && !Thread.currentThread().isInterrupted) {
                    if(System.nanoTime()-checked>=15_000_000_000L) {
                        sessions.revalidate(actor);checked=System.nanoTime()
                    }
                    val snapshot=client.latest.poll(15,TimeUnit.SECONDS)
                    if(!clients.containsKey(emitter)) break
                    if(snapshot==null) emitter.send(SseEmitter.event().comment("keepalive"))
                    else emitter.send(SseEmitter.event().name("sync-health").id(snapshot.checkedAt.toString()).data(snapshot))
                }
            } catch(error: ApiException) {
                runCatching { emitter.send(SseEmitter.event().name("auth-expired").data(mapOf("code" to error.code))) }
            } catch(_: Exception) { /* The next connection receives the latest snapshot. */ }
            finally { close();emitter.complete() }
        }
        return emitter
    }
    @Scheduled(fixedDelay=5000)
    fun broadcast() { val snapshot=health.snapshot();clients.values.forEach { it.latest.clear();it.latest.offer(snapshot) } }
    @PreDestroy fun close() { clients.keys.forEach { it.complete() };writers.shutdownNow() }
}

@RestController
@RequestMapping("/api/v1/admin/monitoring")
class MonitoringController(private val health: SyncHealth,private val streams: SyncStreams,private val sessions: Sessions) {
    @GetMapping("/health",produces=["application/json"])
    fun health(): SystemHealthView { sessions.admin();return health.health() }
    @GetMapping("/sync/stream",produces=["text/event-stream"])
    @Operation(responses=[ApiResponse(responseCode="200",description="SSE 同步健康快照；每 5 秒更新",content=[Content(mediaType="text/event-stream",schema=Schema(implementation=SyncHealthView::class))])])
    fun stream(response: HttpServletResponse): SseEmitter {
        val actor=sessions.admin()
        response.setHeader("X-Accel-Buffering","no")
        return streams.subscribe(actor)
    }
}
