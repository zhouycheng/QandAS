package qanda.backend.content.api

import qanda.backend.content.QuestionView
import qanda.backend.platform.security.Actor
import java.util.UUID

data class BankReference(val id: UUID,val subjectId: UUID,val contentVersion: Long)
class QuestionReference {
    var id: UUID?=null;var bankId: UUID?=null;var currentRevisionId: UUID?=null;var readingParentId: UUID?=null;var status: String=""
}
interface ContentLibrary {
    fun bank(actor: Actor?,id: UUID,write: Boolean=false): BankReference
    fun lockBank(id: UUID): BankReference
    fun visibleBankSubject(id: UUID,userId: UUID): UUID?
    fun chapterBelongs(id: UUID,bankId: UUID): Boolean
    fun question(id: UUID): QuestionReference
    fun readingChildren(id: UUID): List<QuestionReference>
    fun revision(questionId: UUID,revisionId: UUID?=null,answers: Boolean=false,materialRevisionId: UUID?=null): QuestionView
    fun materialRevision(questionId: UUID): UUID?
    fun favorites(userId: UUID,ids: List<UUID>): List<UUID>
}
