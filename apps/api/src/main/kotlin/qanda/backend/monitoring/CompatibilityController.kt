package qanda.backend.monitoring

import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.LoggerFactory
import org.springframework.core.env.Environment
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.web.bind.annotation.*
import org.springframework.web.servlet.HandlerInterceptor
import org.springframework.web.servlet.config.annotation.InterceptorRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.CompatibilityUsage
import java.sql.Timestamp
import java.time.Duration
import java.time.Instant

data class CompatibilityItem(val id: String,val name: String,val reason: String,val replacement: String,val introduced: String)
private val manifest = listOf("template","export","preview","imports").map {
    CompatibilityItem("excel-$it","题库 Excel /$it","已有工具仍可读写旧工作簿","题库 ZIP","5a33f457")
} + listOf("import-preview","imports").map {
    CompatibilityItem("json-$it","题库 JSON /$it","已有脚本按旧契约导入","题库 ZIP","8e94c475")
} + listOf(
    CompatibilityItem("plain-default","缺少格式字段的题目版本","按原来的纯文本展示","新修订显式保存正文格式","来源无法识别"),
    CompatibilityItem("inline-fallback","旧客户端图片显示","将内联图片映射为附件","支持内联图片的学生端","来源无法识别")
)

@Component
class CompatibilityRecorder(private val db: JdbcTemplate,private val json: ObjectMapper,private val env: Environment): HandlerInterceptor,WebMvcConfigurer {
    private val log = LoggerFactory.getLogger(javaClass)
    private val release = System.getenv("BACKEND_REVISION")?.takeIf { it.isNotBlank() } ?: "local"
    @Volatile private var previous: Instant? = null
    override fun addInterceptors(registry: InterceptorRegistry) { registry.addInterceptor(this).addPathPatterns("/api/v1/**") }

    @Scheduled(fixedDelay=30000)
    @Synchronized fun heartbeat() {
        if (env.getProperty("qanda.backend.role","api") !in setOf("api","all") || env.getProperty("qanda.backend.schema-command")=="true") return
        val now = Instant.now()
        val start = previous
        try {
            db.update("INSERT INTO compatibility_release(release,manifest) VALUES (?,?) ON CONFLICT (release) DO UPDATE SET manifest=excluded.manifest,first_seen=now() WHERE compatibility_release.manifest='[]'",release,json.writeValueAsString(manifest))
            if (start!=null && Duration.between(start,now).seconds in 0..75) {
                db.update("""INSERT INTO compatibility_coverage(release,day,observed)
                    VALUES (?,(now() AT TIME ZONE 'UTC')::date,tstzmultirange(tstzrange(?,?,'[)')))
                    ON CONFLICT(release,day) DO UPDATE SET observed=compatibility_coverage.observed + excluded.observed""",release,Timestamp.from(start),Timestamp.from(now))
            }
            previous=now
        } catch (e: org.springframework.dao.DataAccessException) { previous=null; log.warn("兼容调用采集心跳失败",e) }
    }

    override fun afterCompletion(request: HttpServletRequest,response: HttpServletResponse,handler: Any,ex: Exception?) {
        if (response.status == 401 || response.status == 403) return
        val items = CompatibilityUsage.items(request)
        if (items.isEmpty()) return
        try {
            for (item in items) db.update("""INSERT INTO compatibility_usage(release,day,item,hits,last_seen)
                VALUES (?,(now() AT TIME ZONE 'UTC')::date,?,1,now())
                ON CONFLICT(release,day,item) DO UPDATE SET hits=compatibility_usage.hits+1,last_seen=greatest(compatibility_usage.last_seen,excluded.last_seen)""",release,item)
        } catch (e: org.springframework.dao.DataAccessException) { previous=null; log.warn("兼容调用统计写入失败",e) }
    }
}

data class CompatibilityRelease(val release: String,val firstSeen: Instant)
data class CompatibilityGap(val start: Instant,val end: Instant)
data class CompatibilityStats(val item: String,val week: Long,val month: Long,val lastSeen: Instant)
data class CompatibilityReport(val releases: List<CompatibilityRelease>,val selected: String?,val items: List<CompatibilityItem>,
    val stats: List<CompatibilityStats>,val gaps: List<CompatibilityGap>,val checkedAt: Instant,val coverageThrough: Instant,val legacyRevisions: Long,val referencedRevisions: Long,val practiceRevisions: Long)

@RestController
@RequestMapping("/api/v1/admin/monitoring")
class CompatibilityController(private val db: JdbcTemplate,private val sessions: Sessions,private val json: ObjectMapper) {
    @GetMapping(value=["/compatibility"],produces=["application/json"])
    fun compatibility(@RequestParam(required=false) release: String?): CompatibilityReport {
        sessions.admin()
        val now=Instant.now()
        val releases=db.query("SELECT release,first_seen FROM compatibility_release ORDER BY first_seen DESC") { r,_ -> CompatibilityRelease(r.getString(1),r.getTimestamp(2).toInstant()) }
        val selected=release ?: releases.firstOrNull()?.release
        val items=selected?.let { id -> db.query("SELECT manifest FROM compatibility_release WHERE release=?", { r,_ ->
            json.readValue(r.getString(1), Array<CompatibilityItem>::class.java).toList()
        },id).firstOrNull() ?: qanda.backend.platform.http.missing() }.orEmpty()
        val stats=db.query("""SELECT item,coalesce(sum(hits) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date-6),0),
            coalesce(sum(hits) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date-29),0),max(last_seen)
            FROM compatibility_usage WHERE release=? GROUP BY item""",{r,_ -> CompatibilityStats(r.getString(1),r.getLong(2),r.getLong(3),r.getTimestamp(4).toInstant())},selected)
        // An open heartbeat interval has not been sealed yet. Only classify completed time.
        val lastHeartbeat=db.queryForObject("SELECT max(upper(observed)) FROM compatibility_coverage WHERE release=?",Timestamp::class.java,selected)?.toInstant()
        val coverageThrough=lastHeartbeat?.takeIf { !it.isBefore(now.minusSeconds(75)) } ?: now
        val gaps=db.query("""SELECT lower(g),upper(g) FROM unnest(tstzmultirange(tstzrange(
            ((now() AT TIME ZONE 'UTC')::date-29)::timestamp AT TIME ZONE 'UTC',?,'[)')) -
            coalesce((SELECT range_agg(observed) FROM compatibility_coverage WHERE release=? AND day >= (now() AT TIME ZONE 'UTC')::date-29),'{}'::tstzmultirange)) g""",
            {r,_ -> CompatibilityGap(r.getTimestamp(1).toInstant(),r.getTimestamp(2).toInstant())},Timestamp.from(coverageThrough),selected)
        val inventory=db.queryForMap("SELECT * FROM compatibility_inventory")
        return CompatibilityReport(releases,selected,items,stats,gaps,now,coverageThrough,inventory["legacy_revisions"] as Long,inventory["referenced_revisions"] as Long,inventory["practice_revisions"] as Long)
    }
}
