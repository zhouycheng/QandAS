package qanda.backend.operations

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import java.util.UUID

class DashboardRow { var collegeCount: Long=0;var subjectCount: Long=0;var questionBankCount: Long=0;var questionCount: Long=0;var userCount: Long=0;var answeredCount: Long=0;var pendingFeedbackCount: Long=0;var pendingCourseRequestCount: Long=0;var publishedBankCount: Long=0;var draftBankCount: Long=0;var missingExplanationCount: Long=0;var unassignedQuestionCount: Long=0;var emptyBankCount: Long=0 }
@Mapper interface OperationsMapper {
    fun issuedRevision(@Param("userId") userId: UUID,@Param("revisionId") revisionId: UUID): Boolean
    fun lockFeedback(@Param("id") id: UUID): QuestionFeedback?
    fun feedback(@Param("userId") userId: UUID?,@Param("status") status: String?,@Param("offset") offset: Int,@Param("limit") limit: Int): List<QuestionFeedback>
    fun feedbackCount(@Param("userId") userId: UUID?,@Param("status") status: String?): Long
    fun lockRequest(@Param("id") id: UUID): CourseRequest?
    fun requests(@Param("userId") userId: UUID?,@Param("status") status: String?,@Param("offset") offset: Int,@Param("limit") limit: Int): List<CourseRequest>
    fun requestCount(@Param("userId") userId: UUID?,@Param("status") status: String?): Long
    fun dashboard(): DashboardRow
}
