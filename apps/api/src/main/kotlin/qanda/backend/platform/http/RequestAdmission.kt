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
import java.util.concurrent.TimeUnit

@Component
@Order(Ordered.HIGHEST_PRECEDENCE+4)
@ConditionalOnWebApplication(type=ConditionalOnWebApplication.Type.SERVLET)
class RequestAdmissionFilter(private val errors: ErrorWriter, environment: Environment, registry: MeterRegistry): OncePerRequestFilter() {
    private val capacity=environment.getProperty("qanda.backend.max-concurrent-requests",Int::class.java,32).also { require(it>0) }
    private val queueCapacity=environment.getProperty("qanda.backend.request-queue-capacity",Int::class.java,64).also { require(it>=0) }
    private val waitMillis=environment.getProperty("qanda.backend.request-queue-wait-ms",Long::class.java,100L).also { require(it in 0..1000) }
    private val permits=Semaphore(capacity,true)
    private val waiting=Semaphore(queueCapacity)
    private val rejected=registry.counter("qanda.http.overload.rejections")
    private val queueTime=registry.timer("qanda.http.queue.wait")
    init {
        registry.gauge("qanda.http.capacity",this) { it.capacity.toDouble() }
        registry.gauge("qanda.http.queue.capacity",this) { it.queueCapacity.toDouble() }
        registry.gauge("qanda.http.queue.wait.limit",this) { it.waitMillis.toDouble() }
        registry.gauge("qanda.http.inflight",permits) { (capacity-it.availablePermits()).toDouble() }
        registry.gauge("qanda.http.queued",waiting) { (queueCapacity-it.availablePermits()).toDouble() }
    }

    override fun shouldNotFilter(request: HttpServletRequest)=!request.requestURI.startsWith("/api/v1/") || request.requestURI=="/api/v1/health"

    override fun doFilterInternal(request: HttpServletRequest,response: HttpServletResponse,chain: FilterChain) {
        val admitted=try {
            if(permits.tryAcquire(0,TimeUnit.MILLISECONDS)) true
            else if(waitMillis==0L || !waiting.tryAcquire()) false
            else {
                val start=System.nanoTime()
                try { permits.tryAcquire(waitMillis,TimeUnit.MILLISECONDS) }
                finally { queueTime.record(System.nanoTime()-start,TimeUnit.NANOSECONDS);waiting.release() }
            }
        } catch(_: InterruptedException) { Thread.currentThread().interrupt();false }
        if(!admitted) {
            rejected.increment()
            // Entry rejection must stay independent of the database it protects.
            errors.write(request,response,ApiException(HttpStatus.SERVICE_UNAVAILABLE,"SERVER_BUSY","服务繁忙，请稍后重试",details=ErrorDetails(retryAfterSeconds=1)),recordFailure=false)
            return
        }
        try { chain.doFilter(request,response) } finally { permits.release() }
    }
}
