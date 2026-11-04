package qanda.backend.monitoring

import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.*
import java.time.temporal.ChronoUnit
import java.util.UUID
import qanda.backend.platform.queries.StatsFilter
import qanda.backend.platform.http.*

data class ActivityDayView(val date: LocalDate,val activeUsers: Long,val newUsers: Long,val returningUsers: Long)
data class ActivityView(val dailyActive: Long,val weeklyActive: Long,val monthlyActive: Long,val activeUsers: Long,val retention: Double,val records: List<ActivityDayView>,val onlineUsers: Long,val updatedAt: Instant)
data class RankingView(val userId: UUID,val nickname: String,val answeredCount: Long,val correctCount: Long,val durationSeconds: Long,
    val rank: Long,val accountCode: String,val activeDays: Long,val lastActiveAt: Instant?)

@Service
@Transactional(readOnly=true,timeout=3)
class ActivityService(private val sql: ActivityMapper,private val clock: Clock) {
    private val zone=ZoneId.of("Asia/Shanghai")
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
        (p.offset+i+1).toLong(),it.accountCode,it.activeDays,it.lastActiveAt) },sql.rankingCount(f),p.page,p.pageSize)
}
