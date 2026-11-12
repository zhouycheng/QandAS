package qanda.backend.content

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.*
import qanda.backend.content.api.RevisionReference
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.invalid
import java.util.UUID

data class RevisionStatusInput(@field:io.swagger.v3.oas.annotations.media.ArraySchema(minItems=1,maxItems=100,uniqueItems=true) val items: List<RevisionReference>)
data class RevisionStatusView(val questionId: UUID,val revisionId: UUID?,val materialRevisionId: UUID?,val questionBankId: UUID?,val contentVersion: Long?,val available: Boolean,val changed: Boolean)
@Service
class RevisionStatus(private val jdbc: JdbcTemplate) {
    @Transactional(readOnly=true)
    fun read(input: RevisionStatusInput): List<RevisionStatusView> {
        if(input.items.size !in 1..100 || input.items.distinct().size!=input.items.size) invalid("/items")
        val ids=input.items.map { it.questionId }.distinct()
        val rows=jdbc.query("""SELECT q.id,q.current_revision_id,p.current_revision_id material_revision_id,b.id bank_id,b.content_version,a.id IS NOT NULL AND vb.id IS NOT NULL available
            FROM question q JOIN question_bank b ON b.id=q.bank_id LEFT JOIN question p ON p.id=q.reading_parent_id
            LEFT JOIN active_question a ON a.id=q.id LEFT JOIN visible_question_bank vb ON vb.id=b.id WHERE q.id IN (${ids.joinToString(",") { "?" }})""",{ r,_ ->
            val available=r.getBoolean("available")
            RevisionStatusView(r.getObject("id",UUID::class.java),r.getObject("current_revision_id",UUID::class.java).takeIf { available },r.getObject("material_revision_id",UUID::class.java).takeIf { available },r.getObject("bank_id",UUID::class.java).takeIf { available },r.getLong("content_version").takeIf { available },available,false)
        },*ids.toTypedArray()).associateBy { it.questionId }
        return input.items.map { ref ->
            val row=rows[ref.questionId] ?: RevisionStatusView(ref.questionId,null,null,null,null,false,true)
            row.copy(changed=!row.available || row.revisionId!=ref.revisionId || row.materialRevisionId!=ref.materialRevisionId)
        }
    }
}
@RestController
@RequestMapping("/api/v1/content",produces=["application/json"])
class RevisionStatusController(private val revisions: RevisionStatus,private val sessions: Sessions) {
    @PostMapping("/revision-status") fun read(@RequestBody input: RevisionStatusInput): List<RevisionStatusView> { sessions.studentOrGuest();return revisions.read(input) }
}
