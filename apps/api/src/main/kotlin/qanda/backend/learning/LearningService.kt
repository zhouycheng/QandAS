package qanda.backend.learning

import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.platform.http.*
import java.time.*
import java.time.temporal.ChronoUnit
import java.util.UUID

data class StatisticsView(val startDate: LocalDate,val endDateExclusive: LocalDate,val practiceCount: Long,val totalCount: Long,val answeredCount: Long,
                          val correctCount: Long,val wrongCount: Long,val unansweredCount: Long,val objectiveAccuracy: Double,val shortAnswerCount: Long,
                          val selfRatedCount: Long,val selfRatedCorrectCount: Long,val selfRatedWrongCount: Long,val durationSeconds: Long)
data class DayView(val date: LocalDate,val practiceCount: Long,val answeredCount: Long,val correctCount: Long,val durationSeconds: Long)
data class WrongView(val questionId: UUID,val questionBankId: UUID,val stem: String,val type: String,val lastOutcome: String,val lastPracticedAt: Instant,val rightCount: Long,val wrongCount: Long,val available: Boolean,val subjectId: UUID?=null,val subjectName: String?=null,val questionBankName: String?=null)
data class QuestionProgressView(val questionId: UUID,val questionBankId: UUID,val outcome: String,val lastPracticedAt: Instant)
data class WrongAttemptView(val sessionId: UUID,val revisionId: UUID,val outcome: String,val selfAssessment: String?,val submittedAt: Instant)
data class ActivityDayView(val date: LocalDate,val activeUsers: Long,val newUsers: Long,val returningUsers: Long)
data class ActivityView(val dailyActive: Long,val weeklyActive: Long,val monthlyActive: Long,val activeUsers: Long,val retention: Double,val records: List<ActivityDayView>,val onlineUsers: Long,val updatedAt: Instant)
data class RankingView(val userId: UUID,val nickname: String,val answeredCount: Long,val correctCount: Long,val durationSeconds: Long,
    val rank: Long,val accountCode: String,val collegeId: UUID?,val collegeName: String?,val majorId: UUID?,val majorName: String?,val currentGrade: Int?,val activeDays: Long,val lastActiveAt: Instant?)
data class OrganizationView(val collegeId: UUID?,val collegeName: String?,val majorId: UUID?,val majorName: String?,val users: Long,val practiceCount: Long,val answeredCount: Long,val correctCount: Long)

