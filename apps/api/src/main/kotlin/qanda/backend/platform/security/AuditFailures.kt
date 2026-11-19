package qanda.backend.platform.security

import jakarta.servlet.http.HttpServletRequest
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import org.springframework.security.core.context.SecurityContextHolder
import qanda.backend.platform.http.RequestIds
import qanda.backend.platform.persistence.AuditLog
import qanda.backend.platform.persistence.AuditLogMapper
import java.util.UUID

@Service
class AuditFailures(private val rows: AuditLogMapper) {
    @Transactional(propagation=Propagation.REQUIRES_NEW)
    fun record(request: HttpServletRequest,code: String) {
        val actor=request.getAttribute("bankAgentActor") as? Actor ?: SecurityContextHolder.getContext().authentication?.principal as? Actor
        val path=if(request.requestURI.startsWith("/bank-agent/files/")) "/bank-agent/files/{token}" else request.requestURI
        rows.insert(AuditLog().apply { id=UUID.randomUUID();actorUserId=actor?.takeIf { it.kind=="USER" }?.id;actorAdminId=actor?.takeIf { it.kind=="ADMIN" }?.id
            operation=(request.getAttribute("bankAgentOperation") as? String ?: "${request.method} $path").take(200);requestId=RequestIds.get(request);outcome="FAILURE";reasonCode=code })
    }
}
