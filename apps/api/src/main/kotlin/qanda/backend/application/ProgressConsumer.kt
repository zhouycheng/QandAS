package qanda.backend.application

import com.fasterxml.jackson.databind.ObjectMapper
import com.rabbitmq.client.Channel
import org.slf4j.LoggerFactory
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.annotation.RabbitListener
import org.springframework.stereotype.Component
import qanda.backend.sync.api.*

@Component
class ProgressConsumer(private val commands: ProgressCommands,private val queue: ProgressQueue,private val json: ObjectMapper) {
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
                val (route,delay)=commands.failure(envelope.commandId,error)
                if(route!="done") queue.publish(message.body,envelope.commandId,route,delay.takeIf { it>0 })
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
