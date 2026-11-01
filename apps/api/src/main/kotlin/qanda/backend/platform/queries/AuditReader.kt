package qanda.backend.platform.queries

import org.springframework.stereotype.Service
import qanda.backend.platform.http.Page
import qanda.backend.platform.http.PageSpec
import qanda.backend.platform.persistence.SystemMapper
import java.time.Instant
import java.util.UUID

data class AuditView(val id: UUID,val actorUserId: UUID?,val actorAdminId: UUID?,val operation: String,val outcome: String,val reasonCode: String?,val requestId: UUID,val createdAt: Instant)

@Service
class AuditReader(private val sql: SystemMapper) {
    fun page(page: PageSpec,keyword: String?,result: String?) = Page(sql.auditPage(page.offset,page.pageSize,keyword,result).map {
        AuditView(it.id!!,it.actorUserId,it.actorAdminId,it.operation,it.outcome,it.reasonCode,it.requestId!!,it.createdAt)
    },sql.auditCount(keyword,result),page.page,page.pageSize)
}
