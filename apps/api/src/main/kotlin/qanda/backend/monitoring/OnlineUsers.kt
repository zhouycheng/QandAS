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
data class OnlineUser(val userId: UUID,val nickname: String,val accountCode: String,val collegeName: String?,val majorName: String?,val currentGrade: Int?,
    val onlineSessionCount: Long,val lastHeartbeatAt: Instant,val clients: List<OnlineClient>)
data class OnlineUsersView(val items: List<OnlineUser>,val total: Long,val page: Int,val pageSize: Int,val sampledAt: Instant)

@Service
class OnlineUsers(private val jdbc: NamedParameterJdbcTemplate,private val clock: Clock) {
    @Transactional(readOnly=true,isolation=org.springframework.transaction.annotation.Isolation.REPEATABLE_READ,timeout=3)
    fun list(collegeId: UUID?,majorId: UUID?,grade: Int?,platform: String?,keyword: String?,page: PageSpec): OnlineUsersView {
        if(grade!=null && grade !in 1..5) invalid("/grade")
        if(platform!=null && platform !in setOf("WEB","MINI_PROGRAM")) invalid("/platform")
        if((keyword?.length ?: 0)>100) invalid("/keyword")
        val now=clock.instant()
        val parameters=mutableMapOf<String,Any?>("now" to Timestamp.from(now),"offset" to page.offset,"limit" to page.pageSize)
        val conditions=mutableListOf("true")
        listOf("collegeId" to collegeId,"majorId" to majorId,"grade" to grade,"platform" to platform).forEach { (key,value) ->
            if(value!=null) { parameters[key]=value;conditions+=when(key) { "collegeId" -> "u.college_id=:collegeId";"majorId" -> "u.major_id=:majorId";"grade" -> "u.current_grade=:grade";else -> "s.client_type=:platform" } }
        }
        if(!keyword.isNullOrBlank()) { parameters["keyword"]="%${keyword.trim()}%";conditions+="concat_ws(' ',u.nickname,u.account_code) ILIKE :keyword" }
        val from="FROM monitoring_online_at(CAST(:now AS timestamptz)) s JOIN monitoring_student u ON u.user_id=s.user_id WHERE "+conditions.joinToString(" AND ")
        val total=jdbc.queryForObject("SELECT count(DISTINCT s.user_id) $from",parameters,Long::class.java)!!
        val users=jdbc.query("SELECT u.user_id,u.nickname,u.account_code,u.college_name,u.major_name,u.current_grade,count(*) session_count,max(s.foreground_seen_at) last_seen $from GROUP BY u.user_id,u.nickname,u.account_code,u.college_name,u.major_name,u.current_grade ORDER BY last_seen DESC,u.user_id LIMIT :limit OFFSET :offset",parameters) { r,_ ->
            OnlineUser(r.getObject("user_id",UUID::class.java),r.getString("nickname"),r.getString("account_code"),r.getString("college_name"),r.getString("major_name"),r.getObject("current_grade") as? Int,r.getLong("session_count"),r.getTimestamp("last_seen").toInstant(),emptyList())
        }
        if(users.isEmpty()) return OnlineUsersView(users,total,page.page,page.pageSize,now)
        parameters["ids"]=users.map { it.userId }
        val clients=jdbc.query("SELECT s.user_id,s.client_type,count(*) session_count,max(s.foreground_seen_at) last_seen $from AND s.user_id IN(:ids) GROUP BY s.user_id,s.client_type",parameters) { r,_ ->
            r.getObject("user_id",UUID::class.java) to OnlineClient(r.getString("client_type"),r.getLong("session_count"),r.getTimestamp("last_seen").toInstant())
        }.groupBy({ it.first },{ it.second })
        return OnlineUsersView(users.map { it.copy(clients=clients[it.userId].orEmpty()) },total,page.page,page.pageSize,now)
    }
}

@RestController
@RequestMapping("/api/v1/admin/statistics",produces=["application/json"])
class OnlineUsersController(private val service: OnlineUsers,private val sessions: Sessions) {
    @GetMapping("/online-users")
    fun list(@RequestParam(required=false) collegeId: UUID?,@RequestParam(required=false) majorId: UUID?,@RequestParam(required=false) grade: Int?,
        @RequestParam(required=false) platform: String?,@RequestParam(required=false) keyword: String?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): OnlineUsersView {
        sessions.admin();return service.list(collegeId,majorId,grade,platform,keyword,PageSpec(page,pageSize))
    }
}
