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
