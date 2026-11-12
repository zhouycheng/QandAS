package qanda.backend.application

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import qanda.backend.identity.Sessions
import qanda.backend.practice.PracticeService
import qanda.backend.practice.ProgressInput
import qanda.backend.platform.http.*
import qanda.backend.platform.security.*
import qanda.backend.sync.api.*
import java.util.UUID
import java.util.concurrent.ThreadLocalRandom

data class ProgressEnvelope(val commandId: UUID)
@Service
class ProgressCommands(private val store: ProgressCommandStore,private val json: ObjectMapper,private val digests: CommandDigests,
    private val sessions: Sessions,private val practice: PracticeService,private val commands: Commands,private val queue: ProgressQueue,private val capacity: SyncCapacity,manager: PlatformTransactionManager,private val meters: io.micrometer.core.instrument.MeterRegistry) {
    private val tx=TransactionTemplate(manager)
    private fun view(row: StoredCommand): ProgressCommandView {
        val receipt=row.receipt?.let { json.readValue(it,SyncReceipt::class.java) }
        return ProgressCommandView(row.id,row.sessionId,row.state,row.createdAt,row.updatedAt,receipt?.acknowledgement,row.error?.let { CommandFailure(it.code,it.message,it.status) },receipt?.result?.id)
    }
    private fun digest(id: UUID,input: ProgressInput,version: Int=digests.activeVersion)=digests.digest("POST","/api/v1/practice/sessions/$id/sync-commands","application/json",json.writeValueAsBytes(input),version)
    fun checkpoint(actor: Actor,id: UUID): SyncCheckpoint {
        // Ownership check stays live even when a task has completed.
        practice.version(actor.id,id)
        val (accepted,processed,finishing)=store.checkpoint(id)
        return SyncCheckpoint(accepted,processed,finishing)
    }
    fun read(actor: Actor,id: UUID,key: UUID): ProgressCommandView {
        val row=store.find(key) ?: missing()
        if(row.actor.id!=actor.id || row.sessionId!=id) missing()
        return view(row)
    }
    fun submit(actor: Actor,id: UUID,key: UUID,input: ProgressInput,requestId: UUID): ProgressCommandView = tx.execute {
        sessions.checkInTransaction(actor);store.lockIntent(key)
        val old=store.find(key)
        if(old!=null) {
            if(old.actor.id!=actor.id || old.sessionId!=id || !digests.matches(digest(id,input,old.digestVersion),old.digest)) conflict("IDEMPOTENCY_CONFLICT","同一请求标识的内容不同")
            if(old.state=="REJECTED" && old.error?.status in setOf(401,403) && old.actor.sessionId!=actor.sessionId) {
                practice.admitProgress(actor,id,input)
                capacity.requireRoom()
                store.requireRoom(actor.id,id,store.payload(key),key)
                store.reauthorize(key,actor)
                view(store.find(key)!!)
            } else view(old)
        } else {
            capacity.requireRoom()
            val version=practice.admitProgress(actor,id,input)
            val (accepted,processed,finishing)=store.checkpoint(id)
            if(finishing) conflict("SESSION_CLOSED","练习已完成")
            if(input.clientSequence!=accepted+1) conflict("SYNC_SEQUENCE","请先同步前面的答题记录")
            if(accepted==processed) {
                requireVersion(input.expectedVersion,version)
            }
            val payload=json.writeValueAsString(input)
            store.requireUnblocked(id);store.requireRoom(actor.id,id,payload)
            val inserted=store.insert(key,id,actor,input.writerToken,input.clientSequence,digest(id,input),digests.activeVersion,requestId,input.kind,payload)
            meters.counter("qanda.sync.commands","stage","received").increment()
            view(inserted)
        }
    }!!
    fun dispatch() {
        val ids=tx.execute { store.claim() }.orEmpty()
        for(id in ids) {
            try { queue.publish(json.writeValueAsBytes(ProgressEnvelope(id)),id);meters.counter("qanda.sync.commands","stage","dispatched").increment() }
            catch(_: Exception) { failure(id,java.io.IOException("broker unavailable"));break }
        }
    }
    fun consume(envelope: ProgressEnvelope) {
        tx.executeWithoutResult {
            val first=store.find(envelope.commandId) ?: return@executeWithoutResult
            if(first.state in setOf("COMMITTED","REJECTED","DEAD_LETTER")) {
                meters.counter("qanda.sync.commands","stage","duplicate").increment()
                return@executeWithoutResult
            }
            sessions.checkAccepted(first.actor)
            // Keep the user/session -> practice -> command lock order shared with admission and deletion.
            practice.lockSync(first.actor.id,first.sessionId)
            store.lock(first.id)
            val row=store.find(first.id) ?: return@executeWithoutResult
            if(row.state !in setOf("QUEUED","RETRYING")) return@executeWithoutResult
            if(store.checkpoint(row.sessionId).second+1!=row.sequence) return@executeWithoutResult
            val input=json.readValue(store.payload(row.id),ProgressInput::class.java)
            if(!digests.matches(digest(row.sessionId,input,row.digestVersion),row.digest)) conflict("IDEMPOTENCY_CONFLICT","任务内容校验失败")
            commands.runAccepted(row.actor,row.id,"SYNC:${row.sessionId}",input,SyncReceipt::class.java,row.requestId) {
                val (ack,result)=practice.processSync(row.actor,row.sessionId,input)
                SyncReceipt(ack,result)
            }
            store.committed(row)
            meters.counter("qanda.sync.commands","stage","committed").increment()
        }
    }
    fun failure(key: UUID,error: Exception): Pair<String,Long> = tx.execute {
        store.lockIntent(key)
        val row=store.find(key) ?: return@execute "done" to 0L
        if(row.state in setOf("COMMITTED","REJECTED","DEAD_LETTER")) return@execute "done" to 0L
        val business=error as? ApiException
        val terminal=business!=null && business.status.is4xxClientError && business.status.value() !in setOf(408,429)
        val state=if(terminal) "REJECTED" else "RETRYING"
        val delay=(minOf(60000L,1000L shl row.attempts.coerceIn(0,6)) * ThreadLocalRandom.current().nextDouble(0.5,1.0)).toLong()
        meters.counter("qanda.sync.commands","stage",state.lowercase()).increment()
        store.failed(key,state,business?.code ?: "SYNC_PROCESSING_FAILED",business?.message ?: "任务已保留，等待恢复处理",business?.status?.value() ?: 503,delay)
        (if(state=="RETRYING") "retry" else "done") to delay
    }!!
    fun deadLetter(): DeadLetterView? = queue.inspectDeadLetter { bytes ->
        val envelope=runCatching { json.readValue(bytes,ProgressEnvelope::class.java) }.getOrNull()
        val row=envelope?.let { store.find(it.commandId) }
        DeadLetterView(envelope?.commandId,row?.sessionId,row?.error?.let { CommandFailure(it.code,it.message,it.status) },if(row?.state in setOf("COMMITTED","REJECTED")) "命令已有最终回执" else null)
    }
    fun replay(key: UUID): MutationResult = tx.execute {
        val first=store.find(key) ?: missing()
        sessions.checkAccepted(first.actor)
        practice.lockSync(first.actor.id,first.sessionId)
        store.lock(key) ?: missing()
        val row=store.find(key) ?: missing()
        if(row.state=="DEAD_LETTER") {
            capacity.requireRoom()
            store.requireRoom(row.actor.id,row.sessionId,store.payload(key),key)
        }
        store.replayed(key)
        queue.replayHead(key,false) { bytes -> if(json.readValue(bytes,ProgressEnvelope::class.java).commandId!=key) conflict("DEAD_LETTER_CHANGED","死信队首已变更") }
        MutationResult(key,1)
    }!!
}
data class DeadLetterView(val commandId: UUID?,val sessionId: UUID?,val failure: CommandFailure?,val reason: String?)
