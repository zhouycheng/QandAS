package qanda.backend.sync.api

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import qanda.backend.platform.http.conflict
import java.util.UUID

data class WriteState(val deviceId: UUID?, val token: UUID?, val pendingDeviceId: UUID?, val acknowledgedSequence: Long)

@Service
class WriteOwnership(private val jdbc: JdbcTemplate) {
    fun create(id: UUID, state: WriteState) {
        jdbc.update("INSERT INTO practice_sync_state(session_id,writer_device_id,writer_token,pending_writer_device_id,acknowledged_sequence) VALUES(?,?,?,?,?)",
            id,state.deviceId,state.token,state.pendingDeviceId,state.acknowledgedSequence)
    }
    fun read(id: UUID): WriteState = jdbc.queryForObject("SELECT * FROM practice_sync_state WHERE session_id=?", { r,_ ->
        WriteState(r.getObject("writer_device_id",UUID::class.java),r.getObject("writer_token",UUID::class.java),r.getObject("pending_writer_device_id",UUID::class.java),r.getLong("acknowledged_sequence"))
    },id)!!
    fun save(id: UUID, state: WriteState) {
        jdbc.update("UPDATE practice_sync_state SET writer_device_id=?,writer_token=?,pending_writer_device_id=?,acknowledged_sequence=? WHERE session_id=?",
            state.deviceId,state.token,state.pendingDeviceId,state.acknowledgedSequence,id)
    }
    // Callers hold the practice row lock, including command admission and finalization.
    fun requireDrained(id: UUID) {
        if(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM sync_command WHERE session_id=? AND state IN ('ACCEPTING','QUEUED','RETRYING','DEAD_LETTER'))",Boolean::class.java,id)==true)
            conflict("SYNC_PENDING","答题进度正在保存，请等待完成后重试")
    }
}
