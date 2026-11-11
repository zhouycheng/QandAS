package qanda.backend

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import jakarta.servlet.FilterChain
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.beans.factory.support.StaticListableBeanFactory
import org.springframework.http.HttpStatus
import org.springframework.mock.env.MockEnvironment
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import qanda.backend.platform.http.*
import qanda.backend.platform.security.AuditFailures
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class RequestAdmissionTest {
    private class Fixture(capacity: Int=1,queue: Int=0,wait: Long=0) {
        val audit=mock(AuditFailures::class.java)
        val errors=ErrorWriter(jacksonObjectMapper(),StaticListableBeanFactory(mapOf("audit" to audit)).getBeanProvider(AuditFailures::class.java))
        val registry=SimpleMeterRegistry()
        val filter=RequestAdmissionFilter(errors,MockEnvironment().withProperty("qanda.backend.max-concurrent-requests",capacity.toString())
            .withProperty("qanda.backend.request-queue-capacity",queue.toString()).withProperty("qanda.backend.request-queue-wait-ms",wait.toString()),registry)
        fun request(path: String="/api/v1/me")=MockHttpServletRequest("GET",path)
    }

    @Test fun `busy requests fail before database audit and capacity becomes reusable`() {
        val f=Fixture();val entered=CountDownLatch(1);val release=CountDownLatch(1);val pool=Executors.newSingleThreadExecutor()
        val first=pool.submit { f.filter.doFilter(f.request(),MockHttpServletResponse(),FilterChain { _,_ -> entered.countDown();check(release.await(5,TimeUnit.SECONDS)) }) }
        try {
            assertTrue(entered.await(5,TimeUnit.SECONDS))
            assertEquals(1.0,f.registry.get("qanda.http.inflight").gauge().value())
            val response=MockHttpServletResponse()
            f.filter.doFilter(f.request(),response,FilterChain { _,_ -> fail<Unit>("Rejected requests must not reach authentication or business handlers") })
            assertEquals(503,response.status);assertEquals("1",response.getHeader("Retry-After"))
            assertEquals("no-store",response.getHeader("Cache-Control"));assertNotNull(response.getHeader("X-Request-Id"))
            assertEquals("SERVER_BUSY",jacksonObjectMapper().readTree(response.contentAsString)["code"].asText())
            assertEquals(1.0,f.registry.get("qanda.http.overload.rejections").counter().count())
            verifyNoInteractions(f.audit)
        } finally { release.countDown();try { first.get(5,TimeUnit.SECONDS) } finally { pool.shutdownNow() } }
        var served=false
        f.filter.doFilter(f.request(),MockHttpServletResponse(),FilterChain { _,_ -> served=true })
        assertTrue(served);assertEquals(0.0,f.registry.get("qanda.http.inflight").gauge().value())
    }

    @Test fun `handler exceptions release the admission permit`() {
        val f=Fixture()
        assertThrows(IllegalStateException::class.java) { f.filter.doFilter(f.request(),MockHttpServletResponse(),FilterChain { _,_ -> error("handler failed") }) }
        var served=false
        f.filter.doFilter(f.request(),MockHttpServletResponse(),FilterChain { _,_ -> served=true })
        assertTrue(served);assertEquals(0.0,f.registry.get("qanda.http.inflight").gauge().value())
    }

    @Test fun `short bursts wait within the bounded queue and reuse released capacity`() {
        val f=Fixture(queue=1,wait=1000);val firstEntered=CountDownLatch(1);val release=CountDownLatch(1);val pool=Executors.newFixedThreadPool(2)
        val first=pool.submit { f.filter.doFilter(f.request(),MockHttpServletResponse(),FilterChain { _,_ -> firstEntered.countDown();check(release.await(5,TimeUnit.SECONDS)) }) }
        try {
            assertTrue(firstEntered.await(5,TimeUnit.SECONDS))
            val response=MockHttpServletResponse();val served=CountDownLatch(1)
            val queued=pool.submit { f.filter.doFilter(f.request(),response,FilterChain { _,_ -> served.countDown() }) }
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2)
            while(f.registry.get("qanda.http.queued").gauge().value()==0.0 && System.nanoTime()<deadline) Thread.yield()
            assertEquals(1.0,f.registry.get("qanda.http.queued").gauge().value())
            val excess=MockHttpServletResponse()
            f.filter.doFilter(f.request(),excess,FilterChain { _,_ -> fail<Unit>("The waiting queue must remain bounded") })
            assertEquals(503,excess.status)
            release.countDown();first.get(5,TimeUnit.SECONDS);queued.get(5,TimeUnit.SECONDS)
            assertTrue(served.await(1,TimeUnit.SECONDS));assertEquals(200,response.status)
            assertEquals(0.0,f.registry.get("qanda.http.queued").gauge().value());assertEquals(0.0,f.registry.get("qanda.http.inflight").gauge().value())
        } finally { release.countDown();pool.shutdownNow() }
    }

    @Test fun `waiting requests expire and interrupted waiters release their queue slot`() {
        val f=Fixture(queue=1,wait=20)
        f.filter.doFilter(f.request(),MockHttpServletResponse(),FilterChain { _,_ ->
            val response=MockHttpServletResponse();val start=System.nanoTime()
            f.filter.doFilter(f.request(),response,FilterChain { _,_ -> fail<Unit>("Expired work must not enter the handler") })
            assertEquals(503,response.status);assertTrue(System.nanoTime()-start>=TimeUnit.MILLISECONDS.toNanos(15))
            assertEquals(0.0,f.registry.get("qanda.http.queued").gauge().value())
        })
        Thread.currentThread().interrupt()
        try {
            val response=MockHttpServletResponse();f.filter.doFilter(f.request(),response,FilterChain { _,_ -> fail<Unit>("Interrupted work must not enter the handler") })
            assertEquals(503,response.status);assertTrue(Thread.currentThread().isInterrupted)
        } finally { Thread.interrupted() }
        assertEquals(0.0,f.registry.get("qanda.http.inflight").gauge().value())
    }

    @Test fun `health and management probes remain available while business capacity is occupied`() {
        val f=Fixture()
        f.filter.doFilter(f.request(),MockHttpServletResponse(),FilterChain { _,_ ->
            for(path in listOf("/api/v1/health","/actuator/health/readiness","/actuator/prometheus")) {
                var probed=false
                f.filter.doFilter(f.request(path),MockHttpServletResponse(),FilterChain { _,_ -> probed=true })
                assertTrue(probed)
            }
            assertEquals(1.0,f.registry.get("qanda.http.inflight").gauge().value())
        })
        assertEquals(0.0,f.registry.get("qanda.http.overload.rejections").counter().count())
    }

    @Test fun `source IP rejection preserves retry guidance without opening an audit transaction`() {
        val f=Fixture();val limit=RequestLimitFilter(f.errors,MockEnvironment().withProperty("qanda.backend.request-limits.anonymous-per-peer","1"))
        limit.doFilter(f.request(),MockHttpServletResponse(),FilterChain { _,_ -> })
        val response=MockHttpServletResponse()
        limit.doFilter(f.request(),response,FilterChain { _,_ -> fail<Unit>("Over-budget requests must stop at the source filter") })
        assertEquals(429,response.status);assertEquals("60",response.getHeader("Retry-After"));verifyNoInteractions(f.audit)
    }

    @Test fun `ordinary failure auditing stays enabled`() {
        val f=Fixture();val request=f.request()
        f.errors.write(request,MockHttpServletResponse(),ApiException(HttpStatus.UNAUTHORIZED,"UNAUTHENTICATED","请先登录"))
        verify(f.audit).record(request,"UNAUTHENTICATED")
    }

    @Test fun `nonpositive request capacity is rejected at startup`() {
        assertThrows(IllegalArgumentException::class.java) { Fixture(0) }
        assertThrows(IllegalArgumentException::class.java) { Fixture(queue=-1) }
        assertThrows(IllegalArgumentException::class.java) { Fixture(wait=1001) }
    }
}
