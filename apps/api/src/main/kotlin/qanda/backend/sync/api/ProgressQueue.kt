package qanda.backend.sync.api

import org.springframework.amqp.core.*
import org.springframework.amqp.rabbit.connection.CorrelationData
import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import qanda.backend.platform.http.ApiException
import qanda.backend.platform.http.ErrorDetails
import java.util.UUID
import java.util.concurrent.TimeUnit

object ProgressQueues {
    const val EXCHANGE="qanda.sync"
    const val READY="qanda.sync.progress"
    const val RETRY="qanda.sync.retry"
    const val DEAD="qanda.sync.dead"
}

@Configuration
class ProgressQueueConfiguration {
    @Bean fun progressTopology(): Declarables {
        val exchange=DirectExchange(ProgressQueues.EXCHANGE,true,false)
        val dead=QueueBuilder.durable(ProgressQueues.DEAD).quorum().withArgument("x-delivery-limit",-1).build()
        val ready=QueueBuilder.durable(ProgressQueues.READY).quorum()
            // PostgreSQL retains complete tasks; notification redelivery must not discard them.
            .withArgument("x-delivery-limit",-1).deadLetterExchange(ProgressQueues.EXCHANGE).deadLetterRoutingKey("dead")
            .withArgument("x-dead-letter-strategy","at-least-once").withArgument("x-overflow","reject-publish").build()
        val retry=QueueBuilder.durable(ProgressQueues.RETRY).quorum().deadLetterExchange(ProgressQueues.EXCHANGE).deadLetterRoutingKey("progress")
            .withArgument("x-dead-letter-strategy","at-least-once").withArgument("x-overflow","reject-publish").build()
        return Declarables(exchange,ready,retry,dead,BindingBuilder.bind(ready).to(exchange).with("progress"),
            BindingBuilder.bind(retry).to(exchange).with("retry"),BindingBuilder.bind(dead).to(exchange).with("dead"))
    }
}

@Service
class ProgressQueue(private val rabbit: RabbitTemplate) {
    fun <T> inspectDeadLetter(read: (ByteArray)->T): T? = rabbit.execute { channel ->
        val message=channel.basicGet(ProgressQueues.DEAD,false) ?: return@execute null
        try { read(message.body) } finally { channel.basicNack(message.envelope.deliveryTag,false,true) }
    }
    fun replayHead(commandId: UUID,republish: Boolean=true,validate: (ByteArray)->Unit) {
        rabbit.execute { channel ->
            val message=channel.basicGet(ProgressQueues.DEAD,false) ?: qanda.backend.platform.http.missing()
            try {
                validate(message.body)
                if(republish) publish(message.body,commandId)
                channel.basicAck(message.envelope.deliveryTag,false)
            } catch(error: Exception) { channel.basicNack(message.envelope.deliveryTag,false,true);throw error }
        }
    }
    fun publish(bytes: ByteArray,commandId: UUID,route: String="progress",delayMs: Long?=null) {
        val properties=MessageProperties().apply {
            contentType="application/json";contentEncoding="UTF-8";deliveryMode=MessageDeliveryMode.PERSISTENT;messageId=commandId.toString()
            delayMs?.let { expiration=it.toString() }
        }
        val correlation=CorrelationData(UUID.randomUUID().toString())
        try {
            rabbit.setMandatory(true)
            rabbit.send(ProgressQueues.EXCHANGE,route,Message(bytes,properties),correlation)
            val confirmation=correlation.future.get(5,TimeUnit.SECONDS)
            check(confirmation.isAck && correlation.returned==null)
        } catch(_: Exception) {
            throw ApiException(HttpStatus.SERVICE_UNAVAILABLE,"SYNC_QUEUE_UNAVAILABLE","进度尚未确认入队，请保留草稿并使用原请求标识重试",details=ErrorDetails(retryAfterSeconds=3))
        }
    }
}
