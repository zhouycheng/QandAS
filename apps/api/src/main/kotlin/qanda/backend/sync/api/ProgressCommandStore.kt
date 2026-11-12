package qanda.backend.sync.api

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import qanda.backend.platform.security.Actor
import qanda.backend.platform.http.*
import org.springframework.http.HttpStatus
import java.time.Instant
import java.util.UUID

data class StoredFailure(val code: String,val message: String,val status: Int)
data class StoredCommand(val id: UUID,val sessionId: UUID,val actor: Actor,val digest: ByteArray,val digestVersion: Int,
    val requestId: UUID,val state: String,val attempts: Int,val createdAt: Instant,val updatedAt: Instant,val receipt: String?,val error: StoredFailure?,val sequence: Long)

@Repository
class ProgressCommandStore(private val jdbc: JdbcTemplate) {
    private val rowMapper=org.springframework.jdbc.core.RowMapper<StoredCommand> { r,_ ->
        StoredCommand(r.getObject("id",UUID::class.java),r.getObject("session_id",UUID::class.java),
            Actor(r.getObject("user_id",UUID::class.java),r.getObject("actor_session_id",UUID::class.java),"USER","MINI_PROGRAM"),
            r.getBytes("payload_digest"),r.getInt("digest_key_version"),r.getObject("request_id",UUID::class.java),r.getString("state"),r.getInt("attempts"),
            r.getTimestamp("created_at").toInstant(),r.getTimestamp("updated_at").toInstant(),r.getString("response_json"),
            r.getString("error_code")?.let { StoredFailure(it,r.getString("error_message"),r.getInt("error_status")) },r.getLong("client_sequence"))
    }
    private val columns="id,session_id,user_id,actor_session_id,writer_token,client_sequence,payload_digest,digest_key_version,request_id,kind,state,attempts,created_at,updated_at,error_code,error_message,error_status"
    fun payload(key: UUID): String = jdbc.queryForObject("SELECT payload_json FROM sync_command WHERE id=?",String::class.java,key) ?: error("Pending sync command has no payload")
    fun find(key: UUID): StoredCommand? = jdbc.query("SELECT ${columns.split(',').joinToString(",") { "c.$it" }},r.response_json FROM sync_command c LEFT JOIN command_receipt r ON r.id=c.receipt_id WHERE c.id=?",rowMapper,key).firstOrNull()
    fun lockIntent(key: UUID) { jdbc.queryForObject("SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(?,0))",Int::class.java,"sync:$key") }
    fun lock(key: UUID) = jdbc.queryForObject("SELECT id FROM sync_command WHERE id=? FOR UPDATE",UUID::class.java,key)
    fun checkpoint(id: UUID): Triple<Long,Long,Boolean> = jdbc.queryForObject("SELECT accepted_sequence,acknowledged_sequence,finish_sequence IS NOT NULL finishing FROM practice_sync_state WHERE session_id=?",{ r,_ -> Triple(r.getLong(1),r.getLong(2),r.getBoolean(3)) },id)!!
    fun requireRoom(userId: UUID,id: UUID,payload: String,restoredKey: UUID?=null) {
        // Admission already holds the user row lock, so concurrent practices share the same budget.
        val bytes=payload.toByteArray(Charsets.UTF_8).size
        val full=jdbc.queryForObject("""SELECT count(*)>=256 OR coalesce(sum(payload_bytes),0)+?>67108864
            OR count(*) FILTER(WHERE session_id=?)>=64
            OR coalesce(sum(payload_bytes) FILTER(WHERE session_id=?),0)+?>16777216
            FROM sync_command WHERE user_id=? AND id IS DISTINCT FROM ? AND state IN ('QUEUED','RETRYING','DEAD_LETTER','REJECTED')""",
            Boolean::class.java,bytes,id,id,bytes,userId,restoredKey)==true
        if(full) throw ApiException(HttpStatus.SERVICE_UNAVAILABLE,"SYNC_BACKLOG_FULL","同步任务暂时积压，请保留本机答案并稍后重试",details=ErrorDetails(retryAfterSeconds=5))
    }
    fun requireUnblocked(id: UUID) {
        if(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM sync_command WHERE session_id=? AND state IN ('REJECTED','DEAD_LETTER'))",Boolean::class.java,id)==true)
            conflict("SYNC_BLOCKED","请先恢复此前未完成的同步命令，本机答案已保留")
    }
    fun reauthorize(key: UUID,actor: Actor) {
        jdbc.update("UPDATE sync_command SET actor_session_id=?,state='QUEUED',completed_at=NULL,next_attempt_at=now(),dispatch_until=NULL,error_code=NULL,error_message=NULL,error_status=NULL,updated_at=now() WHERE id=? AND state='REJECTED'",
            actor.sessionId,key)
    }
    fun insert(key: UUID,id: UUID,actor: Actor,writer: UUID,sequence: Long,digest: ByteArray,digestVersion: Int,requestId: UUID,kind: String,payload: String): StoredCommand {
        val inserted=jdbc.queryForObject("INSERT INTO sync_command(id,session_id,user_id,actor_session_id,writer_token,client_sequence,payload_digest,digest_key_version,request_id,kind,payload_json,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'QUEUED') RETURNING $columns,NULL::text AS response_json",rowMapper,
            key,id,actor.id,actor.sessionId,writer,sequence,digest,digestVersion,requestId,kind,payload)
        jdbc.update("UPDATE practice_sync_state SET accepted_sequence=?,finish_sequence=CASE WHEN ?='FINISH' THEN ? ELSE finish_sequence END WHERE session_id=?",sequence,kind,sequence,id)
        return inserted!!
    }
    fun claim(): List<UUID> = jdbc.query("""WITH due AS (
        SELECT c.id FROM sync_command c WHERE c.state IN ('QUEUED','RETRYING') AND c.next_attempt_at<=now()
        AND (c.dispatch_until IS NULL OR c.dispatch_until<now())
        AND NOT EXISTS(SELECT 1 FROM sync_command p WHERE p.session_id=c.session_id AND p.client_sequence<c.client_sequence AND p.state<>'COMMITTED')
        ORDER BY CASE WHEN c.created_at<now()-interval '60 seconds' THEN 0 WHEN c.kind='FINISH' THEN 1 ELSE 2 END,c.next_attempt_at,c.created_at LIMIT 128 FOR UPDATE OF c SKIP LOCKED)
        UPDATE sync_command SET dispatch_until=now()+interval '30 seconds',next_attempt_at=now()+interval '30 seconds' WHERE id IN(SELECT id FROM due) RETURNING id""",{ r,_ -> r.getObject(1,UUID::class.java) })
    fun committed(row: StoredCommand) {
        jdbc.update("UPDATE sync_command SET state='COMMITTED',completed_at=now(),updated_at=now(),error_code=NULL,error_message=NULL,error_status=NULL,dispatch_until=NULL,receipt_id=(SELECT id FROM command_receipt WHERE scope=? AND operation=? AND command_id=?) WHERE id=?",
            "USER:${row.actor.id}","SYNC:${row.sessionId}",row.id,row.id)
    }
    fun failed(key: UUID,state: String,code: String,message: String,status: Int,delayMs: Long) {
        jdbc.update("UPDATE sync_command SET state=?,attempts=least(attempts+1,2147483647),updated_at=now(),completed_at=CASE WHEN ?='REJECTED' THEN now() ELSE NULL END,error_code=?,error_message=?,error_status=?,dispatch_until=NULL,next_attempt_at=now()+(? * interval '1 millisecond') WHERE id=? AND state NOT IN ('COMMITTED','REJECTED')",
            state,state,code,message,status,delayMs,key)
    }
    fun replayed(key: UUID) { jdbc.update("UPDATE sync_command SET state='QUEUED',next_attempt_at=now(),dispatch_until=NULL,updated_at=now(),error_code=NULL,error_message=NULL,error_status=NULL WHERE id=? AND state='DEAD_LETTER'",key) }
}
