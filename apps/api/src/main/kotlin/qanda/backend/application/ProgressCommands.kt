package qanda.backend.application

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.JdbcTemplate
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
import java.sql.ResultSet
import java.time.Instant
import java.util.UUID
import org.springframework.http.HttpStatus

data class ProgressEnvelope(val commandId: UUID,val input: ProgressInput)
private data class StoredCommand(val id: UUID,val sessionId: UUID,val actor: Actor,val digest: ByteArray,val digestVersion: Int,
    val requestId: UUID,val state: String,val attempts: Int,val createdAt: Instant,val updatedAt: Instant,val receipt: String?,val error: CommandFailure?)

@Service
class ProgressCommands(private val jdbc: JdbcTemplate,private val json: ObjectMapper,private val digests: CommandDigests,
    private val sessions: Sessions,private val practice: PracticeService,private val commands: Commands,private val queue: ProgressQueue,manager: PlatformTransactionManager) {
    private val tx=TransactionTemplate(manager)
    private fun row(r: ResultSet)=StoredCommand(r.getObject("id",UUID::class.java),r.getObject("session_id",UUID::class.java),
        Actor(r.getObject("user_id",UUID::class.java),r.getObject("actor_session_id",UUID::class.java),"USER",r.getString("client_type")),
        r.getBytes("payload_digest"),r.getInt("digest_key_version"),r.getObject("request_id",UUID::class.java),r.getString("state"),r.getInt("attempts"),
        r.getTimestamp("created_at").toInstant(),r.getTimestamp("updated_at").toInstant(),r.getString("response_json"),
        r.getString("error_code")?.let { CommandFailure(it,r.getString("error_message"),r.getInt("error_status")) })
    private fun find(key: UUID): StoredCommand? = jdbc.query("SELECT c.*,r.response_json FROM sync_command c LEFT JOIN command_receipt r ON r.id=c.receipt_id WHERE c.id=?",{ r,_ -> row(r) },key).firstOrNull()
    private fun view(row: StoredCommand)=ProgressCommandView(row.id,row.sessionId,row.state,row.createdAt,row.updatedAt,
        row.receipt?.let { json.readValue(it,ProgressAck::class.java) },row.error)
    private fun digest(id: UUID,input: ProgressInput,version: Int=digests.activeVersion)=digests.digest("POST","/api/v1/practice/sessions/$id/progress-commands","application/json",json.writeValueAsBytes(input),version)
    fun read(actor: Actor,id: UUID,key: UUID): ProgressCommandView {
        val row=find(key) ?: missing()
        if(row.actor.id!=actor.id || row.sessionId!=id) missing()
        return view(row)
    }
    fun awaitLegacy(actor: Actor,id: UUID,key: UUID,input: ProgressInput,requestId: UUID): ProgressAck {
        var result=submit(actor,id,key,input,requestId)
        val deadline=System.nanoTime()+10_000_000_000L
        while(true) {
            result.acknowledgement?.let { return it }
            if(result.state=="REJECTED") {
                val error=result.failure!!
                throw ApiException(HttpStatus.valueOf(error.status),error.code,error.message)
            }
            if(System.nanoTime()>=deadline || result.state=="DEAD_LETTER") throw ApiException(HttpStatus.SERVICE_UNAVAILABLE,"SYNC_PENDING","进度已受理，正在等待保存，请使用原请求标识重试",details=ErrorDetails(retryAfterSeconds=1))
            Thread.sleep(100)
            result=read(actor,id,key)
        }
    }
    fun submit(actor: Actor,id: UUID,key: UUID,input: ProgressInput,requestId: UUID): ProgressCommandView {
        val registered=tx.execute {
            sessions.checkInTransaction(actor)
            jdbc.queryForObject("SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(?,0))",Int::class.java,"sync:$key")
            val old=find(key)
            if(old!=null) {
                if(old.actor.id!=actor.id || old.sessionId!=id || !digests.matches(digest(id,input,old.digestVersion),old.digest)) conflict("IDEMPOTENCY_CONFLICT","同一请求标识的内容不同")
                old
            } else {
                practice.admitProgress(actor,id,input)
                jdbc.update("INSERT INTO sync_command(id,session_id,user_id,actor_session_id,client_type,writer_token,client_sequence,payload_digest,digest_key_version,request_id,state) VALUES(?,?,?,?,?,?,?,?,?,?,'ACCEPTING')",
                    key,id,actor.id,actor.sessionId,actor.clientType,input.writerToken,input.clientSequence,digest(id,input),digests.activeVersion,requestId)
                find(key)!!
            }
        }!!
        if(registered.state=="ACCEPTING") {
            queue.publish(json.writeValueAsBytes(ProgressEnvelope(key,input)),key)
            jdbc.update("UPDATE sync_command SET state='QUEUED',updated_at=now() WHERE id=? AND state='ACCEPTING'",key)
        }
        return read(actor,id,key)
    }
    fun consume(envelope: ProgressEnvelope) {
        tx.executeWithoutResult {
            val row=find(envelope.commandId) ?: missing()
            if(!digests.matches(digest(row.sessionId,envelope.input,row.digestVersion),row.digest)) conflict("IDEMPOTENCY_CONFLICT","消息摘要校验失败")
            if(row.state in setOf("COMMITTED","REJECTED")) return@executeWithoutResult
            sessions.checkInTransaction(row.actor)
            jdbc.queryForObject("SELECT id FROM sync_command WHERE id=? FOR UPDATE",UUID::class.java,row.id)
            if(find(row.id)!!.state in setOf("COMMITTED","REJECTED")) return@executeWithoutResult
            commands.run(row.actor,row.id,"SAVE_PROGRESS_ACK:${row.sessionId}",envelope.input,ProgressAck::class.java,row.requestId) {
                practice.progressAck(row.actor,row.sessionId,envelope.input)
            }
            jdbc.update("UPDATE sync_command SET state='COMMITTED',completed_at=now(),updated_at=now(),error_code=NULL,error_message=NULL,error_status=NULL,receipt_id=(SELECT id FROM command_receipt WHERE scope=? AND operation=? AND command_id=?) WHERE id=? AND state<>'COMMITTED'",
                "USER:${row.actor.id}","SAVE_PROGRESS_ACK:${row.sessionId}",row.id,row.id)
        }
    }
    fun failure(key: UUID,error: Exception): Pair<String,Long> {
        val business=error as? ApiException
        val terminal=business!=null && business.status.is4xxClientError && business.status.value() !in setOf(408,429)
        return tx.execute {
            jdbc.queryForObject("SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(?,0))",Int::class.java,"sync:$key")
            val row=find(key) ?: return@execute "dead" to 0L
            if(row.state in setOf("COMMITTED","REJECTED")) return@execute "done" to 0L
            val attempts=row.attempts+1
            val state=if(terminal) "REJECTED" else if(attempts>=8) "DEAD_LETTER" else "RETRYING"
            jdbc.update("UPDATE sync_command SET state=?,attempts=?,updated_at=now(),completed_at=CASE WHEN ?='REJECTED' THEN now() ELSE NULL END,error_code=?,error_message=?,error_status=? WHERE id=? AND state NOT IN ('COMMITTED','REJECTED')",
                state,attempts,state,business?.code ?: "SYNC_PROCESSING_FAILED",business?.message ?: "进度处理暂不可用",business?.status?.value() ?: 503,key)
            when(state) { "REJECTED" -> "done" to 0L;"DEAD_LETTER" -> "dead" to 0L;else -> "retry" to minOf(60000L,1000L shl minOf(attempts-1,6)) }
        }!!
    }
    fun deadLetter(): DeadLetterView? = queue.inspectDeadLetter { bytes ->
        val envelope=runCatching { json.readValue(bytes,ProgressEnvelope::class.java) }.getOrNull()
        val row=envelope?.let { find(it.commandId) }
        DeadLetterView(envelope?.commandId,row?.sessionId,row?.error,when {
            row==null -> "消息格式或归属异常，需人工检查队列"
            row.state in setOf("COMMITTED","REJECTED") -> "命令已有最终回执，处理时清理这条重复消息"
            else -> null
        })
    }
    fun replay(key: UUID): MutationResult = tx.execute {
        jdbc.queryForObject("SELECT id FROM sync_command WHERE id=? FOR UPDATE",UUID::class.java,key) ?: missing()
        val row=find(key) ?: missing()
        val terminal=row.state in setOf("COMMITTED","REJECTED")
        queue.replayHead(key,!terminal) { bytes ->
            val envelope=json.readValue(bytes,ProgressEnvelope::class.java)
            if(envelope.commandId!=key) conflict("DEAD_LETTER_CHANGED","死信队首已变更，请重新查看")
            if(!digests.matches(digest(row.sessionId,envelope.input,row.digestVersion),row.digest)) conflict("IDEMPOTENCY_CONFLICT","消息摘要校验失败")
        }
        if(!terminal) jdbc.update("UPDATE sync_command SET state='QUEUED',attempts=0,updated_at=now(),error_code=NULL,error_message=NULL,error_status=NULL WHERE id=?",key)
        MutationResult(key,1)
    }!!
}

data class DeadLetterView(val commandId: UUID?,val sessionId: UUID?,val failure: CommandFailure?,val reason: String?)
