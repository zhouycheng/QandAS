package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.mockito.Mockito.*
import org.springframework.web.socket.*
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import qanda.backend.application.PracticeSocket
import qanda.backend.identity.Sessions
import qanda.backend.platform.security.Actor
import qanda.backend.practice.*
import java.time.Clock
import java.util.UUID
import java.util.concurrent.*

class PracticeSocketTest {
    @Test fun `bind response precedes concurrent drain notification and binding is not repeated`() {
        val practice=mock(PracticeService::class.java);val presence=mock(WriterPresence::class.java)
        val json=jacksonObjectMapper();val socket=PracticeSocket(practice,presence,mock(Sessions::class.java),json,Clock.systemUTC(),io.micrometer.core.instrument.simple.SimpleMeterRegistry())
        val session=mock(WebSocketSession::class.java);val id=UUID.randomUUID();val device=UUID.randomUUID();val token=UUID.randomUUID()
        val actor=Actor(UUID.randomUUID(),UUID.randomUUID(),"USER","MINI_PROGRAM")
        `when`(session.id).thenReturn("connection");`when`(session.isOpen).thenReturn(true)
        `when`(session.attributes).thenReturn(mutableMapOf("actor" to actor,"practice" to id,"device" to device))
        val entered=CountDownLatch(1);val finish=CountDownLatch(1);val messages=CopyOnWriteArrayList<String>()
        `when`(practice.connectWriter(actor,id,device,token,1)).thenAnswer { entered.countDown();check(finish.await(5,TimeUnit.SECONDS));WriterStatusView("IN_PROGRESS",WriterView(device,token,1,0,1),null) }
        doAnswer { call -> messages.add(json.readTree((call.arguments[0] as TextMessage).payload)["type"].asText());null }.`when`(session).sendMessage(any(WebSocketMessage::class.java))
        socket.afterConnectionEstablished(session)
        val pool=Executors.newFixedThreadPool(2)
        try {
            val bind=TextMessage("""{"type":"BIND","epoch":1,"writerToken":"$token"}""")
            val binding=pool.submit { socket.handleMessage(session,bind) }
            assertTrue(entered.await(5,TimeUnit.SECONDS))
            val draining=pool.submit { socket.changed(WriterSignal(id,"DRAIN_WRITER",1)) }
            finish.countDown();binding.get(5,TimeUnit.SECONDS);draining.get(5,TimeUnit.SECONDS)
            assertEquals(listOf("BOUND","DRAIN_WRITER"),messages)
            socket.handleMessage(session,bind)
            verify(practice,times(1)).connectWriter(actor,id,device,token,1)
            verify(session).close(CloseStatus.POLICY_VIOLATION)
        } finally { finish.countDown();pool.shutdownNow() }
    }
}
