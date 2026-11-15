package qanda.backend.sync.api

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import qanda.backend.platform.http.conflict
import java.util.UUID
import java.time.Instant

data class WriteState(val deviceId: UUID?, val token: UUID?, val acknowledgedSequence: Long)
data class WriterTransfer(val epoch: Long,val sealed: Boolean,val requestId: UUID?,val deviceId: UUID?,val expiresAt: Instant?,val state: String?)

@Service
class WriteOwnership(private val jdbc: JdbcTemplate) {
    fun transfer(id: UUID): WriterTransfer = jdbc.queryForObject("SELECT writer_epoch,writer_sealed,takeover_id,takeover_device_id,takeover_expires_at,takeover_state FROM practice_sync_state WHERE session_id=?",{ r,_ ->
        WriterTransfer(r.getLong(1),r.getBoolean(2),r.getObject(3,UUID::class.java),r.getObject(4,UUID::class.java),r.getTimestamp(5)?.toInstant(),r.getString(6))
    },id)!!
    fun request(id: UUID,key: UUID,deviceId: UUID,expiresAt: Instant) {
        jdbc.update("UPDATE practice_sync_state SET takeover_id=?,takeover_device_id=?,takeover_expires_at=?,takeover_state='WAITING' WHERE session_id=?",key,deviceId,java.sql.Timestamp.from(expiresAt),id)
    }
    fun seal(id: UUID) { jdbc.update("UPDATE practice_sync_state SET writer_sealed=true WHERE session_id=?",id) }
    fun expire(id: UUID) { jdbc.update("UPDATE practice_sync_state SET takeover_state='EXPIRED',writer_sealed=false WHERE session_id=?",id) }
    fun finishing(id: UUID): Boolean = jdbc.queryForObject("SELECT finish_sequence IS NOT NULL FROM practice_sync_state WHERE session_id=?",Boolean::class.java,id)==true
    fun rotate(id: UUID,claimed: Boolean) {
        if(claimed) jdbc.update("UPDATE practice_sync_state SET writer_epoch=writer_epoch+1,writer_sealed=false,takeover_state='READY' WHERE session_id=?",id)
        else jdbc.update("UPDATE practice_sync_state SET writer_epoch=writer_epoch+1,writer_sealed=false,takeover_id=NULL,takeover_device_id=NULL,takeover_expires_at=NULL,takeover_state=NULL WHERE session_id=?",id)
    }
    fun create(id: UUID, state: WriteState) {
        jdbc.update("INSERT INTO practice_sync_state(session_id,writer_device_id,writer_token,acknowledged_sequence) VALUES(?,?,?,?)",
            id,state.deviceId,state.token,state.acknowledgedSequence)
    }
    fun read(id: UUID): WriteState = jdbc.queryForObject("SELECT * FROM practice_sync_state WHERE session_id=?", { r,_ ->
        WriteState(r.getObject("writer_device_id",UUID::class.java),r.getObject("writer_token",UUID::class.java),r.getLong("acknowledged_sequence"))
    },id)!!
    fun save(id: UUID, state: WriteState) {
        jdbc.update("UPDATE practice_sync_state SET writer_device_id=?,writer_token=?,acknowledged_sequence=? WHERE session_id=?",
            state.deviceId,state.token,state.acknowledgedSequence,id)
    }
    // Callers hold the practice row lock, including command admission and finalization.
    fun requireDrained(id: UUID,before: Long=Long.MAX_VALUE) {
        if(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM sync_command WHERE session_id=? AND state IN ('QUEUED','RETRYING','DEAD_LETTER') AND client_sequence<?)",Boolean::class.java,id,before)==true)
            conflict("SYNC_PENDING","答题进度正在保存，请等待完成后重试")
    }
    fun transferReady(id: UUID): Boolean = jdbc.queryForObject("SELECT accepted_sequence=acknowledged_sequence AND finish_sequence IS NULL AND NOT EXISTS(SELECT 1 FROM sync_command WHERE session_id=? AND state='REJECTED') FROM practice_sync_state WHERE session_id=?",Boolean::class.java,id,id)==true
}
