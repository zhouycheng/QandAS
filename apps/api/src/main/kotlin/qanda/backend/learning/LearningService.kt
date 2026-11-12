package qanda.backend.learning

import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.platform.http.*
import java.time.*
import java.time.temporal.ChronoUnit
import java.util.UUID
import qanda.backend.platform.queries.StatsFilter

data class StatisticsView(val startDate: LocalDate,val endDateExclusive: LocalDate,val practiceCount: Long,val totalCount: Long,val answeredCount: Long,
                          val correctCount: Long,val wrongCount: Long,val unansweredCount: Long,val objectiveAccuracy: Double?,val shortAnswerCount: Long,
                          val selfRatedCount: Long,val selfRatedCorrectCount: Long,val selfRatedWrongCount: Long,val durationSeconds: Long,
                          val answerAttemptCount: Long,val distinctQuestionCount: Long,val objectiveAnsweredCount: Long,val objectiveCorrectCount: Long,val includedSessionIds: List<UUID> = emptyList(),val knownQuestionIds: List<UUID> = emptyList(),val assessmentFacts: List<PendingAssessmentFact> = emptyList())
data class DayView(val date: LocalDate,val practiceCount: Long,val answeredCount: Long,val correctCount: Long,val durationSeconds: Long,val objectiveAnsweredCount: Long=0,val includedSessionIds: List<UUID> = emptyList())
data class WrongView(val questionId: UUID,val questionBankId: UUID,val stem: String,val type: String,val lastOutcome: String,val lastPracticedAt: Instant,val rightCount: Long,val wrongCount: Long,val available: Boolean,val subjectId: UUID?=null,val subjectName: String?=null,val questionBankName: String?=null,val contentFormat: String="PLAIN_TEXT",val presentation: String="STANDARD")

data class LocalStatisticsInput(val period: String="WEEK",val periodDate: LocalDate?=null,val pendingSessionIds: List<UUID> = emptyList(),val pendingAssessmentItemIds: List<UUID> = emptyList())
data class LocalDaysInput(val startDate: LocalDate,val endDateExclusive: LocalDate,val pendingSessionIds: List<UUID> = emptyList())

@Service
@Transactional(readOnly=true)
class LearningService(private val sql: LearningMapper,private val reads: LearningReadMapper,private val clock: Clock) {
    private val zone=ZoneId.of("Asia/Shanghai")
    private val minimumDate=LocalDate.of(1900,1,1)
    private val maximumDateExclusive=LocalDate.of(2201,1,1)
    @Transactional(readOnly=true,isolation=org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    fun statistics(f: StatsFilter,pendingSessionIds: List<UUID> = emptyList(),pendingAssessmentItemIds: List<UUID> = emptyList()): StatisticsView {
        if(pendingSessionIds.size>1000 || pendingAssessmentItemIds.size>1000) invalid("/pendingSessionIds")
        val r=sql.stats(f);val answered=r.correctCount+r.wrongCount
        return StatisticsView(f.start.atZone(zone).toLocalDate(),f.end.atZone(zone).toLocalDate(),r.practiceCount,r.totalCount,r.answeredCount,r.correctCount,r.wrongCount,r.unansweredCount,
            if(answered==0L) null else r.correctCount.toDouble()/answered,r.shortAnswerCount,r.selfRatedCount,r.selfCorrectCount,r.selfWrongCount,r.durationSeconds,
            r.answeredCount,r.distinctCount,answered,r.correctCount,if(pendingSessionIds.isEmpty()) emptyList() else sql.includedSessions(f,pendingSessionIds),if(pendingSessionIds.isEmpty()) emptyList() else sql.knownQuestions(f,pendingSessionIds),if(pendingAssessmentItemIds.isEmpty()) emptyList() else reads.assessmentFacts(f.userId!!,pendingAssessmentItemIds.distinct()))
    }
    @Transactional(readOnly=true,isolation=org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    fun days(userId: UUID,start: LocalDate,end: LocalDate,pendingSessionIds: List<UUID> = emptyList()): List<DayView> {
        if(pendingSessionIds.size>1000) invalid("/pendingSessionIds")
        if(start < minimumDate || end > maximumDateExclusive || end <= start || ChronoUnit.DAYS.between(start,end) !in 1..366) invalid("/dateRange")
        val rows=sql.days(StatsFilter(start.atStartOfDay(zone).toInstant(),end.atStartOfDay(zone).toInstant(),userId)).associateBy { it.day }
        val included=if(pendingSessionIds.isEmpty()) emptyList() else sql.pendingSessions(userId,pendingSessionIds)
        return start.datesUntil(end).map { day -> val r=rows[day];DayView(day,r?.practiceCount ?: 0,r?.answeredCount ?: 0,r?.correctCount ?: 0,r?.durationSeconds ?: 0,r?.objectiveAnsweredCount ?: 0,included.filter { it.submittedAt!!.atZone(zone).toLocalDate()==day }.map { it.id!! }) }.toList()
    }
}
