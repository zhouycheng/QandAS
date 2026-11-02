package qanda.backend.learning

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import qanda.backend.platform.queries.StatsFilter

class StatsRow { var practiceCount: Long=0;var totalCount: Long=0;var answeredCount: Long=0;var correctCount: Long=0;var wrongCount: Long=0;var unansweredCount: Long=0;var shortAnswerCount: Long=0;var durationSeconds: Long=0 }
class SelfRow { var rated: Long=0;var correct: Long=0;var wrong: Long=0 }
class DailyRow { var objectiveAnsweredCount: Long=0; var day: LocalDate=LocalDate.now();var practiceCount: Long=0;var answeredCount: Long=0;var correctCount: Long=0;var durationSeconds: Long=0 }
class WrongRow { var questionId: UUID?=null;var bankId: UUID?=null;var stem: String="";var type: String="";var lastOutcome: String="";var lastPracticedAt: Instant=Instant.now();var rightCount: Long=0;var wrongCount: Long=0;var available: Boolean=false }
class WrongHistoryRow { var sessionId: UUID?=null;var revisionId: UUID?=null;var outcome: String="";var selfAssessment: String?=null;var submittedAt: Instant=Instant.now() }
class OrganizationRow { var collegeId: UUID?=null;var majorId: UUID?=null;var collegeName: String?=null;var majorName: String?=null;var users: Long=0;var practiceCount: Long=0;var answeredCount: Long=0;var correctCount: Long=0 }
@Mapper interface LearningMapper {
    fun stats(@Param("f") filter: StatsFilter): StatsRow
    fun selfStats(@Param("f") filter: StatsFilter): SelfRow
    fun days(@Param("f") filter: StatsFilter): List<DailyRow>
    fun wrong(@Param("userId") userId: UUID,@Param("status") status: String,@Param("bankId") bankId: UUID?,@Param("offset") offset: Int,@Param("limit") limit: Int): List<WrongRow>
    fun wrongCount(@Param("userId") userId: UUID,@Param("status") status: String,@Param("bankId") bankId: UUID?): Long
    fun questionProgress(@Param("userId") userId: UUID,@Param("bankId") bankId: UUID?,@Param("offset") offset: Int,@Param("limit") limit: Int): List<WrongRow>
    fun questionProgressCount(@Param("userId") userId: UUID,@Param("bankId") bankId: UUID?): Long
    fun wrongHistory(@Param("userId") userId: UUID,@Param("questionId") questionId: UUID,@Param("offset") offset: Int,@Param("limit") limit: Int): List<WrongHistoryRow>
    fun wrongHistoryCount(@Param("userId") userId: UUID,@Param("questionId") questionId: UUID): Long
    fun organizations(@Param("f") filter: StatsFilter,@Param("offset") offset: Int,@Param("limit") limit: Int): List<OrganizationRow>
    fun organizationCount(@Param("f") filter: StatsFilter): Long
}
