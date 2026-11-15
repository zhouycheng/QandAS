package qanda.backend

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import jakarta.servlet.FilterChain
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.beans.factory.support.StaticListableBeanFactory
import org.springframework.mock.env.MockEnvironment
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import qanda.backend.platform.http.*
import qanda.backend.platform.security.AuditFailures

class SyncAdmissionTest {
    @Test fun `short sync bursts wait in bounded slots without increasing active database work`() {
        val meters=SimpleMeterRegistry();val audit=mock(AuditFailures::class.java)
        val filter=SyncAdmission(ErrorWriter(jacksonObjectMapper(),StaticListableBeanFactory(mapOf("audit" to audit)).getBeanProvider(AuditFailures::class.java)),
            MockEnvironment().withProperty("spring.datasource.hikari.maximum-pool-size","2").withProperty("qanda.backend.request-queue-wait-ms","1000"),meters)
        fun request()=MockHttpServletRequest("GET","/api/v1/practice/sessions/session/sync-commands/command")
        val pool=java.util.concurrent.Executors.newFixedThreadPool(3);val entered=java.util.concurrent.CountDownLatch(1);val release=java.util.concurrent.CountDownLatch(1)
        val first=pool.submit { filter.doFilter(request(),MockHttpServletResponse(),FilterChain { _,_ -> entered.countDown();check(release.await(5,java.util.concurrent.TimeUnit.SECONDS)) }) }
        try {
            assertTrue(entered.await(5,java.util.concurrent.TimeUnit.SECONDS))
            val responses=List(2) { MockHttpServletResponse() }
            val queued=responses.map { response -> pool.submit { filter.doFilter(request(),response,FilterChain { _,_ -> }) } }
            val end=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(2)
            while(meters.get("qanda.sync.http.queued").tag("operation","query").gauge().value()<2.0 && System.nanoTime()<end) Thread.yield()
            assertEquals(2.0,meters.get("qanda.sync.http.queued").tag("operation","query").gauge().value())
            assertEquals(1.0,meters.get("qanda.sync.http.inflight").tag("operation","query").gauge().value())
            val excess=MockHttpServletResponse();filter.doFilter(request(),excess,FilterChain { _,_ -> fail<Unit>("Queue exceeded") });assertEquals(503,excess.status)
            release.countDown();first.get(5,java.util.concurrent.TimeUnit.SECONDS);queued.forEach { it.get(5,java.util.concurrent.TimeUnit.SECONDS) }
            assertTrue(responses.all { it.status==200 })
            assertEquals(0.0,meters.get("qanda.sync.http.queued").tag("operation","query").gauge().value())
            assertEquals(0.0,meters.get("qanda.sync.http.inflight").tag("operation","query").gauge().value());verifyNoInteractions(audit)
        } finally { release.countDown();pool.shutdownNow() }
    }

    @Test fun `submit and both recovery queries have independent reusable budgets`() {
        val audit=mock(AuditFailures::class.java);val meters=SimpleMeterRegistry()
        val filter=SyncAdmission(ErrorWriter(jacksonObjectMapper(),StaticListableBeanFactory(mapOf("audit" to audit)).getBeanProvider(AuditFailures::class.java)),
            MockEnvironment().withProperty("spring.datasource.hikari.maximum-pool-size","2"),meters)
        fun request(method: String,suffix: String="")=MockHttpServletRequest(method,"/api/v1/practice/sessions/session/sync-commands$suffix")
        filter.doFilter(request("POST"),MockHttpServletResponse(),FilterChain { _,_ ->
            val full=MockHttpServletResponse()
            filter.doFilter(request("POST"),full,FilterChain { _,_ -> fail<Unit>("Submit budget exceeded") })
            assertEquals(503,full.status);assertEquals("10",full.getHeader("Retry-After"))
            filter.doFilter(request("GET"),MockHttpServletResponse(),FilterChain { _,_ ->
                val queryFull=MockHttpServletResponse()
                filter.doFilter(request("GET","/command"),queryFull,FilterChain { _,_ -> fail<Unit>("Queries must share their own budget") })
                assertEquals(503,queryFull.status)
            })
        })
        assertThrows(IllegalStateException::class.java) {
            filter.doFilter(request("GET","/command"),MockHttpServletResponse(),FilterChain { _,_ -> error("handler failed") })
        }
        for(method in listOf("POST","GET")) {
            var served=false
            filter.doFilter(request(method),MockHttpServletResponse(),FilterChain { _,_ -> served=true })
            assertTrue(served)
        }
        for(operation in listOf("submit","query")) {
            assertEquals(0.0,meters.get("qanda.sync.http.inflight").tag("operation",operation).gauge().value())
            assertEquals(1.0,meters.get("qanda.sync.concurrent.rejections").tag("operation",operation).counter().count())
        }
        verifyNoInteractions(audit)
    }
}
