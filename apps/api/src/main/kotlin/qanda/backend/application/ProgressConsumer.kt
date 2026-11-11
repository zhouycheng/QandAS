package qanda.backend.application

import com.fasterxml.jackson.databind.ObjectMapper
import com.rabbitmq.client.Channel
import org.slf4j.LoggerFactory
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.annotation.RabbitListener
import org.springframework.stereotype.Component
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.core.env.Environment
import qanda.backend.sync.api.*

@Component
class ProgressConsumer(private val commands: ProgressCommands,private val queue: ProgressQueue,private val json: ObjectMapper,private val environment: Environment) {
    @Scheduled(fixedDelay=100)
    fun dispatch() {
        if(environment.getProperty("qanda.backend.worker-enabled",Boolean::class.java,false))
            try { commands.dispatch() } catch(error: Exception) { log.warn("Sync dispatch deferred: {}",error.javaClass.simpleName) }
    }
    private val log=LoggerFactory.getLogger(javaClass)
    @RabbitListener(queues=[ProgressQueues.READY],concurrency="4",ackMode="MANUAL",autoStartup="\${qanda.backend.worker-enabled:false}")
    fun receive(message: Message,channel: Channel) {
        val tag=message.messageProperties.deliveryTag
        try {
            val envelope=try { json.readValue(message.body,ProgressEnvelope::class.java) } catch(_: com.fasterxml.jackson.core.JacksonException) {
                queue.publish(message.body,runCatching { java.util.UUID.fromString(message.messageProperties.messageId) }.getOrElse { java.util.UUID.randomUUID() },"dead")
                channel.basicAck(tag,false)
                return
            }
            try { commands.consume(envelope) }
            catch(error: Exception) {
                val (route,_)=commands.failure(envelope.commandId,error)
                if(route=="dead") queue.publish(message.body,envelope.commandId,"dead")
            }
            channel.basicAck(tag,false)
        } catch(error: Exception) {
            log.warn("Progress delivery retained: {}",error.javaClass.simpleName)
            // Keep the delivery unacknowledged during infrastructure backoff.
            val deliveries=(message.messageProperties.headers["x-delivery-count"] as? Number)?.toInt() ?: 0
            Thread.sleep(minOf(60000L,1000L shl deliveries.coerceIn(0,6)))
            channel.basicNack(tag,false,true)
        }
    }
}
