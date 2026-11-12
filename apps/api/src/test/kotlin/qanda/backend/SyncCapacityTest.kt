package qanda.backend

import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.core.RowMapper
import org.springframework.mock.env.MockEnvironment
import qanda.backend.sync.api.SyncCapacity
import qanda.backend.platform.http.ApiException
import java.time.*

class SyncCapacityTest {
    @Test fun `backlog admission uses hysteresis and rejects stale or missing samples`() {
        var now=100000L;var count=0L;var bytes=0L;var unavailable=false
        val clock=object: Clock() { override fun getZone()=ZoneOffset.UTC;override fun withZone(zone: ZoneId)=this;override fun instant()=Instant.ofEpochMilli(now) }
        val jdbc=object: JdbcTemplate() {
            @Suppress("UNCHECKED_CAST")
            override fun <T: Any?> queryForObject(sql: String,rowMapper: RowMapper<T>): T? {
                if(unavailable) throw IllegalStateException("offline")
                return SyncCapacity.Backlog(count,bytes,0.0) as T
            }
        }
        val capacity=SyncCapacity(jdbc,clock,MockEnvironment().withProperty("qanda.backend.sync-backlog-count","4").withProperty("qanda.backend.sync-backlog-bytes","100"),SimpleMeterRegistry())
        assertThrows(ApiException::class.java) { capacity.requireRoom() }
        capacity.refresh();capacity.requireRoom()
        count=4;capacity.refresh();assertThrows(ApiException::class.java) { capacity.requireRoom() }
        count=2;capacity.refresh();assertThrows(ApiException::class.java) { capacity.requireRoom() }
        count=1;capacity.refresh();capacity.requireRoom()
        unavailable=true;now+=15001;capacity.refresh();assertThrows(ApiException::class.java) { capacity.requireRoom() }
        unavailable=false;bytes=100;capacity.refresh();assertThrows(ApiException::class.java) { capacity.requireRoom() }
        bytes=0;capacity.refresh();capacity.requireRoom()
    }
}
