package qanda.backend.discovery

import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.catalog.*
import qanda.backend.content.BankView
import qanda.backend.content.ContentService
import qanda.backend.content.api.ContentLibrary
import qanda.backend.identity.IdentityService
import qanda.backend.platform.http.*
import qanda.backend.platform.security.Actor
import java.time.Instant
import java.util.UUID

data class RecommendedBank(val bank: BankView,val reasons: List<String>)
data class Recommendation(val subject: SubjectView,val banks: List<RecommendedBank>)
data class FavoriteView(val questionId: UUID,val questionBankId: UUID,val stem: String,val type: String,val available: Boolean,val createdAt: Instant,val subjectId: UUID?=null,val subjectName: String?=null,val questionBankName: String?=null,val practiced: Boolean?=null,val contentFormat: String="PLAIN_TEXT",val presentation: String="STANDARD")

@Service
@Transactional
class DiscoveryService(private val sql: DiscoveryMapper,private val catalog: CatalogService,private val identity: IdentityService,private val content: ContentService) {
    fun favorite(actor: Actor,id: UUID,enabled: Boolean): MutationResult {
        if(enabled) content.question(actor,id)
        if(enabled) sql.favorite(actor.id,id) else sql.unfavorite(actor.id,id)
        return MutationResult(id,1)
    }
    fun recommendations(actor: Actor,p: PageSpec): Page<Recommendation> {
        val ids=sql.recommendedSubjects(actor.id,p.offset,p.pageSize)
        val subjects=catalog.subjectsByIds(ids).associateBy { it.id }
        val selected=if(ids.isEmpty()) emptyList() else sql.recommendationBanks(actor.id,ids)
        val banks=content.bankViewsByIds(selected.map { it.bankId!! }).associateBy { it.id }
        val grouped=selected.groupBy { it.subjectId }
        val items=ids.map { subject ->
            Recommendation(subjects.getValue(subject),grouped[subject].orEmpty().map { row ->
                val bank=banks.getValue(row.bankId!!)
                val reasons=listOf(if(bank.categories.isEmpty()) "通用题库" else "公开题库")
                RecommendedBank(bank,reasons)
            })
        }
        return Page(items,sql.recommendedCount(actor.id),p.page,p.pageSize)
    }
}
