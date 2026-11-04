package qanda.backend.platform.queries

import java.time.*
import java.util.UUID
import org.springframework.stereotype.Service
import qanda.backend.platform.http.invalid

data class StatsFilter(val start: Instant,val end: Instant,val userId: UUID?=null,val sort: String="ACTIVE_DAYS")

@Service
class StatsPeriods(private val clock: Clock) {
    private val zone=ZoneId.of("Asia/Shanghai")
    private val minimumDate=LocalDate.of(1900,1,1)
    private val maximumDateExclusive=LocalDate.of(2201,1,1)
    fun filter(period: String,date: LocalDate?,userId: UUID?=null,sort: String="ACTIVE_DAYS"): StatsFilter {
        if(period !in setOf("DAY","WEEK","MONTH","ALL")) invalid("/period")
        val selected=date ?: LocalDate.now(clock.withZone(zone))
        if(selected < minimumDate || selected >= maximumDateExclusive) invalid("/periodDate")
        val end=selected.plusDays(1)
        val start=when(period) { "DAY" -> end.minusDays(1);"WEEK" -> end.minusDays(7);"MONTH" -> end.minusDays(30);"ALL" -> LocalDate.of(1900,1,1);else -> invalid("/period") }
        if(sort !in setOf("ACTIVE_DAYS","ANSWERED_COUNT","DURATION")) invalid("/sort")
        return StatsFilter(start.atStartOfDay(zone).toInstant(),end.atStartOfDay(zone).toInstant(),userId,sort)
    }
}
