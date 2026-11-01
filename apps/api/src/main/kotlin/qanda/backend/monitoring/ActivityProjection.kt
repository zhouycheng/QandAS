package qanda.backend.monitoring

import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

@Service
@ConditionalOnProperty(name=["qanda.backend.worker-enabled"],havingValue="true")
class ActivityProjection(private val jdbc: JdbcTemplate,manager: PlatformTransactionManager) {
    private val tx=TransactionTemplate(manager).apply { timeout=3 }
    private val log=LoggerFactory.getLogger(javaClass)
    @Scheduled(fixedDelay=1000)
    fun tick() { try { drain() } catch(error: Exception) { log.warn("Activity projection deferred: {}",error.javaClass.simpleName) } }
    fun drain(): Int=tx.execute {
        jdbc.execute("SET LOCAL ROLE qanda_activity_writer")
        jdbc.update("""
            WITH pending AS(SELECT * FROM domain_event_outbox WHERE processed_at IS NULL ORDER BY occurred_at,id LIMIT 200 FOR UPDATE SKIP LOCKED),
            projection AS(INSERT INTO user_activity(user_id,platform,activity_date,first_seen_at,last_seen_at)
              SELECT user_id,platform,(occurred_at AT TIME ZONE 'Asia/Shanghai')::date,min(occurred_at),max(occurred_at) FROM pending GROUP BY 1,2,3
              ON CONFLICT(user_id,platform,activity_date) DO UPDATE SET first_seen_at=least(user_activity.first_seen_at,excluded.first_seen_at),last_seen_at=greatest(user_activity.last_seen_at,excluded.last_seen_at) RETURNING user_id)
            UPDATE domain_event_outbox SET processed_at=now() WHERE id IN(SELECT id FROM pending)
        """.trimIndent())
    } ?: 0
}
