package qanda.backend.sync.api

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import qanda.backend.platform.security.Actor
import java.time.Instant
import java.util.UUID

data class StoredFailure(val code: String,val message: String,val status: Int)
data class StoredCommand(val id: UUID,val sessionId: UUID,val actor: Actor,val digest: ByteArray,val digestVersion: Int,
    val requestId: UUID,val state: String,val attempts: Int,val createdAt: Instant,val updatedAt: Instant,val receipt: String?,val error: StoredFailure?)

@Repository
class ProgressCommandStore(private val jdbc: JdbcTemplate) {
    fun find(key: UUID): StoredCommand? = jdbc.query("SELECT c.*,r.response_json FROM sync_command c LEFT JOIN command_receipt r ON r.id=c.receipt_id WHERE c.id=?",{ r,_ ->
        StoredCommand(r.getObject("id",UUID::class.java),r.getObject("session_id",UUID::class.java),
            Actor(r.getObject("user_id",UUID::class.java),r.getObject("actor_session_id",UUID::class.java),"USER","MINI_PROGRAM"),
            r.getBytes("payload_digest"),r.getInt("digest_key_version"),r.getObject("request_id",UUID::class.java),r.getString("state"),r.getInt("attempts"),
            r.getTimestamp("created_at").toInstant(),r.getTimestamp("updated_at").toInstant(),r.getString("response_json"),
            r.getString("error_code")?.let { StoredFailure(it,r.getString("error_message"),r.getInt("error_status")) })
    },key).firstOrNull()

    fun lockIntent(key: UUID) { jdbc.queryForObject("SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(?,0))",Int::class.java,"sync:$key") }
    fun lock(key: UUID) = jdbc.queryForObject("SELECT id FROM sync_command WHERE id=? FOR UPDATE",UUID::class.java,key)
    fun insert(key: UUID,id: UUID,actor: Actor,writer: UUID,sequence: Long,digest: ByteArray,digestVersion: Int,requestId: UUID) {
        jdbc.update("INSERT INTO sync_command(id,session_id,user_id,actor_session_id,writer_token,client_sequence,payload_digest,digest_key_version,request_id,state) VALUES(?,?,?,?,?,?,?,?,?,'ACCEPTING')",
            key,id,actor.id,actor.sessionId,writer,sequence,digest,digestVersion,requestId)
    }
    fun queued(key: UUID) { jdbc.update("UPDATE sync_command SET state='QUEUED',updated_at=now() WHERE id=? AND state='ACCEPTING'",key) }
    fun committed(row: StoredCommand) {
        jdbc.update("UPDATE sync_command SET state='COMMITTED',completed_at=now(),updated_at=now(),error_code=NULL,error_message=NULL,error_status=NULL,receipt_id=(SELECT id FROM command_receipt WHERE scope=? AND operation=? AND command_id=?) WHERE id=? AND state<>'COMMITTED'",
            "USER:${row.actor.id}","SAVE_PROGRESS_ACK:${row.sessionId}",row.id,row.id)
    }
    fun failed(key: UUID,state: String,attempts: Int,code: String,message: String,status: Int) {
        jdbc.update("UPDATE sync_command SET state=?,attempts=?,updated_at=now(),completed_at=CASE WHEN ?='REJECTED' THEN now() ELSE NULL END,error_code=?,error_message=?,error_status=? WHERE id=? AND state NOT IN ('COMMITTED','REJECTED')",
            state,attempts,state,code,message,status,key)
    }
    fun replayed(key: UUID) { jdbc.update("UPDATE sync_command SET state='QUEUED',attempts=0,updated_at=now(),error_code=NULL,error_message=NULL,error_status=NULL WHERE id=?",key) }
}
