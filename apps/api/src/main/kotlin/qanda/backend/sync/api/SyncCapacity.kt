package qanda.backend.sync.api

import io.micrometer.core.instrument.MeterRegistry
import org.springframework.core.env.Environment
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import qanda.backend.platform.http.*
import org.springframework.http.HttpStatus
import java.time.Clock

@Service
class SyncCapacity(private val jdbc: JdbcTemplate,private val clock: Clock,private val environment: Environment,registry: MeterRegistry) {
    data class Backlog(val count: Long,val bytes: Long,val oldest: Double,val blockedCount: Long=0,val blockedBytes: Long=0,val blockedOldest: Double=0.0)
    private data class Snapshot(val backlog: Backlog,val at: Long,val blocked: Boolean)
    @Volatile private var snapshot=Snapshot(Backlog(0,0,0.0),0,true)
    private val countLimit=environment.getProperty("qanda.backend.sync-backlog-count",Long::class.java,4096L).also { require(it>0) }
    private val byteLimit=environment.getProperty("qanda.backend.sync-backlog-bytes",Long::class.java,67108864L).also { require(it>0) }
    private val rejects=registry.counter("qanda.sync.admission.rejections")
    init {
        registry.gauge("qanda.sync.backlog.count",this) { it.snapshot.backlog.count.toDouble() }
        registry.gauge("qanda.sync.backlog.bytes",this) { it.snapshot.backlog.bytes.toDouble() }
        registry.gauge("qanda.sync.backlog.oldest",this) { it.snapshot.backlog.oldest }
        registry.gauge("qanda.sync.blocked.count",this) { it.snapshot.backlog.blockedCount.toDouble() }
        registry.gauge("qanda.sync.blocked.bytes",this) { it.snapshot.backlog.blockedBytes.toDouble() }
        registry.gauge("qanda.sync.blocked.oldest",this) { it.snapshot.backlog.blockedOldest }
        registry.gauge("qanda.sync.backlog.blocked",this) { if(it.snapshot.blocked) 1.0 else 0.0 }
    }
    @Scheduled(fixedDelay=5000)
    fun refresh() {
        if(environment.getProperty("qanda.backend.role","api") in setOf("worker","monitor")) return
        try {
            val measured=jdbc.queryForObject("""WITH pending AS (
                SELECT c.payload_bytes,c.created_at,c.state IN ('REJECTED','DEAD_LETTER') OR EXISTS(
                    SELECT 1 FROM sync_command p WHERE p.session_id=c.session_id AND p.client_sequence<c.client_sequence
                    AND p.state IN ('REJECTED','DEAD_LETTER')) blocked
                FROM sync_command c WHERE c.state IN ('QUEUED','RETRYING','REJECTED','DEAD_LETTER')
            ) SELECT count(*) FILTER(WHERE NOT blocked) n,coalesce(sum(payload_bytes) FILTER(WHERE NOT blocked),0) bytes,
                coalesce(extract(epoch FROM now()-min(created_at) FILTER(WHERE NOT blocked)),0) oldest,
                count(*) FILTER(WHERE blocked) blocked_count,coalesce(sum(payload_bytes) FILTER(WHERE blocked),0) blocked_bytes,
                coalesce(extract(epoch FROM now()-min(created_at) FILTER(WHERE blocked)),0) blocked_oldest FROM pending""",{ r,_ ->
                Backlog(r.getLong("n"),r.getLong("bytes"),r.getDouble("oldest"),r.getLong("blocked_count"),r.getLong("blocked_bytes"),r.getDouble("blocked_oldest"))
            })!!
            val blocked=if(snapshot.blocked) measured.count>=maxOf(1,countLimit/2) || measured.bytes>=maxOf(1,byteLimit/2) else measured.count>=countLimit || measured.bytes>=byteLimit
            snapshot=Snapshot(measured,clock.millis(),blocked)
        } catch(_: Exception) { /* Keep the last sample; stale admission fails closed. */ }
    }
    fun requireRoom() {
        val current=snapshot
        if(current.blocked || clock.millis()-current.at>15000) {
            rejects.increment()
            throw ApiException(HttpStatus.SERVICE_UNAVAILABLE,"SYNC_BACKLOG_FULL","已保存在本机，可继续练习",details=ErrorDetails(retryAfterSeconds=30))
        }
    }
}
