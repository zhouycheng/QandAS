package qanda.backend.monitoring

import org.springframework.format.annotation.DateTimeFormat
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import qanda.backend.platform.queries.StatsPeriods
import java.time.LocalDate
import java.util.UUID

@RestController
@RequestMapping("/api/v1",produces=["application/json"])
class ActivityController(private val service: ActivityService,private val periods: StatsPeriods,private val sessions: Sessions) {
    @GetMapping("/admin/statistics/activity") fun activity(@RequestParam(defaultValue="WEEK") period: String,@RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) periodDate: LocalDate?,@RequestParam(required=false) collegeId: UUID?,@RequestParam(required=false) majorId: UUID?,@RequestParam(required=false) grade: Int?): ActivityView { sessions.admin();return service.activity(periods.filter(period,periodDate,collegeId=collegeId,majorId=majorId,grade=grade)) }
    @GetMapping("/admin/statistics/rankings") fun rankings(@RequestParam(defaultValue="WEEK") period: String,@RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) periodDate: LocalDate?,@RequestParam(required=false) collegeId: UUID?,@RequestParam(required=false) majorId: UUID?,@RequestParam(required=false) grade: Int?,@RequestParam(defaultValue="ACTIVE_DAYS") sort: String,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<RankingView> { sessions.admin();return service.rankings(periods.filter(period,periodDate,collegeId=collegeId,majorId=majorId,grade=grade,sort=sort),PageSpec(page,pageSize)) }
}
