package qanda.backend.operations

import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.catalog.api.CatalogDirectory
import qanda.backend.content.ContentService
import qanda.backend.content.api.ContentLibrary
import qanda.backend.platform.http.*
import qanda.backend.platform.security.Actor
import java.time.Clock
import java.util.UUID

@Service
@Transactional
class OperationsService(private val feedbacks: QuestionFeedbackMapper,private val requests: CourseRequestMapper,
                        private val sql: OperationsMapper,private val content: ContentService,private val library: ContentLibrary,
                        private val directory: CatalogDirectory,private val clock: Clock) {
    private fun body(value: String): String=text(value,4000).also { if(it.isBlank()) invalid("/body") }
    fun feedback(actor: Actor,input: FeedbackInput): MutationResult {
        if(input.category !in setOf("ANSWER","EXPLANATION","STEM_OPTIONS","OTHER")) invalid("/category")
        val q=library.question(input.questionId);library.revision(input.questionId,input.revisionId)
        if(!sql.issuedRevision(actor.id,input.revisionId)) { content.question(actor,input.questionId);if(input.revisionId!=q.currentRevisionId) missing() }
        val row=QuestionFeedback().apply { id=UUID.randomUUID();userId=actor.id;questionId=q.id;revisionId=input.revisionId;category=input.category;body=body(input.body) }
        feedbacks.insert(row);return MutationResult(row.id!!,1)
    }
    fun request(actor: Actor,input: CourseRequestInput): MutationResult {
        input.majorId?.let { if(directory.major(it)==null) invalid("/majorId") }
        val row=CourseRequest().apply { id=UUID.randomUUID();userId=actor.id;courseName=name(input.courseName);majorId=input.majorId;body=body(input.body) }
        requests.insert(row);return MutationResult(row.id!!,1)
    }
    private fun feedbackView(row: QuestionFeedback,admin: Boolean): FeedbackView=FeedbackView(row.id!!,row.userId!!,row.category,row.body,row.status,row.response,row.version,
        library.revision(row.questionId!!,row.revisionId!!,admin),row.createdAt,row.updatedAt,row.response.isNotBlank() && row.version>row.readVersion)
    private fun requestView(row: CourseRequest)=CourseRequestView(row.id!!,row.userId!!,row.courseName,row.majorId,row.body,row.status,row.response,row.version,row.createdAt,row.updatedAt,row.response.isNotBlank() && row.version>row.readVersion)
    fun feedback(actor: Actor,status: String?,p: PageSpec): Page<FeedbackView> {
        val userId=actor.takeIf { it.kind=="USER" }?.id
        return Page(sql.feedback(userId,status,p.offset,p.pageSize).map { feedbackView(it,actor.kind=="ADMIN") },sql.feedbackCount(userId,status),p.page,p.pageSize)
    }
    fun requests(actor: Actor,status: String?,p: PageSpec): Page<CourseRequestView> {
        val userId=actor.takeIf { it.kind=="USER" }?.id
        return Page(sql.requests(userId,status,p.offset,p.pageSize).map(::requestView),sql.requestCount(userId,status),p.page,p.pageSize)
    }
    fun feedbackSummary(actor: Actor): FeedbackSummaryView=sql.feedbackSummary(actor.id)
    private fun readItems(input: FeedbackReadInput): List<FeedbackReadItem> {
        if(input.items.size !in 1..20 || input.items.map { it.id }.distinct().size!=input.items.size) invalid("/items")
        if(input.items.any { it.version<1 }) invalid("/items/version")
        return input.items.sortedBy { it.id.toString() }
    }
    private fun validateRead(actor: Actor,item: FeedbackReadItem,userId: UUID?,version: Long) {
        if(userId!=actor.id) missing()
        if(item.version>version) invalid("/items/version")
    }
    fun readFeedback(actor: Actor,input: FeedbackReadInput): FeedbackReadResult {
        val items=readItems(input)
        items.forEach { item -> val row=sql.lockFeedback(item.id) ?: missing();validateRead(actor,item,row.userId,row.version) }
        items.forEach { sql.readFeedback(it.id,actor.id,it.version) }
        return FeedbackReadResult(items.size)
    }
    fun readRequests(actor: Actor,input: FeedbackReadInput): FeedbackReadResult {
        val items=readItems(input)
        items.forEach { item -> val row=sql.lockRequest(item.id) ?: missing();validateRead(actor,item,row.userId,row.version) }
        items.forEach { sql.readRequest(it.id,actor.id,it.version) }
        return FeedbackReadResult(items.size)
    }
    private fun validateHandling(input: HandleInput) {
        if(input.status !in setOf("OPEN","IN_PROGRESS","RESOLVED","DISMISSED")) invalid("/status")
        text(input.response,4000)
        if(input.status in setOf("RESOLVED","DISMISSED") && input.response.isBlank()) invalid("/response","RESPONSE_REQUIRED","处理完成时请填写回复")
    }
    fun handleFeedback(actor: Actor,id: UUID,input: HandleInput): MutationResult {
        val row=sql.lockFeedback(id) ?: missing();library.bank(actor,library.question(row.questionId!!).bankId!!,true);requireVersion(input.expectedVersion,row.version);validateHandling(input)
        val response=input.response.takeUnless { it.isBlank() } ?: ""
        if(row.status==input.status && row.response==response) return MutationResult(id,row.version)
        row.status=input.status;row.response=response;row.version++;row.updatedAt=clock.instant();feedbacks.updateById(row);return MutationResult(id,row.version)
    }
    fun handleRequest(id: UUID,input: HandleInput): MutationResult {
        val row=sql.lockRequest(id) ?: missing();requireVersion(input.expectedVersion,row.version);validateHandling(input)
        val response=input.response.takeUnless { it.isBlank() } ?: ""
        if(row.status==input.status && row.response==response) return MutationResult(id,row.version)
        row.status=input.status;row.response=response;row.version++;row.updatedAt=clock.instant();requests.updateById(row);return MutationResult(id,row.version)
    }
    fun dashboard(): DashboardView=sql.dashboard().let { DashboardView(it.collegeCount,it.subjectCount,it.questionBankCount,it.questionCount,it.userCount,it.answeredCount,it.pendingFeedbackCount,it.pendingCourseRequestCount,it.publishedBankCount,it.draftBankCount,it.missingExplanationCount,it.unassignedQuestionCount,it.emptyBankCount) }
}
