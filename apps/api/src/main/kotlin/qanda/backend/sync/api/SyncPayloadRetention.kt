package qanda.backend.sync.api

import io.micrometer.core.instrument.MeterRegistry
import org.springframework.core.env.Environment
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.Duration
import java.sql.Timestamp

@Service
class SyncPayloadRetention(private val jdbc: JdbcTemplate,private val environment: Environment,private val clock: Clock,
                           manager: PlatformTransactionManager,registry: MeterRegistry) {
    private val tx=TransactionTemplate(manager)
    private val compacted=registry.counter("qanda.sync.payload.compacted")
    private val bytes=registry.counter("qanda.sync.payload.released.bytes")
    private val failures=registry.counter("qanda.sync.payload.failures")
    private val duration=registry.timer("qanda.sync.payload.compaction")

    @Scheduled(fixedDelay=600000,initialDelay=600000)
    fun compact(): Long {
        if(!environment.getProperty("qanda.backend.worker-enabled",Boolean::class.java,false)) return 0
        val start=System.nanoTime()
        try {
            val result=tx.execute {
                jdbc.queryForObject("""WITH expired AS (
                    SELECT c.id,c.payload_bytes FROM sync_command c JOIN command_receipt r ON r.id=c.receipt_id
                    WHERE c.state='COMMITTED' AND c.payload_json IS NOT NULL AND c.completed_at<?
                    ORDER BY c.completed_at,c.id LIMIT 500 FOR UPDATE OF c SKIP LOCKED
                ), compacted AS (
                    UPDATE sync_command c SET payload_json=NULL FROM expired e WHERE c.id=e.id RETURNING e.payload_bytes
                ) SELECT count(*) n,coalesce(sum(payload_bytes),0) bytes FROM compacted""",
                    { r,_ -> r.getLong("n") to r.getLong("bytes") },Timestamp.from(clock.instant().minus(Duration.ofDays(30))))!!
            }!!
            compacted.increment(result.first.toDouble());bytes.increment(result.second.toDouble())
            return result.first
        } catch(error: Exception) { failures.increment();throw error }
        finally { duration.record(System.nanoTime()-start,java.util.concurrent.TimeUnit.NANOSECONDS) }
    }
}
