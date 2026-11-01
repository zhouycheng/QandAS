package qanda.backend.operations

import qanda.backend.content.QuestionView
import io.swagger.v3.oas.annotations.media.Schema
import java.time.Instant
import java.util.UUID

data class FeedbackInput(val questionId: UUID,val revisionId: UUID,@field:Schema(allowableValues=["ANSWER","EXPLANATION","STEM_OPTIONS","OTHER"]) val category: String,val body: String)
data class CourseRequestInput(val courseName: String,val body: String,val majorId: UUID?=null)
data class HandleInput(val expectedVersion: Long,@field:Schema(allowableValues=["OPEN","IN_PROGRESS","RESOLVED","DISMISSED"]) val status: String,val response: String)
data class FeedbackView(val id: UUID,val userId: UUID,@field:Schema(allowableValues=["ANSWER","EXPLANATION","STEM_OPTIONS","OTHER"]) val category: String,val body: String,val status: String,val response: String,val version: Long,val question: QuestionView,val createdAt: Instant,val updatedAt: Instant)
data class CourseRequestView(val id: UUID,val userId: UUID,val courseName: String,val majorId: UUID?,val body: String,val status: String,val response: String,val version: Long,val createdAt: Instant,val updatedAt: Instant)
data class DashboardView(val collegeCount: Long,val subjectCount: Long,val questionBankCount: Long,val questionCount: Long,val userCount: Long,val answeredCount: Long,val pendingFeedbackCount: Long,val pendingCourseRequestCount: Long,val publishedBankCount: Long,val draftBankCount: Long,val missingExplanationCount: Long,val unassignedQuestionCount: Long,val emptyBankCount: Long)
