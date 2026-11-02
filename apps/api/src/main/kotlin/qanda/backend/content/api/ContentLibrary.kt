package qanda.backend.content.api

import qanda.backend.content.QuestionView
import qanda.backend.platform.security.Actor
import java.util.UUID

data class BankReference(val id: UUID,val subjectId: UUID,val contentVersion: Long)
class QuestionReference {
    var id: UUID?=null;var bankId: UUID?=null;var currentRevisionId: UUID?=null;var readingParentId: UUID?=null;var status: String=""
}
data class RevisionReference(val questionId: UUID,val revisionId: UUID?=null,val materialRevisionId: UUID?=null)
interface ContentLibrary {
    fun revisions(refs: List<RevisionReference>,answers: Boolean): List<QuestionView>
    fun bank(actor: Actor?,id: UUID,write: Boolean=false): BankReference
    fun lockBank(id: UUID): BankReference
    fun visibleBankSubject(id: UUID,userId: UUID): UUID?
    fun chapterBelongs(id: UUID,bankId: UUID): Boolean
    fun questions(ids: List<UUID>): List<QuestionReference>
    fun question(id: UUID): QuestionReference
    fun readingChildrenFor(ids: List<UUID>): List<QuestionReference>
    fun revision(questionId: UUID,revisionId: UUID?=null,answers: Boolean=false,materialRevisionId: UUID?=null): QuestionView
    fun favorites(userId: UUID,ids: List<UUID>): List<UUID>
}
