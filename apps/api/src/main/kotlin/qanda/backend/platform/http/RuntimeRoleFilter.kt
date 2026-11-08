package qanda.backend.platform.http

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.core.env.Environment
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter

@Component
@Order(Ordered.HIGHEST_PRECEDENCE+4)
class RuntimeRoleFilter(private val environment: Environment,private val errors: ErrorWriter): OncePerRequestFilter() {
    override fun doFilterInternal(request: HttpServletRequest,response: HttpServletResponse,chain: FilterChain) {
        val role=environment.getProperty("qanda.backend.role","api")
        val path=request.requestURI
        val monitoring=path.startsWith("/api/v1/admin/monitoring/") || path in setOf("/api/v1/admin/statistics/activity","/api/v1/admin/statistics/rankings","/api/v1/admin/statistics/online-users")
        val permitted=when {
            !path.startsWith("/api/v1/") || path=="/api/v1/health" -> true
            role=="all" -> true
            role=="monitor" -> monitoring
            role=="worker" -> false
            else -> !monitoring
        }
        if(permitted) chain.doFilter(request,response)
        else errors.write(request,response,ApiException(HttpStatus.NOT_FOUND,"NOT_FOUND","当前服务不提供此接口"))
    }
}
