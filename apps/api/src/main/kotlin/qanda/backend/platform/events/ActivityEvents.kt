package qanda.backend.platform.events

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import java.time.Clock
import java.sql.Timestamp
import java.util.UUID

@Service
class ActivityEvents(private val jdbc: JdbcTemplate,private val clock: Clock) {
    fun record(userId: UUID) {
        jdbc.update("INSERT INTO domain_event_outbox(id,user_id,occurred_at) VALUES(?,?,?)",UUID.randomUUID(),userId,Timestamp.from(clock.instant()))
    }
}
