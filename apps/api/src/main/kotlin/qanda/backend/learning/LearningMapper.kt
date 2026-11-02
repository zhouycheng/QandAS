package qanda.backend.learning

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import java.time.LocalDate
import java.util.UUID
import qanda.backend.platform.queries.StatsFilter

class StatsRow { var practiceCount: Long=0;var totalCount: Long=0;var answeredCount: Long=0;var correctCount: Long=0;var wrongCount: Long=0;var unansweredCount: Long=0;var shortAnswerCount: Long=0;var durationSeconds: Long=0 }
class SelfRow { var rated: Long=0;var correct: Long=0;var wrong: Long=0 }
class DailyRow { var objectiveAnsweredCount: Long=0; var day: LocalDate=LocalDate.now();var practiceCount: Long=0;var answeredCount: Long=0;var correctCount: Long=0;var durationSeconds: Long=0 }
@Mapper interface LearningMapper {
    fun stats(@Param("f") filter: StatsFilter): StatsRow
    fun selfStats(@Param("f") filter: StatsFilter): SelfRow
    fun days(@Param("f") filter: StatsFilter): List<DailyRow>
}
