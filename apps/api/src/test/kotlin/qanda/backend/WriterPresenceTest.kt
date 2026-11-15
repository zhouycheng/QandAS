package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.springframework.context.ApplicationEventPublisher
import qanda.backend.practice.WriterPresence
import java.time.*
import java.util.UUID

class WriterPresenceTest {
    private class Time: Clock() {
        var now=Instant.parse("2026-11-16T00:00:00Z")
        override fun getZone()=ZoneOffset.UTC
        override fun withZone(zone: ZoneId): Clock=this
        override fun instant()=now
    }
    @Test fun `restart grace leases and stale tokens never authorize early takeover`() {
        val clock=Time();val presence=WriterPresence(clock,ApplicationEventPublisher {},io.micrometer.core.instrument.simple.SimpleMeterRegistry())
        val id=UUID.randomUUID();val old=UUID.randomUUID();val next=UUID.randomUUID()
        assertTrue(presence.active(id,old))
        clock.now=clock.now.plusSeconds(40);assertFalse(presence.active(id,old))
        presence.open(id,old);clock.now=clock.now.plusSeconds(30);assertTrue(presence.renew(id,old))
        clock.now=clock.now.plusSeconds(39);assertTrue(presence.active(id,old))
        clock.now=clock.now.plusSeconds(1);assertFalse(presence.active(id,old))
        presence.open(id,next);assertFalse(presence.renew(id,old));assertTrue(presence.active(id,next))
        presence.signal(id,"WRITER_CHANGED",2);assertFalse(presence.renew(id,next))
    }
}
