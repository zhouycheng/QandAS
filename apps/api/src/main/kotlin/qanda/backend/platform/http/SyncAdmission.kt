package qanda.backend.platform.http

import io.micrometer.core.instrument.MeterRegistry
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.core.env.Environment
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter
import java.util.concurrent.Semaphore

@Component
@Order(Ordered.HIGHEST_PRECEDENCE+3)
@ConditionalOnWebApplication(type=ConditionalOnWebApplication.Type.SERVLET)
class SyncAdmission(private val errors: ErrorWriter,environment: Environment,registry: MeterRegistry): OncePerRequestFilter() {
    private val pool=environment.getProperty("spring.datasource.hikari.maximum-pool-size",Int::class.java,8)
    private val budgets=mapOf("submit" to (pool/2).coerceAtLeast(1),"query" to (pool/4).coerceAtLeast(1))
    private val permits=budgets.mapValues { Semaphore(it.value) }
    private val rejected=budgets.mapValues { registry.counter("qanda.sync.concurrent.rejections","operation",it.key) }
    init {
        permits.forEach { (operation,semaphore) ->
            registry.gauge("qanda.sync.http.inflight",listOf(io.micrometer.core.instrument.Tag.of("operation",operation)),semaphore) {
                (budgets.getValue(operation)-it.availablePermits()).toDouble()
            }
        }
    }
    override fun shouldNotFilter(request: HttpServletRequest)=request.method !in setOf("GET","POST") ||
        !request.requestURI.matches(Regex("/api/v1/practice/sessions/[^/]+/sync-commands(?:/[^/]+)?"))
    override fun doFilterInternal(request: HttpServletRequest,response: HttpServletResponse,chain: FilterChain) {
        val operation=if(request.method=="POST") "submit" else "query"
        val semaphore=permits.getValue(operation)
        if(!semaphore.tryAcquire()) {
            rejected.getValue(operation).increment()
            errors.write(request,response,ApiException(HttpStatus.SERVICE_UNAVAILABLE,"SYNC_BUSY","已保存在本机，可继续练习",details=ErrorDetails(retryAfterSeconds=10)),recordFailure=false)
            return
        }
        try { chain.doFilter(request,response) } finally { semaphore.release() }
    }
}
