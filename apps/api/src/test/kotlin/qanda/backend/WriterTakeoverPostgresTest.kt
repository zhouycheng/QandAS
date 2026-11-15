package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.context.annotation.Primary
import qanda.backend.practice.WriterPresence
import qanda.backend.application.ProgressEnvelope
import java.time.*
import java.util.UUID

@Import(WriterTakeoverPostgresTest.TimeConfiguration::class)
class WriterTakeoverPostgresTest: PostgresFixture() {
    class Time: Clock() {
        @Volatile var now=Instant.now()
        override fun getZone()=ZoneOffset.UTC
        override fun withZone(zone: ZoneId): Clock=this
        override fun instant()=now
    }
    @TestConfiguration class TimeConfiguration { @Bean @Primary fun writerTime()=Time() }
    @Autowired lateinit var time: Time
    @Autowired lateinit var practice: qanda.backend.practice.PracticeService
    @Autowired lateinit var presence: WriterPresence
    @Autowired lateinit var capacity: qanda.backend.sync.api.SyncCapacity
    @org.junit.jupiter.api.BeforeEach fun refreshBudget() { capacity.refresh() }

    @Test fun `expired offline writer is sealed while accepted work drains before exclusive takeover`() {
        val owner=student();val session=createPractice(owner,fixture());val sid=id(session);val root="/practice/sessions/$sid"
        val token=UUID.fromString(session["writer"]["writerToken"].asText())
        presence.open(sid,token)
        val device=UUID.randomUUID();val nextToken=loginDevice(owner,device)
        val input=mapOf("expectedEpoch" to 1,"deviceId" to device)
        consumers.stop()
        try {
            val key=UUID.randomUUID();val waiting=call("POST","$root/claim-writer",input,nextToken,key=key)
            assertEquals("WAITING",waiting["state"].asText())
            val command=UUID.randomUUID();call("POST","$root/sync-commands",progressBody(session),owner.token,202,command)
            time.now=time.now.plusSeconds(41)
            capacity.refresh()
            val draining=call("GET","$root/writer-state?deviceId=$device",token=nextToken)
            assertEquals("WAITING",draining["transfer"]["state"].asText())
            assertTrue(jdbc.queryForObject("SELECT writer_sealed FROM practice_sync_state WHERE session_id=?",Boolean::class.java,sid)!!)
            call("POST","$root/sync-commands",progressBody(session)+mapOf("clientSequence" to 2),owner.token,409)
            progressCommands.consume(ProgressEnvelope(command))
            assertEquals("COMMITTED",jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,command))
            val ready=call("GET","$root/writer-state?deviceId=$device",token=nextToken)
            assertEquals("READY",ready["transfer"]["state"].asText());assertEquals(1,ready["writer"]["acknowledgedSequence"].asInt())
            assertNotEquals(token.toString(),ready["writer"]["writerToken"].asText())
            assertEquals(4,jdbc.queryForObject("SELECT count(*) FROM practice_item WHERE session_id=? AND confirmed AND marked",Int::class.java,sid))
            assertEquals(waiting,call("POST","$root/claim-writer",input,nextToken,key=key),"丢响应重放不重新分配凭证")
        } finally { consumers.start() }
    }

    @Test fun `expired request leaves the original writer resumable and finish has precedence`() {
        val owner=student();val session=createPractice(owner,fixture());val sid=id(session);val root="/practice/sessions/$sid"
        val writer=UUID.fromString(session["writer"]["writerToken"].asText());presence.open(sid,writer)
        val device=UUID.randomUUID();val nextToken=loginDevice(owner,device)
        call("POST","$root/claim-writer",mapOf("expectedEpoch" to 1,"deviceId" to device),nextToken)
        time.now=time.now.plusSeconds(61)
        capacity.refresh()
        val ownerDevice=UUID.fromString(session["writer"]["deviceId"].asText())
        val resumed=practice.connectWriter(sessionService.authenticate(owner.token),sid,ownerDevice,writer,1)
        assertFalse(resumed.draining,"原端重连时先处理已超时的接续申请")
        val expired=call("GET","$root/writer-state?deviceId=$device",token=nextToken)
        assertEquals("EXPIRED",expired["transfer"]["state"].asText());assertEquals(1,expired["writer"]["epoch"].asInt())
        assertFalse(jdbc.queryForObject("SELECT writer_sealed FROM practice_sync_state WHERE session_id=?",Boolean::class.java,sid)!!)
        consumers.stop()
        try {
            call("POST","$root/sync-commands",progressBody(session)+mapOf("kind" to "FINISH"),owner.token,202)
            call("POST","$root/claim-writer",mapOf("expectedEpoch" to 1,"deviceId" to device),nextToken,409)
        } finally { consumers.start() }
    }
}
