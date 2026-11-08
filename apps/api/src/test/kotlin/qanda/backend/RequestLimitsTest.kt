package qanda.backend

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import jakarta.servlet.Filter
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.beans.factory.support.DefaultListableBeanFactory
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Import
import org.springframework.http.HttpStatus
import org.springframework.mock.env.MockEnvironment
import org.springframework.mock.web.MockServletContext
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.test.web.servlet.setup.DefaultMockMvcBuilder
import org.springframework.web.bind.annotation.*
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext
import org.springframework.web.servlet.config.annotation.EnableWebMvc
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import qanda.backend.platform.security.*
import java.util.UUID

class RequestLimitsTest {
    @Configuration @EnableWebMvc @EnableWebSecurity
    @Import(PlatformSecurity::class,Probe::class)
    class Config {
        @Bean fun sessions(): Sessions = mock(Sessions::class.java).also { sessions ->
            val actor=Actor(UUID.randomUUID(),UUID.randomUUID(),"USER","MINI_PROGRAM")
            `when`(sessions.authenticate("valid")).thenReturn(actor)
            `when`(sessions.authenticate("invalid")).thenThrow(ApiException(HttpStatus.UNAUTHORIZED,"UNAUTHENTICATED","会话无效"))
            `when`(sessions.current()).thenAnswer {
                SecurityContextHolder.getContext().authentication?.principal as? Actor
                    ?: throw ApiException(HttpStatus.UNAUTHORIZED,"UNAUTHENTICATED","请先登录")
            }
        }
        @Bean fun errors()=ErrorWriter(jacksonObjectMapper(),DefaultListableBeanFactory().getBeanProvider(AuditFailures::class.java))
    }
    @RestController class Probe {
        @GetMapping("/api/v1/health","/api/v1/me","/api/v1/admin/probe") fun read()=mapOf("ok" to true)
        @PostMapping("/api/v1/me/probe") fun write()=mapOf("ok" to true)
    }
    private fun withMvc(enabled: Boolean?=null,peerBudget: Int=100,test: (MockMvc)->Unit) {
        val env=MockEnvironment().withProperty("qanda.backend.request-limits.anonymous-per-peer",peerBudget.toString())
            .withProperty("qanda.backend.request-limits.read-per-account","2")
            .withProperty("qanda.backend.request-limits.write-per-account","2")
        enabled?.let { env.setProperty("qanda.backend.request-limits.enabled",it.toString()) }
        val ctx=AnnotationConfigWebApplicationContext().apply { environment=env;servletContext=MockServletContext();register(Config::class.java);refresh() }
        try {
            val mvc=MockMvcBuilders.webAppContextSetup(ctx).addFilters<DefaultMockMvcBuilder>(RequestLimitFilter(ctx.getBean(ErrorWriter::class.java),env),ctx.getBean("springSecurityFilterChain",Filter::class.java)).build()
            test(mvc)
        } finally { ctx.close() }
    }
    @Test fun `source limit is enabled by default and returns retry after`() = withMvc(peerBudget=2) { mvc ->
        repeat(2) { assertEquals(200,mvc.perform(get("/api/v1/health")).andReturn().response.status) }
        val response=mvc.perform(get("/api/v1/health")).andReturn().response
        assertEquals(429,response.status);assertEquals("60",response.getHeader("Retry-After"))
    }
    @Test fun `account read and write budgets are independent`() = withMvc { mvc ->
        repeat(2) { assertEquals(200,mvc.perform(get("/api/v1/me").header("Authorization","Bearer valid")).andReturn().response.status) }
        assertEquals(429,mvc.perform(get("/api/v1/me").header("Authorization","Bearer valid")).andReturn().response.status)
        repeat(2) { assertEquals(200,mvc.perform(post("/api/v1/me/probe").header("Authorization","Bearer valid")).andReturn().response.status) }
        assertEquals(429,mvc.perform(post("/api/v1/me/probe").header("Authorization","Bearer valid")).andReturn().response.status)
    }
    @Test fun `disabled limits retain authentication and authorization`() = withMvc(false,1) { mvc ->
        repeat(4) {
            assertEquals(200,mvc.perform(get("/api/v1/me").header("Authorization","Bearer valid")).andReturn().response.status)
            assertEquals(200,mvc.perform(post("/api/v1/me/probe").header("Authorization","Bearer valid")).andReturn().response.status)
        }
        assertEquals(401,mvc.perform(get("/api/v1/me")).andReturn().response.status)
        assertEquals(401,mvc.perform(get("/api/v1/me").header("Authorization","Bearer invalid")).andReturn().response.status)
        assertEquals(403,mvc.perform(get("/api/v1/admin/probe").header("Authorization","Bearer valid")).andReturn().response.status)
    }
}
