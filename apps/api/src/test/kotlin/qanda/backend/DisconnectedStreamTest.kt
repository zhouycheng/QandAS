package qanda.backend

import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.beans.factory.support.StaticListableBeanFactory
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.context.request.async.AsyncRequestNotUsableException
import qanda.backend.platform.http.ApiExceptionHandler
import qanda.backend.platform.security.AuditFailures

class DisconnectedStreamTest {
    @RestController
    class StreamController {
        @GetMapping("/stream") fun stream(): String = throw AsyncRequestNotUsableException("Response already closed")
    }
    @Test fun `closing a stream does not create an internal error or failed business audit`() {
        val audit=mock(AuditFailures::class.java)
        val provider=StaticListableBeanFactory(mapOf("audit" to audit)).getBeanProvider(AuditFailures::class.java)
        val mvc=MockMvcBuilders.standaloneSetup(StreamController()).setControllerAdvice(ApiExceptionHandler(provider)).build()
        mvc.perform(get("/stream")).andExpect(status().isOk)
        verifyNoInteractions(audit)
    }
}
