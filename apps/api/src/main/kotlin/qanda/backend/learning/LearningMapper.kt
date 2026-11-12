package qanda.backend.learning

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import java.time.LocalDate
import java.util.UUID
import qanda.backend.platform.queries.StatsFilter

class StatsRow { var distinctCount: Long=0;var selfRatedCount: Long=0;var selfCorrectCount: Long=0;var selfWrongCount: Long=0; var practiceCount: Long=0;var totalCount: Long=0;var answeredCount: Long=0;var correctCount: Long=0;var wrongCount: Long=0;var unansweredCount: Long=0;var shortAnswerCount: Long=0;var durationSeconds: Long=0 }
class DailyRow { var objectiveAnsweredCount: Long=0; var day: LocalDate=LocalDate.now();var practiceCount: Long=0;var answeredCount: Long=0;var correctCount: Long=0;var durationSeconds: Long=0 }
class PendingSessionRow { var id: UUID?=null;var submittedAt: java.time.Instant?=null }
@Mapper interface LearningMapper {
    fun includedSessions(@Param("f") f: StatsFilter,@Param("ids") ids: List<UUID>): List<UUID>
    fun knownQuestions(@Param("f") f: StatsFilter,@Param("ids") ids: List<UUID>): List<UUID>
    fun pendingSessions(@Param("userId") userId: UUID,@Param("ids") ids: List<UUID>): List<PendingSessionRow>
    fun stats(@Param("f") filter: StatsFilter): StatsRow
    fun days(@Param("f") filter: StatsFilter): List<DailyRow>
}
