package qanda.backend.application

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import qanda.backend.identity.Sessions
import qanda.backend.practice.PracticeService
import qanda.backend.practice.ProgressInput
import qanda.backend.practice.ProgressAck
import qanda.backend.platform.http.*
import qanda.backend.platform.security.*
import qanda.backend.sync.api.*
import java.util.UUID

data class ProgressEnvelope(val commandId: UUID,val input: ProgressInput)
@Service
class ProgressCommands(private val store: ProgressCommandStore,private val json: ObjectMapper,private val digests: CommandDigests,
    private val sessions: Sessions,private val practice: PracticeService,private val commands: Commands,private val queue: ProgressQueue,manager: PlatformTransactionManager) {
    private val tx=TransactionTemplate(manager)
    private fun find(key: UUID) = store.find(key)
    private fun view(row: StoredCommand)=ProgressCommandView(row.id,row.sessionId,row.state,row.createdAt,row.updatedAt,
        row.receipt?.let { json.readValue(it,ProgressAck::class.java) },row.error?.let { CommandFailure(it.code,it.message,it.status) })
    private fun digest(id: UUID,input: ProgressInput,version: Int=digests.activeVersion)=digests.digest("POST","/api/v1/practice/sessions/$id/progress-commands","application/json",json.writeValueAsBytes(input),version)
    fun read(actor: Actor,id: UUID,key: UUID): ProgressCommandView {
        val row=find(key) ?: missing()
        if(row.actor.id!=actor.id || row.sessionId!=id) missing()
        return view(row)
    }
    fun submit(actor: Actor,id: UUID,key: UUID,input: ProgressInput,requestId: UUID): ProgressCommandView {
        val registered=tx.execute {
            sessions.checkInTransaction(actor)
            store.lockIntent(key)
            val old=find(key)
            if(old!=null) {
                if(old.actor.id!=actor.id || old.sessionId!=id || !digests.matches(digest(id,input,old.digestVersion),old.digest)) conflict("IDEMPOTENCY_CONFLICT","同一请求标识的内容不同")
                old
            } else {
                practice.admitProgress(actor,id,input)
                store.insert(key,id,actor,input.writerToken,input.clientSequence,digest(id,input),digests.activeVersion,requestId)
                find(key)!!
            }
        }!!
        if(registered.state=="ACCEPTING") {
            queue.publish(json.writeValueAsBytes(ProgressEnvelope(key,input)),key)
            store.queued(key)
        }
        return read(actor,id,key)
    }
    fun consume(envelope: ProgressEnvelope) {
        tx.executeWithoutResult {
            val row=find(envelope.commandId) ?: missing()
            if(!digests.matches(digest(row.sessionId,envelope.input,row.digestVersion),row.digest)) conflict("IDEMPOTENCY_CONFLICT","消息摘要校验失败")
            if(row.state in setOf("COMMITTED","REJECTED")) return@executeWithoutResult
            sessions.checkInTransaction(row.actor)
            store.lock(row.id)
            if(find(row.id)!!.state in setOf("COMMITTED","REJECTED")) return@executeWithoutResult
            commands.run(row.actor,row.id,"SAVE_PROGRESS_ACK:${row.sessionId}",envelope.input,ProgressAck::class.java,row.requestId) {
                practice.progressAck(row.actor,row.sessionId,envelope.input)
            }
            store.committed(row)
        }
    }
    fun failure(key: UUID,error: Exception): Pair<String,Long> {
        val business=error as? ApiException
        val terminal=business!=null && business.status.is4xxClientError && business.status.value() !in setOf(408,429)
        return tx.execute {
            store.lockIntent(key)
            val row=find(key) ?: return@execute "dead" to 0L
            if(row.state in setOf("COMMITTED","REJECTED")) return@execute "done" to 0L
            val attempts=row.attempts+1
            val state=if(terminal) "REJECTED" else if(attempts>=8) "DEAD_LETTER" else "RETRYING"
            store.failed(key,state,attempts,business?.code ?: "SYNC_PROCESSING_FAILED",business?.message ?: "进度处理暂不可用",business?.status?.value() ?: 503)
            when(state) { "REJECTED" -> "done" to 0L;"DEAD_LETTER" -> "dead" to 0L;else -> "retry" to minOf(60000L,1000L shl minOf(attempts-1,6)) }
        }!!
    }
    fun deadLetter(): DeadLetterView? = queue.inspectDeadLetter { bytes ->
        val envelope=runCatching { json.readValue(bytes,ProgressEnvelope::class.java) }.getOrNull()
        val row=envelope?.let { find(it.commandId) }
        DeadLetterView(envelope?.commandId,row?.sessionId,row?.error?.let { CommandFailure(it.code,it.message,it.status) },when {
            row==null -> "消息格式或归属异常，需人工检查队列"
            row.state in setOf("COMMITTED","REJECTED") -> "命令已有最终回执，处理时清理这条重复消息"
            else -> null
        })
    }
    fun replay(key: UUID): MutationResult = tx.execute {
        store.lock(key) ?: missing()
        val row=find(key) ?: missing()
        val terminal=row.state in setOf("COMMITTED","REJECTED")
        queue.replayHead(key,!terminal) { bytes ->
            val envelope=json.readValue(bytes,ProgressEnvelope::class.java)
            if(envelope.commandId!=key) conflict("DEAD_LETTER_CHANGED","死信队首已变更，请重新查看")
            if(!digests.matches(digest(row.sessionId,envelope.input,row.digestVersion),row.digest)) conflict("IDEMPOTENCY_CONFLICT","消息摘要校验失败")
        }
        if(!terminal) store.replayed(key)
        MutationResult(key,1)
    }!!
}

data class DeadLetterView(val commandId: UUID?,val sessionId: UUID?,val failure: CommandFailure?,val reason: String?)
