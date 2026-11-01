package qanda.backend.content

import org.springframework.stereotype.Service
import qanda.backend.content.api.*
import qanda.backend.platform.http.missing
import qanda.backend.platform.security.Actor
import java.util.UUID

@Service
class ContentLibraryService(private val access: ContentAccess,private val queries: ContentQueries,private val questions: QuestionMapper,
                            private val chapters: ChapterMapper,private val content: ContentService): ContentLibrary {
    private fun bankRef(row: QuestionBank)=BankReference(row.id!!,row.subjectId!!,row.contentVersion)
    private fun questionRef(row: Question)=QuestionReference().apply { id=row.id;bankId=row.bankId;currentRevisionId=row.currentRevisionId;readingParentId=row.readingParentId;status=row.status }
    override fun bank(actor: Actor?,id: UUID,write: Boolean)=bankRef(access.bank(actor,id,write))
    override fun lockBank(id: UUID)=bankRef(queries.lockBank(id) ?: missing())
    override fun visibleBankSubject(id: UUID,userId: UUID)=queries.bank(id,userId)?.subjectId
    override fun chapterBelongs(id: UUID,bankId: UUID)=chapters.selectById(id)?.bankId==bankId
    override fun question(id: UUID)=questionRef(questions.selectById(id) ?: missing())
    override fun readingChildren(id: UUID)=queries.readingChildren(id).map(::questionRef)
    override fun revision(questionId: UUID,revisionId: UUID?,answers: Boolean,materialRevisionId: UUID?): QuestionView {
        val q=questions.selectById(questionId) ?: missing()
        return content.questionView(q,revisionId ?: q.currentRevisionId!!,answers,materialRevisionId ?: content.materialRevision(q))
    }
    override fun materialRevision(questionId: UUID)=content.materialRevision(questions.selectById(questionId) ?: missing())
    override fun favorites(userId: UUID,ids: List<UUID>)=queries.favoriteQuestionIds(userId,ids)
}
