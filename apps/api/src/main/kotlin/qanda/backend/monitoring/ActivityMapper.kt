package qanda.backend.monitoring

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import java.time.*
import java.util.UUID
import qanda.backend.platform.queries.StatsFilter

class ActivityRow { var day: LocalDate=LocalDate.now();var activeUsers: Long=0;var newUsers: Long=0 }
class RankingRow { var userId: UUID?=null;var nickname: String="";var answeredCount: Long=0;var correctCount: Long=0;var durationSeconds: Long=0
    var accountCode: String="";var collegeId: UUID?=null;var collegeName: String?=null;var majorId: UUID?=null;var majorName: String?=null
    var currentGrade: Int?=null;var activeDays: Long=0;var lastActiveAt: Instant?=null }
@Mapper interface ActivityMapper {
    fun activeCount(@Param("f") filter: StatsFilter): Long
    fun onlineCount(@Param("f") filter: StatsFilter,@Param("now") now: Instant): Long
    fun activityDays(@Param("f") filter: StatsFilter): List<ActivityRow>
    fun returningCount(@Param("f") filter: StatsFilter,@Param("previousStart") previousStart: Instant): Long
    fun ranking(@Param("f") filter: StatsFilter,@Param("offset") offset: Int,@Param("limit") limit: Int): List<RankingRow>
    fun rankingCount(@Param("f") filter: StatsFilter): Long
}
