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
                          val selfRatedCount: Long,val selfRatedCorrectCount: Long,val selfRatedWrongCount: Long,val durationSeconds: Long)
data class DayView(val date: LocalDate,val practiceCount: Long,val answeredCount: Long,val correctCount: Long,val durationSeconds: Long,val objectiveAnsweredCount: Long=0)
data class WrongView(val questionId: UUID,val questionBankId: UUID,val stem: String,val type: String,val lastOutcome: String,val lastPracticedAt: Instant,val rightCount: Long,val wrongCount: Long,val available: Boolean,val subjectId: UUID?=null,val subjectName: String?=null,val questionBankName: String?=null,val contentFormat: String="PLAIN_TEXT",val presentation: String="STANDARD")

@Service
@Transactional(readOnly=true)
class LearningService(private val sql: LearningMapper,private val clock: Clock) {
    private val zone=ZoneId.of("Asia/Shanghai")
    private val minimumDate=LocalDate.of(1900,1,1)
    private val maximumDateExclusive=LocalDate.of(2201,1,1)
    fun statistics(f: StatsFilter): StatisticsView {
        val r=sql.stats(f);val self=sql.selfStats(f);val answered=r.correctCount+r.wrongCount
        return StatisticsView(f.start.atZone(zone).toLocalDate(),f.end.atZone(zone).toLocalDate(),r.practiceCount,r.totalCount,r.answeredCount,r.correctCount,r.wrongCount,r.unansweredCount,
            if(answered==0L) null else r.correctCount.toDouble()/answered,r.shortAnswerCount,self.rated,self.correct,self.wrong,r.durationSeconds)
    }
    fun days(userId: UUID,start: LocalDate,end: LocalDate): List<DayView> {
        if(start < minimumDate || end > maximumDateExclusive || end <= start || ChronoUnit.DAYS.between(start,end) !in 1..366) invalid("/dateRange")
        val rows=sql.days(StatsFilter(start.atStartOfDay(zone).toInstant(),end.atStartOfDay(zone).toInstant(),userId)).associateBy { it.day }
        return start.datesUntil(end).map { day -> val r=rows[day];DayView(day,r?.practiceCount ?: 0,r?.answeredCount ?: 0,r?.correctCount ?: 0,r?.durationSeconds ?: 0,r?.objectiveAnsweredCount ?: 0) }.toList()
    }
}
