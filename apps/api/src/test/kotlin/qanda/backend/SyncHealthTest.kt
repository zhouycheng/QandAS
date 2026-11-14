package qanda.backend

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.core.RowMapper
import org.springframework.mock.env.MockEnvironment
import qanda.backend.monitoring.EndpointHealth
import qanda.backend.monitoring.SyncHealth
import java.net.InetSocketAddress
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

class SyncHealthTest {
    @Test fun `admission metrics do not interrupt endpoint and sync sampling`() {
        val json=jacksonObjectMapper()
        fun metric(name: String,value: String,labels: Map<String,String> = emptyMap())=
            mapOf("metric" to (mapOf("__name__" to name)+labels),"value" to listOf(0,value))
        val route=mapOf("method" to "GET","uri" to "/api/v1/health")
        val other=mapOf("method" to "POST","uri" to "/api/v1/practice/sessions/{id}/sync-commands")
        val body=json.writeValueAsBytes(mapOf("status" to "success","data" to mapOf("result" to listOf(
            metric("up","1",mapOf("job" to "rabbitmq")),
            metric("qanda_sync_ready","0"),metric("qanda_sync_scrape_age","1"),metric("qanda_sync_samples","12"),
            metric("qanda_http_capacity","16",mapOf("role" to "api")),
            metric("qanda_http_inflight","0",mapOf("role" to "api")),
            metric("qanda_http_queue_wait_seconds_count","0",mapOf("role" to "api")),
            metric("qanda_http_requests","1.5",route),metric("qanda_http_errors","0",route),metric("qanda_http_p95","0.02",route),
            metric("qanda_http_requests","0.5",other),metric("qanda_http_future_metric","1",mapOf("method" to "GET","uri" to "/unrelated"))
        ))))
        val server=HttpServer.create(InetSocketAddress("127.0.0.1",0),0)
        server.createContext("/api/v1/query") { exchange ->
            exchange.sendResponseHeaders(200,body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            val jdbc=object: JdbcTemplate() {
                override fun queryForMap(sql: String): MutableMap<String,Any> = mutableMapOf("committed" to 0.0)
                override fun queryForList(sql: String): MutableList<MutableMap<String,Any>> = mutableListOf()
                @Suppress("UNCHECKED_CAST")
                override fun <T: Any?> queryForObject(sql: String,rowMapper: RowMapper<T>): T? = (0L to 0L) as T
            }
            val now=Instant.parse("2026-11-14T00:00:00Z")
            val health=SyncHealth(json,jdbc,MockEnvironment().withProperty("qanda.backend.prometheus-url","http://127.0.0.1:${server.address.port}"),Clock.fixed(now,ZoneOffset.UTC))
            health.sample()
            val result=health.health()
            assertEquals("HEALTHY",result.sync.status)
            assertEquals(now,result.sampledAt)
            assertEquals(listOf(EndpointHealth("GET","/api/v1/health",1.5,0.0,0.02),EndpointHealth("POST",other.getValue("uri"),0.5,null,null)),result.endpoints)
            assertEquals(0L,result.activityPending)
            assertEquals(0L,result.mailPending)
        } finally { server.stop(0) }
    }
}
