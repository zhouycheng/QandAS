package qanda.backend.practice

import org.springframework.stereotype.Service
import org.springframework.context.ApplicationEventPublisher
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.time.Clock
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import io.micrometer.core.instrument.MeterRegistry

data class WriterSignal(val sessionId: UUID,val type: String,val epoch: Long)

@Service
// shortcut: leases assume one API instance; share ownership before adding API replicas.
class WriterPresence(private val clock: Clock,private val events: ApplicationEventPublisher,private val meters: MeterRegistry) {
    companion object { const val LEASE_MILLIS=40000L }
    private data class Lease(val token: UUID,val until: Instant,val epoch: Long)
    private val leases=ConcurrentHashMap<UUID,Lease>()
    // A restarted process cannot know the last granted lease; wait out its maximum lifetime.
    private val restartUntil=clock.instant().plusMillis(LEASE_MILLIS)
    fun open(id: UUID,token: UUID,epoch: Long=1): Instant {
        val until=clock.instant().plusMillis(LEASE_MILLIS)
        leases[id]=Lease(token,until,epoch)
        return until
    }
    fun renew(id: UUID,token: UUID): Boolean {
        var renewed=false
        leases.computeIfPresent(id) { _,old -> if(old.token==token) { renewed=true;old.copy(until=clock.instant().plusMillis(LEASE_MILLIS)) } else old }
        return renewed
    }
    fun active(id: UUID,token: UUID?): Boolean {
        if(token==null) return false
        val lease=leases[id]
        return if(lease==null) clock.instant().isBefore(restartUntil) else lease.token==token && clock.instant().isBefore(lease.until)
    }
    fun signal(id: UUID,type: String,epoch: Long) {
        val publish={ if(type=="WRITER_CHANGED") leases.computeIfPresent(id) { _,lease -> lease.takeIf { it.epoch>=epoch } };meters.counter("qanda.practice.writer.signals","type",type).increment();events.publishEvent(WriterSignal(id,type,epoch)) }
        if(TransactionSynchronizationManager.isSynchronizationActive()) TransactionSynchronizationManager.registerSynchronization(object: TransactionSynchronization {
            override fun afterCommit() { publish() }
        }) else publish()
    }
    fun completed(expiresAt: Instant) { meters.timer("qanda.practice.writer.takeover").record(java.time.Duration.between(expiresAt.minusSeconds(60),clock.instant()).coerceAtLeast(java.time.Duration.ZERO)) }
    fun forget(id: UUID) { leases.remove(id) }
    fun sweep() { val now=clock.instant();leases.entries.removeIf { it.value.until.isBefore(now.minusSeconds(60)) } }
}
