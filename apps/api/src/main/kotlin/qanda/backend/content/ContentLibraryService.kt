package qanda.backend.content

import org.springframework.stereotype.Service
import qanda.backend.content.api.*
import qanda.backend.platform.http.missing
import qanda.backend.platform.security.Actor
import java.util.UUID

@Service
class ContentLibraryService(private val access: ContentAccess,private val queries: ContentQueries,private val questions: QuestionMapper,
                            private val chapters: ChapterMapper,private val content: ContentService,private val reader: QuestionReader): ContentLibrary {
    override fun revisions(refs: List<RevisionReference>,answers: Boolean) = reader.read(refs,answers)
    private fun bankRef(row: QuestionBank)=BankReference(row.id!!,row.subjectId!!,row.contentVersion)
    private fun questionRef(row: Question)=QuestionReference().apply { id=row.id;bankId=row.bankId;currentRevisionId=row.currentRevisionId;readingParentId=row.readingParentId;status=row.status }
    override fun bank(actor: Actor?,id: UUID,write: Boolean)=bankRef(access.bank(actor,id,write))
    override fun lockBank(id: UUID)=bankRef(queries.lockBankForRead(id) ?: missing())
    override fun visibleBankSubject(id: UUID,userId: UUID)=queries.bank(id,userId)?.subjectId
    override fun chapterBelongs(id: UUID,bankId: UUID)=chapters.selectById(id)?.bankId==bankId
    override fun questions(ids: List<UUID>)=if(ids.isEmpty()) emptyList() else questions.selectByIds(ids).map(::questionRef)
    override fun question(id: UUID)=questions(listOf(id)).singleOrNull() ?: missing()
    override fun readingChildrenFor(ids: List<UUID>)=if(ids.isEmpty()) emptyList() else queries.readingChildrenFor(ids).map(::questionRef)
    override fun revision(questionId: UUID,revisionId: UUID?,answers: Boolean,materialRevisionId: UUID?): QuestionView {
        val q=questions.selectById(questionId) ?: missing()
        return content.questionView(q,revisionId ?: q.currentRevisionId!!,answers,materialRevisionId ?: content.materialRevision(q))
    }
    override fun favorites(userId: UUID,ids: List<UUID>)=queries.favoriteQuestionIds(userId,ids)
}
