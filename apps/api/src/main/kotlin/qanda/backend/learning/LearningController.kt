package qanda.backend.learning

import org.springframework.format.annotation.DateTimeFormat
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import qanda.backend.practice.*
import java.time.LocalDate
import java.util.UUID

@RestController
@RequestMapping("/api/v1",produces=["application/json"])
class LearningController(private val periods: qanda.backend.platform.queries.StatsPeriods,private val reads: LearningReadService,private val service: LearningService,private val practice: PracticeService,private val sessions: Sessions) {
    @GetMapping("/me/learning-overview") fun overview(@RequestParam(required=false) deviceId: UUID?,@RequestParam(required=false) pendingSessionIds: List<UUID>?): LearningOverviewView = reads.overview(sessions.student().id,deviceId,pendingSessionIds.orEmpty())
    @PostMapping("/me/learning-overview") fun pendingOverview(@RequestBody input: PendingLearningInput): LearningOverviewView = reads.overview(sessions.student().id,input.deviceId,input.pendingSessionIds,input.pendingQuestionIds,input.pendingAssessmentItemIds,input.pendingItemIds)
    @GetMapping("/me/question-collections/summary") fun collectionSummary(@RequestParam kind: String): CollectionSummaryView = reads.summary(sessions.student().id,kind)
    @GetMapping("/me/recent-learning") fun recent(@RequestParam(required=false) deviceId: UUID?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<PracticeSummary> = practice.history(sessions.student().id,PageSpec(page,pageSize),deviceId)
    @GetMapping("/me/wrong-questions") fun wrong(@RequestParam(defaultValue="UNMASTERED") status: String,@RequestParam(required=false) questionBankId: UUID?,@RequestParam(required=false) subjectId: UUID?,@RequestParam(defaultValue="all") chip: String,@RequestParam(defaultValue="recent") sort: String,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<WrongView> = reads.wrong(sessions.student().id,status,questionBankId,PageSpec(page,pageSize),subjectId,chip,sort)
    @PostMapping("/me/statistics") fun localSummary(@RequestBody input: LocalStatisticsInput): StatisticsView = service.statistics(periods.filter(input.period,input.periodDate,sessions.student().id),input.pendingSessionIds,input.pendingAssessmentItemIds)
    @PostMapping("/me/statistics/days") fun localDays(@RequestBody input: LocalDaysInput): List<DayView> = service.days(sessions.student().id,input.startDate,input.endDateExclusive,input.pendingSessionIds)
    @GetMapping("/me/statistics") fun summary(@RequestParam(defaultValue="WEEK") period: String,@RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) periodDate: LocalDate?): StatisticsView = service.statistics(periods.filter(period,periodDate,sessions.student().id))
    @GetMapping("/me/statistics/days") fun days(@RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) startDate: LocalDate,@RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) endDateExclusive: LocalDate): List<DayView> = service.days(sessions.student().id,startDate,endDateExclusive)
    @GetMapping("/admin/students/{id}/statistics") fun studentSummary(@PathVariable id: UUID,@RequestParam(defaultValue="WEEK") period: String,@RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) periodDate: LocalDate?): StatisticsView { sessions.admin();return service.statistics(periods.filter(period,periodDate,id)) }
}