@Service
@Transactional(readOnly=true)
class LearningService(private val sql: LearningMapper,private val clock: Clock) {
    private val zone=ZoneId.of("Asia/Shanghai")
    private val minimumDate=LocalDate.of(1900,1,1)
    private val maximumDateExclusive=LocalDate.of(2201,1,1)
    fun filter(period: String,date: LocalDate?,userId: UUID?=null,collegeId: UUID?=null,majorId: UUID?=null,platform: String?=null,grade: Int?=null,sort: String="ACTIVE_DAYS"): StatsFilter {
        if(period !in setOf("DAY","WEEK","MONTH","ALL")) invalid("/period")
        val selected=date ?: LocalDate.now(clock.withZone(zone))
        if(selected < minimumDate || selected >= maximumDateExclusive) invalid("/periodDate")
        val end=selected.plusDays(1)
        val start=when(period) { "DAY" -> end.minusDays(1);"WEEK" -> end.minusDays(7);"MONTH" -> end.minusDays(30);"ALL" -> LocalDate.of(1900,1,1);else -> invalid("/period") }
        if(platform!=null && platform !in setOf("WEB","MINI_PROGRAM")) invalid("/period")
        if(grade!=null && grade !in 1..5) invalid("/grade")
        if(sort !in setOf("ACTIVE_DAYS","ANSWERED_COUNT","DURATION")) invalid("/sort")
        return StatsFilter(start.atStartOfDay(zone).toInstant(),end.atStartOfDay(zone).toInstant(),userId,collegeId,majorId,platform,grade,sort)
    }
    fun statistics(f: StatsFilter): StatisticsView {
        val r=sql.stats(f);val self=sql.selfStats(f);val answered=r.correctCount+r.wrongCount
        return StatisticsView(f.start.atZone(zone).toLocalDate(),f.end.atZone(zone).toLocalDate(),r.practiceCount,r.totalCount,r.answeredCount,r.correctCount,r.wrongCount,r.unansweredCount,
            if(answered==0L) 0.0 else r.correctCount.toDouble()/answered,r.shortAnswerCount,self.rated,self.correct,self.wrong,r.durationSeconds)
    }
    fun days(userId: UUID,start: LocalDate,end: LocalDate): List<DayView> {
        if(start < minimumDate || end > maximumDateExclusive || end <= start || ChronoUnit.DAYS.between(start,end) !in 1..366) invalid("/dateRange")
        val rows=sql.days(StatsFilter(start.atStartOfDay(zone).toInstant(),end.atStartOfDay(zone).toInstant(),userId)).associateBy { it.day }
        return start.datesUntil(end).map { day -> val r=rows[day];DayView(day,r?.practiceCount ?: 0,r?.answeredCount ?: 0,r?.correctCount ?: 0,r?.durationSeconds ?: 0) }.toList()
    }
    fun wrong(userId: UUID,status: String,bankId: UUID?,p: PageSpec): Page<WrongView> {
        if(status !in setOf("ALL","UNMASTERED","MASTERED")) invalid("/status")
        return Page(sql.wrong(userId,status,bankId,p.offset,p.pageSize).map { WrongView(it.questionId!!,it.bankId!!,it.stem,it.type,it.lastOutcome,it.lastPracticedAt,it.rightCount,it.wrongCount,it.available) },sql.wrongCount(userId,status,bankId),p.page,p.pageSize)
    }
    fun questionProgress(userId: UUID,bankId: UUID?,p: PageSpec): Page<QuestionProgressView> = Page(sql.questionProgress(userId,bankId,p.offset,p.pageSize).map { QuestionProgressView(it.questionId!!,it.bankId!!,it.lastOutcome,it.lastPracticedAt) },sql.questionProgressCount(userId,bankId),p.page,p.pageSize)
    fun wrongHistory(userId: UUID,questionId: UUID,p: PageSpec): Page<WrongAttemptView> = Page(sql.wrongHistory(userId,questionId,p.offset,p.pageSize).map { WrongAttemptView(it.sessionId!!,it.revisionId!!,it.outcome,it.selfAssessment,it.submittedAt) },sql.wrongHistoryCount(userId,questionId),p.page,p.pageSize)
    fun activity(f: StatsFilter): ActivityView {
        val length=Duration.between(f.start,f.end);val previous=f.copy(start=f.start.minus(length),end=f.start)
        val base=sql.activeCount(previous);val now=clock.instant()
        val end=now.atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant()
        val today=f.copy(start=end.minus(Duration.ofDays(1)),end=end)
        val week=today.copy(start=end.minus(Duration.ofDays(7)));val month=today.copy(start=end.minus(Duration.ofDays(30)))
        val rows=sql.activityDays(f).associateBy { it.day }
        val startDate=f.start.atZone(zone).toLocalDate();val endDate=f.end.atZone(zone).toLocalDate()
        val records=if(ChronoUnit.DAYS.between(startDate,endDate)<=366) startDate.datesUntil(endDate).map { day ->
            val r=rows[day];ActivityDayView(day,r?.activeUsers ?: 0,r?.newUsers ?: 0,(r?.activeUsers ?: 0)-(r?.newUsers ?: 0))
        }.toList() else rows.values.map { ActivityDayView(it.day,it.activeUsers,it.newUsers,it.activeUsers-it.newUsers) }.sortedBy { it.date }
        return ActivityView(sql.activeCount(today),sql.activeCount(week),sql.activeCount(month),sql.activeCount(f),if(base==0L) 0.0 else sql.returningCount(f,previous.start).toDouble()/base,records,sql.onlineCount(f,now),now)
    }
    fun rankings(f: StatsFilter,p: PageSpec): Page<RankingView> = Page(sql.ranking(f,p.offset,p.pageSize).mapIndexed { i,it -> RankingView(it.userId!!,it.nickname,it.answeredCount,it.correctCount,it.durationSeconds,
        (p.offset+i+1).toLong(),it.accountCode,it.collegeId,it.collegeName,it.majorId,it.majorName,it.currentGrade,it.activeDays,it.lastActiveAt) },sql.rankingCount(f),p.page,p.pageSize)
    fun organizations(f: StatsFilter,p: PageSpec): Page<OrganizationView> = Page(sql.organizations(f,p.offset,p.pageSize).map { OrganizationView(it.collegeId,it.collegeName,it.majorId,it.majorName,it.users,it.practiceCount,it.answeredCount,it.correctCount) },sql.organizationCount(f),p.page,p.pageSize)
}
