package qanda.backend.monitoring

import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import java.time.Clock
import java.time.Instant
import java.sql.Timestamp
import java.util.UUID

data class OnlineClient(val platform: String,val sessionCount: Long,val lastHeartbeatAt: Instant)
data class OnlineUser(val userId: UUID,val nickname: String,val accountCode: String,
    val onlineSessionCount: Long,val lastHeartbeatAt: Instant,val clients: List<OnlineClient>)
data class OnlineUsersView(val items: List<OnlineUser>,val total: Long,val page: Int,val pageSize: Int,val sampledAt: Instant)

@Service
class OnlineUsers(private val jdbc: NamedParameterJdbcTemplate,private val clock: Clock) {
    @Transactional(readOnly=true,isolation=org.springframework.transaction.annotation.Isolation.REPEATABLE_READ,timeout=3)
    fun list(keyword: String?,page: PageSpec): OnlineUsersView {
        if((keyword?.length ?: 0)>100) invalid("/keyword")
        val now=clock.instant()
        val parameters=mutableMapOf<String,Any?>("now" to Timestamp.from(now),"offset" to page.offset,"limit" to page.pageSize)
        val conditions=mutableListOf("u.include_in_statistics")
        if(!keyword.isNullOrBlank()) { parameters["keyword"]="%${keyword.trim()}%";conditions+="concat_ws(' ',u.nickname,u.account_code) ILIKE :keyword" }
        val from="FROM monitoring_online_at(CAST(:now AS timestamptz)) s JOIN monitoring_student u ON u.user_id=s.user_id WHERE "+conditions.joinToString(" AND ")
        val total=jdbc.queryForObject("SELECT count(DISTINCT s.user_id) $from",parameters,Long::class.java)!!
        val users=jdbc.query("SELECT u.user_id,u.nickname,u.account_code,count(*) session_count,max(s.foreground_seen_at) last_seen $from GROUP BY u.user_id,u.nickname,u.account_code ORDER BY last_seen DESC,u.user_id LIMIT :limit OFFSET :offset",parameters) { r,_ ->
            OnlineUser(r.getObject("user_id",UUID::class.java),r.getString("nickname"),r.getString("account_code"),r.getLong("session_count"),r.getTimestamp("last_seen").toInstant(),emptyList())
        }
        return OnlineUsersView(users.map { it.copy(clients=listOf(OnlineClient("MINI_PROGRAM",it.onlineSessionCount,it.lastHeartbeatAt))) },total,page.page,page.pageSize,now)
    }
}

@RestController
@RequestMapping("/api/v1/admin/statistics",produces=["application/json"])
class OnlineUsersController(private val service: OnlineUsers,private val sessions: Sessions) {
    @GetMapping("/online-users")
    fun list(@RequestParam(required=false) keyword: String?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): OnlineUsersView {
        sessions.admin();return service.list(keyword,PageSpec(page,pageSize))
    }
}
