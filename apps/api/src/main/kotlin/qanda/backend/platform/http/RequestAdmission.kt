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
class RequestAdmissionFilter(private val errors: ErrorWriter, environment: Environment, registry: MeterRegistry): OncePerRequestFilter() {
    private val capacity=environment.getProperty("qanda.backend.max-concurrent-requests",Int::class.java,32).also { require(it>0) }
    private val permits=Semaphore(capacity)
    private val rejected=registry.counter("qanda.http.overload.rejections")
    init { registry.gauge("qanda.http.inflight",permits) { (capacity-it.availablePermits()).toDouble() } }

    override fun shouldNotFilter(request: HttpServletRequest)=!request.requestURI.startsWith("/api/v1/") || request.requestURI=="/api/v1/health"

    override fun doFilterInternal(request: HttpServletRequest,response: HttpServletResponse,chain: FilterChain) {
        if(!permits.tryAcquire()) {
            rejected.increment()
            // Entry rejection must stay independent of the database it protects.
            errors.write(request,response,ApiException(HttpStatus.SERVICE_UNAVAILABLE,"SERVER_BUSY","服务繁忙，请稍后重试",details=ErrorDetails(retryAfterSeconds=1)),recordFailure=false)
            return
        }
        try { chain.doFilter(request,response) } finally { permits.release() }
    }
}
