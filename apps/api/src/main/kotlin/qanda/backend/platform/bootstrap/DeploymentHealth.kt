package qanda.backend.platform.bootstrap

import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.amqp.rabbit.listener.RabbitListenerEndpointRegistry
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer
import org.springframework.boot.actuate.health.*
import org.springframework.core.env.Environment
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Component
import java.nio.file.*

@Component("deploymentHealthIndicator")
class DeploymentHealth(private val jdbc: JdbcTemplate, private val rabbit: RabbitTemplate,
    private val env: Environment, private val listeners: RabbitListenerEndpointRegistry) : HealthIndicator {
    override fun health(): Health = try {
        val monitor = env.getProperty("qanda.backend.role") == "monitor"
        if (monitor) jdbc.queryForObject("SELECT count(include_in_statistics) FROM monitoring_student WHERE false", Long::class.java)
        else {
            check(jdbc.queryForObject("SELECT 1", Int::class.java) == 1)
            check(rabbit.execute { channel -> channel.queueDeclarePassive("qanda.sync.progress").consumerCount } != null)
        }
        if (env.getProperty("qanda.backend.files.enabled", Boolean::class.java, false) && !monitor) {
            val root = Path.of(env.getRequiredProperty("qanda.backend.files.root"))
            check(!Files.isSymbolicLink(root) && Files.isDirectory(root) && Files.isReadable(root) && Files.isWritable(root))
        }
        if (env.getProperty("qanda.backend.worker-enabled", Boolean::class.java, false)) {
            check(listeners.listenerContainers.isNotEmpty() && listeners.listenerContainers.all {
                it.isRunning && (it as? SimpleMessageListenerContainer)?.activeConsumerCount != 0
            })
        }
        Health.up().build()
    } catch (_: Exception) { Health.down().build() }
}

