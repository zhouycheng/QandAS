package qanda.backend

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.*
import org.junit.jupiter.api.Assertions.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.containers.GenericContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.utility.MountableFile
import qanda.backend.admin.*
import qanda.backend.identity.*
import qanda.backend.platform.mail.*
import java.net.URI
import java.net.http.*
import java.nio.file.Files
import java.nio.file.Path
import java.time.*
import java.util.Base64
import java.util.UUID
import java.util.concurrent.Executors
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO

@Tag("postgres")
@Testcontainers
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
@org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class PlatformPostgresTest {
    companion object {
        private val queueNetwork=org.testcontainers.containers.Network.newNetwork()
        @Container @JvmField val postgres=PostgreSQLContainer<Nothing>("postgres:17.6-alpine").apply {
            withDatabaseName("qanda_backend");withUsername("qanda_backend");withPassword("isolated-test-password")
            withCopyFileToContainer(MountableFile.forClasspathResource("db/schema.sql"),"/docker-entrypoint-initdb.d/schema.sql")
            withCopyFileToContainer(MountableFile.forClasspathResource("db/monitoring-permissions.sql"),"/docker-entrypoint-initdb.d/z-monitoring-permissions.sql")
        }
        @Container @JvmField val mailpit=GenericContainer<Nothing>("axllent/mailpit:v1.32.0").apply { withExposedPorts(1025,8025) }
        @Container @JvmField val rabbit=GenericContainer<Nothing>("rabbitmq:4.2.5-management").apply {
            withNetwork(queueNetwork);withNetworkAliases("rabbitmq")
            withEnv("RABBITMQ_DEFAULT_USER","qanda");withEnv("RABBITMQ_DEFAULT_PASS","isolated-queue-password")
            withExposedPorts(5672,15672,15692)
            withCopyFileToContainer(MountableFile.forHostPath(Path.of("monitoring/rabbitmq-plugins")),"/etc/rabbitmq/enabled_plugins")
            waitingFor(org.testcontainers.containers.wait.strategy.Wait.forLogMessage(".*Server startup complete.*",1))
        }
        @Container @JvmField val prometheus=GenericContainer<Nothing>("prom/prometheus:v3.5.0").apply {
            withNetwork(queueNetwork);withExposedPorts(9090)
            withCopyToContainer(org.testcontainers.images.builder.Transferable.of("""
                global:
                  scrape_interval: 5s
                  evaluation_interval: 5s
                rule_files: [/etc/prometheus/sync-rules.yml]
                scrape_configs:
                  - job_name: rabbitmq
                    metrics_path: /metrics/detailed
                    params:
                      family: [queue_coarse_metrics, queue_delivery_metrics, queue_consumer_count, queue_exchange_metrics]
                    static_configs:
                      - targets: ['rabbitmq:15692']
            """.trimIndent()),"/etc/prometheus/prometheus.yml")
            withCopyFileToContainer(MountableFile.forHostPath(Path.of("monitoring/sync-rules.yml")),"/etc/prometheus/sync-rules.yml")
        }
        private val assetRoot=Files.createTempDirectory("qanda-v1-assets-")
        private val key=Base64.getEncoder().encodeToString(ByteArray(32) { 13 })
        @JvmStatic @DynamicPropertySource fun properties(r: DynamicPropertyRegistry) {
            postgres.start();mailpit.start();rabbit.start();prometheus.start()
            r.add("qanda.backend.prometheus-url") { "http://${prometheus.host}:${prometheus.getMappedPort(9090)}" }
            r.add("spring.rabbitmq.host") { rabbit.host };r.add("spring.rabbitmq.port") { rabbit.getMappedPort(5672) }
            r.add("spring.rabbitmq.username") { "qanda" };r.add("spring.rabbitmq.password") { "isolated-queue-password" }
            r.add("qanda.backend.role") { "all" };r.add("qanda.backend.worker-enabled") { true };r.add("management.server.port") { 0 }
            r.add("spring.datasource.url") { postgres.jdbcUrl };r.add("spring.datasource.username") { postgres.username };r.add("spring.datasource.password") { postgres.password }
            r.add("qanda.backend.mode") { "test" };r.add("server.address") { "127.0.0.1" }
            r.add("BACKEND_WECHAT_PROVIDER") { "local" };r.add("BACKEND_COMMAND_DIGEST_KEYS") { "1:$key" };r.add("BACKEND_IDENTITY_MAC_KEYS") { "1:$key" };r.add("BACKEND_IDENTITY_RATE_KEY") { key }
            r.add("BACKEND_MAIL_ENCRYPTION_KEYS") { "1:$key" };r.add("qanda.backend.mail.enabled") { true };r.add("qanda.backend.mail.transport") { "local-capture" }
            r.add("qanda.backend.mail.host") { "127.0.0.1" };r.add("qanda.backend.mail.port") { mailpit.getMappedPort(1025) };r.add("qanda.backend.mail.dispatch-enabled") { false }
            r.add("qanda.backend.files.enabled") { true };r.add("qanda.backend.files.root") { assetRoot.toString() }
            r.add("springdoc.api-docs.enabled") { true };r.add("springdoc.swagger-ui.enabled") { true }
            r.add("qanda.backend.request-limits.read-per-account") { 100000 };r.add("qanda.backend.request-limits.write-per-account") { 100000 }
        }
    }
    @LocalServerPort var port: Int=0
    @Autowired lateinit var json: ObjectMapper
    @Autowired lateinit var jdbc: JdbcTemplate
    @Autowired lateinit var transactionManager: org.springframework.transaction.PlatformTransactionManager
    @Autowired lateinit var adminService: AdminService
    @Autowired lateinit var mailCrypto: MailCrypto
    @Autowired lateinit var outbox: OutboxService
    @Autowired lateinit var sessionService: Sessions
    @Autowired lateinit var activityProjection: qanda.backend.monitoring.ActivityProjection
    @Autowired lateinit var consumers: org.springframework.amqp.rabbit.listener.RabbitListenerEndpointRegistry
    @Autowired lateinit var progressQueue: qanda.backend.sync.api.ProgressQueue
    @Autowired lateinit var progressCommands: qanda.backend.application.ProgressCommands
    @Autowired lateinit var learningMapper: qanda.backend.learning.LearningMapper
    @Autowired lateinit var activityMapper: qanda.backend.monitoring.ActivityMapper
    @Autowired lateinit var onlineUsers: qanda.backend.monitoring.OnlineUsers
    @Autowired lateinit var syncHealth: qanda.backend.monitoring.SyncHealth
    private val http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    private val exchanges=java.util.concurrent.ConcurrentLinkedQueue<Map<String,Any?>>()
    private lateinit var adminToken: String
    private lateinit var platformId: UUID
    private val password="Learner-password-123"
    private data class Student(val id: UUID,val email: String,val token: String)
    private data class Fixture(val subject: UUID,val bank: UUID,val questions: List<UUID>)

    private fun eventually(seconds: Long=15,condition: () -> Boolean) {
        val end=System.nanoTime()+seconds*1_000_000_000
        while(!condition()) { assertTrue(System.nanoTime()<end,"等待条件超时");Thread.sleep(100) }
    }
    private fun progressBody(session: JsonNode)=mapOf("expectedVersion" to session["version"].asLong(),"currentIndex" to 0,"durationSeconds" to 0,
        "writerToken" to session["writer"]["writerToken"].asText(),"clientSequence" to 1,"items" to answers(session))
    private fun queueCounter(name: String): Double {
        val request=HttpRequest.newBuilder(URI("http://${rabbit.host}:${rabbit.getMappedPort(15692)}/metrics/detailed?family=queue_exchange_metrics&family=queue_delivery_metrics")).GET().build()
        val response=http.send(request,HttpResponse.BodyHandlers.ofString());assertEquals(200,response.statusCode())
        return response.body().lineSequence().filter { it.startsWith(name+"{") && it.contains("queue=\"qanda.sync.progress\"") }.sumOf { it.substringAfterLast(' ').toDouble() }
    }

    @Test fun `broker outage preserves registration while account catalog and announcements remain available`() {
        val s=student();val f=fixture();val session=createPractice(s,f);val sessionId=id(session);val key=UUID.randomUUID();val body=progressBody(session)
        consumers.stop();rabbit.dockerClient.pauseContainerCmd(rabbit.containerId).exec()
        try {
            val sending=java.util.concurrent.CompletableFuture.supplyAsync { raw("POST","/practice/sessions/$sessionId/progress-commands",body,s.token,key) }
            call("GET","/me",token=s.token)
            call("GET","/subjects",token=null)
            call("GET","/announcements",token=s.token)
            assertEquals(503,sending.get(12,java.util.concurrent.TimeUnit.SECONDS).statusCode())
            assertEquals("ACCEPTING",jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,key))
            assertEquals(1,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,sessionId))
        } finally { rabbit.dockerClient.unpauseContainerCmd(rabbit.containerId).exec();consumers.start() }
        call("POST","/practice/sessions/$sessionId/progress-commands",body,s.token,202,key)
        eventually { jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,key)=="COMMITTED" }
        assertEquals(2,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,sessionId))
    }

    @Test fun `announcement query timeout leaves catalog and practice available`() {
        val s=student();val f=fixture();val session=createPractice(s,f)
        jdbc.dataSource!!.connection.use { blocked ->
            blocked.autoCommit=false
            try {
                blocked.createStatement().use { it.execute("LOCK TABLE announcement IN ACCESS EXCLUSIVE MODE") }
                val reading=java.util.concurrent.CompletableFuture.supplyAsync { raw("GET","/announcements",null,s.token) }
                call("GET","/me",token=s.token)
                call("GET","/subjects",token=null)
                call("PUT","/practice/sessions/${id(session)}/progress-ack",progressBody(session),s.token)
                val unavailable=reading.get(10,java.util.concurrent.TimeUnit.SECONDS)
                assertEquals(503,unavailable.statusCode())
                assertEquals("TEMPORARILY_UNAVAILABLE",json.readTree(unavailable.body())["code"].asText())
                assertEquals(2,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,id(session)))
            } finally { blocked.rollback() }
        }
        call("GET","/announcements",token=s.token)
    }

    @Test fun `monitor database role reads public queries and cannot mutate core or projection data`() {
        jdbc.dataSource!!.connection.use { connection ->
            connection.createStatement().use { statement ->
                statement.execute("SET ROLE qanda_monitor")
                try {
                    for(view in listOf("monitoring_student","monitoring_learning","monitoring_jobs","monitoring_sync_completion")) statement.executeQuery("SELECT * FROM $view LIMIT 1").close()
                    statement.executeQuery("SELECT * FROM monitoring_online_at(now()) LIMIT 1").close()
                    for(table in listOf("practice_item","practice_result","question_revision","user_activity","domain_event_outbox","sync_command")) {
                        assertThrows(java.sql.SQLException::class.java) { statement.execute("DELETE FROM $table WHERE false") }
                    }
                } finally { statement.execute("RESET ROLE") }
            }
        }
    }

    @Test fun `independent monitor process uses restricted connections and its exit leaves practice running`() {
        val monitorPort=java.net.ServerSocket(0).use { it.localPort }
        val log=Path.of(".backend-runtime/verification/monitor-runtime.log");Files.createDirectories(log.parent)
        val process=ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-Xmx256m","-jar",Path.of("target/qanda-backend-1.0.0.jar").toAbsolutePath().toString()).apply {
            environment().keys.removeIf { it.startsWith("BACKEND_") || it.startsWith("TENCENT_") }
            environment().putAll(mapOf("BACKEND_MODE" to "test","BACKEND_BIND_ADDRESS" to "127.0.0.1","BACKEND_API_PORT" to monitorPort.toString(),"BACKEND_METRICS_PORT" to "0",
                "BACKEND_DB_URL" to postgres.jdbcUrl,"BACKEND_DB_USER" to postgres.username,"BACKEND_DB_PASSWORD" to postgres.password,"BACKEND_DB_POOL_SIZE" to "2",
                "BACKEND_DB_SESSION_INIT" to "SET ROLE qanda_monitor; SET statement_timeout='3s'","BACKEND_ROLE" to "monitor","BACKEND_MONITORING_ENABLED" to "true",
                "BACKEND_PROMETHEUS_URL" to "http://${prometheus.host}:${prometheus.getMappedPort(9090)}","BACKEND_WECHAT_PROVIDER" to "local","BACKEND_MAIL_ENABLED" to "false","BACKEND_FILES_ENABLED" to "false",
                "BACKEND_COMMAND_DIGEST_KEYS" to "1:$key","BACKEND_IDENTITY_MAC_KEYS" to "1:$key","BACKEND_IDENTITY_RATE_KEY" to key))
            redirectErrorStream(true);redirectOutput(log.toFile())
        }.start()
        fun monitor(path: String): HttpResponse<String> = http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$monitorPort/api/v1$path")).timeout(Duration.ofSeconds(5)).header("Authorization","Bearer $adminToken").GET().build(),HttpResponse.BodyHandlers.ofString())
        try {
            eventually(45) { assertTrue(process.isAlive,"独立监控启动失败，见 monitor-runtime.log");runCatching { monitor("/health").statusCode()==200 }.getOrDefault(false) }
            assertEquals(200,monitor("/admin/statistics/online-users").statusCode())
            assertEquals(200,monitor("/admin/statistics/activity").statusCode())
            assertEquals(200,monitor("/admin/monitoring/health").statusCode())
            val unavailable=monitor("/subjects")
            assertEquals(404,unavailable.statusCode())
            val requestId=UUID.fromString(unavailable.headers().firstValue("X-Request-Id").orElseThrow())
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM audit_log WHERE request_id=?",Int::class.java,requestId))
        } finally { process.destroy();if(!process.waitFor(10,java.util.concurrent.TimeUnit.SECONDS)) process.destroyForcibly() }
        val s=student();val f=fixture();val session=createPractice(s,f)
        call("PUT","/practice/sessions/${id(session)}/progress-ack",progressBody(session),s.token)
        call("GET","/announcements",token=s.token)
    }

    @Test fun `queued commands retain drafts barriers and commit once after delivery and confirm loss`() {
        val s=student();val f=fixture();val session=createPractice(s,f);val sessionId=id(session);val key=UUID.randomUUID();val body=progressBody(session)
        consumers.stop()
        try {
            val pending=call("POST","/practice/sessions/$sessionId/progress-commands",body,s.token,202,key)
            assertEquals("QUEUED",pending["state"].asText());assertTrue(pending["acknowledgement"].isNull)
            assertEquals(1,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,sessionId))
            assertEquals(pending,call("POST","/practice/sessions/$sessionId/progress-commands",body,s.token,202,key))
            call("POST","/practice/sessions/$sessionId/progress-commands",body+mapOf("durationSeconds" to 1),s.token,409,key)
            call("POST","/practice/sessions/$sessionId/progress-commands",body,s.token,409)
            call("POST","/practice/sessions/$sessionId/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to body["writerToken"]),s.token,409)
            call("POST","/practice/sessions/$sessionId/cancel",mapOf("expectedVersion" to 1,"writerToken" to body["writerToken"]),s.token,409)
            call("POST","/practice/sessions/$sessionId/writer-release",mapOf("expectedVersion" to 1,"deviceId" to session["writer"]["deviceId"].asText(),"writerToken" to body["writerToken"],"clientSequence" to 1),s.token,409)
            // A lost publisher confirmation leaves registration pending; the original request is republished.
            jdbc.update("UPDATE sync_command SET state='ACCEPTING' WHERE id=?",key)
            call("POST","/practice/sessions/$sessionId/progress-commands",body,s.token,202,key)
            val envelope=qanda.backend.application.ProgressEnvelope(key,json.convertValue(body,qanda.backend.practice.ProgressInput::class.java))
            progressCommands.consume(envelope)
            assertEquals(2,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,sessionId))
            // Commit happened before ACK; the real queued copies are now redelivered to consumers.
            consumers.start()
            eventually { syncHealth.sample();syncHealth.snapshot().metrics.queued==0.0 }
            progressCommands.consume(envelope)
            val done=call("GET","/practice/sessions/$sessionId/progress-commands/$key",token=s.token)
            assertEquals("COMMITTED",done["state"].asText());assertEquals(1,done["acknowledgement"]["acknowledgedSequence"].asInt())
            assertEquals(2,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,sessionId))
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM command_receipt WHERE command_id=?",Int::class.java,key))
            call("GET","/practice/sessions/$sessionId/progress-commands/$key",token=student().token,status=404)
            call("POST","/practice/sessions/$sessionId/finish",mapOf("expectedVersion" to 2,"durationSeconds" to 0,"writerToken" to body["writerToken"]),s.token)
        } finally { consumers.start() }
    }

    @Test fun `expired credentials reject queued writes and technical failures support reviewed replay`() {
        val s=student();val f=fixture();val session=createPractice(s,f);val sessionId=id(session);val body=progressBody(session);val key=UUID.randomUUID()
        consumers.stop()
        try {
            call("POST","/practice/sessions/$sessionId/progress-commands",body,s.token,202,key)
            repeat(8) { attempt ->
                val result=progressCommands.failure(key,IllegalStateException("test transport failure"))
                assertEquals(if(attempt==7) "dead" else "retry",result.first);assertTrue(result.second<=60000)
            }
            val envelope=qanda.backend.application.ProgressEnvelope(key,json.convertValue(body,qanda.backend.practice.ProgressInput::class.java))
            progressQueue.publish(json.writeValueAsBytes(envelope),key,"dead")
            assertEquals(key.toString(),call("GET","/admin/sync/dead-letters/head")["item"]["commandId"].asText())
            call("POST","/admin/sync/dead-letters/$key/replay",token=s.token,status=403)
            val replayKey=UUID.randomUUID()
            call("POST","/admin/sync/dead-letters/$key/replay",key=replayKey)
            call("POST","/admin/sync/dead-letters/$key/replay",key=replayKey)
            consumers.start()
            eventually { jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,key)=="COMMITTED" }
            assertEquals(2,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,sessionId))
            progressQueue.publish(json.writeValueAsBytes(envelope),key,"dead")
            assertTrue(call("GET","/admin/sync/dead-letters/head")["item"]["reason"].asText().contains("最终回执"))
            call("POST","/admin/sync/dead-letters/$key/replay")
            assertTrue(call("GET","/admin/sync/dead-letters/head")["item"].isNull)
            assertEquals(2,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,sessionId))
            consumers.stop()
            val rejected=createPractice(s,f);val rejectedKey=UUID.randomUUID()
            call("POST","/practice/sessions/${id(rejected)}/progress-commands",progressBody(rejected),s.token,202,rejectedKey)
            jdbc.update("UPDATE user_session SET revoked_at=now() WHERE user_id=?",s.id)
            consumers.start()
            eventually { jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,rejectedKey)=="REJECTED" }
            assertEquals(1,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,id(rejected)))
            assertEquals(401,jdbc.queryForObject("SELECT error_status FROM sync_command WHERE id=?",Int::class.java,rejectedKey))
            consumers.stop()
            val owner=student();val staleWriter=createPractice(owner,f);val staleKey=UUID.randomUUID()
            call("POST","/practice/sessions/${id(staleWriter)}/progress-commands",progressBody(staleWriter),owner.token,202,staleKey)
            jdbc.update("UPDATE practice_sync_state SET writer_token=? WHERE session_id=?",UUID.randomUUID(),id(staleWriter))
            consumers.start()
            eventually { jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,staleKey)=="REJECTED" }
            assertEquals(409,jdbc.queryForObject("SELECT error_status FROM sync_command WHERE id=?",Int::class.java,staleKey))
            assertEquals(1,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,id(staleWriter)))
        } finally { consumers.start() }
    }

    @Test fun `real broker metrics show paused backlog and SSE revokes expired administrators`() {
        val s=student();val f=fixture();val sessions=(1..12).map { createPractice(s,f) }
        consumers.stop()
        val started=System.nanoTime()
        val cpu=java.lang.management.ManagementFactory.getOperatingSystemMXBean() as com.sun.management.OperatingSystemMXBean
        val cpuBefore=cpu.processCpuTime
        val producedBefore=queueCounter("rabbitmq_detailed_queue_exchange_messages_published_total")
        val consumedBefore=queueCounter("rabbitmq_detailed_queue_messages_acked_total")
        try {
            sessions.forEach { session ->
                call("POST","/practice/sessions/${id(session)}/progress-commands",progressBody(session),s.token,202)
                Thread.sleep(500)
            }
            assertEquals(12.0,queueCounter("rabbitmq_detailed_queue_exchange_messages_published_total")-producedBefore)
            eventually(75) { syncHealth.sample();syncHealth.snapshot().status=="HEALTHY" && syncHealth.snapshot().metrics.queued==12.0 }
            val queued=syncHealth.snapshot()
            assertEquals(0.0,queued.metrics.processing);assertEquals(0.0,queued.metrics.consumers)
            assertTrue(queued.metrics.productionPerSecond!!>=0);assertTrue(queued.metrics.consumptionPerSecond!=null)
            consumers.start()
            eventually(30) { syncHealth.sample();syncHealth.snapshot().metrics.queued==0.0 && sessions.all { jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,id(it))==2 } }
            val drained=syncHealth.snapshot();assertTrue(drained.metrics.committedPerSecond!!>=12/60.0)
            assertTrue(drained.metrics.consumptionPerSecond!!>0);assertTrue(drained.metrics.p95LatencyMs!!>0)
            assertEquals(12.0,queueCounter("rabbitmq_detailed_queue_messages_acked_total")-consumedBefore)
            println("SYNC_METRICS_EVIDENCE commands=12 publishedDelta=12 ackDelta=12 uniqueCommits=12 producerIntervalMs=500 consumers=4 prefetch=1 elapsedMs=${(System.nanoTime()-started)/1_000_000} processCpuMs=${(cpu.processCpuTime-cpuBefore)/1_000_000} snapshot=${json.writeValueAsString(drained)}")
        } finally { consumers.start() }
        val systemHealth=call("GET","/admin/monitoring/health")
        assertEquals(60,systemHealth["sync"]["windowSeconds"].asInt())
        assertTrue(systemHealth["components"].any { it["name"].asText()=="rabbitmq" })
        call("GET","/admin/monitoring/health",token=s.token,status=403)
        val monitorToken=call("POST","/admin/auth/sessions",mapOf("username" to "test_admin","password" to "Administrator-password-123","deviceId" to UUID.randomUUID()),null)["accessToken"].asText()
        val actor=sessionService.authenticate(monitorToken)
        val response=http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/v1/admin/monitoring/sync/stream")).header("Authorization","Bearer $monitorToken").header("Accept","text/event-stream").GET().build(),HttpResponse.BodyHandlers.ofInputStream())
        assertEquals(200,response.statusCode());assertEquals("no",response.headers().firstValue("X-Accel-Buffering").orElse(null))
        response.body().bufferedReader().use { reader ->
            assertEquals("event:sync-health",reader.readLine())
            var firstData: JsonNode?=null
            while(firstData==null) { val line=reader.readLine() ?: error("SSE closed before snapshot");if(line.startsWith("data:")) firstData=json.readTree(line.removePrefix("data:")) }
            exchanges.add(mapOf("method" to "GET","path" to "/api/v1/admin/monitoring/sync/stream","status" to 200,"requestHeaders" to mapOf("Accept" to "text/event-stream"),
                "responseHeaders" to response.headers().map().mapValues { it.value.joinToString(",") },"responseBody" to firstData))
            jdbc.update("UPDATE admin_session SET revoked_at=now() WHERE id=?",actor.sessionId)
            val future=java.util.concurrent.CompletableFuture.supplyAsync { generateSequence { reader.readLine() }.any { it=="event:auth-expired" } }
            assertTrue(future.get(25,java.util.concurrent.TimeUnit.SECONDS))
        }
        prometheus.dockerClient.pauseContainerCmd(prometheus.containerId).exec()
        try { syncHealth.sample();assertEquals("STALE",syncHealth.snapshot().status);assertTrue(syncHealth.snapshot().sampledAt!=null) }
        finally { prometheus.dockerClient.unpauseContainerCmd(prometheus.containerId).exec() }
    }

    @BeforeAll fun bootstrap() {
        platformId=adminService.bootstrap("test_admin","测试管理员","Administrator-password-123")
        adminToken=call("POST","/admin/auth/sessions",mapOf("username" to "test_admin","password" to "Administrator-password-123","deviceId" to UUID.randomUUID()),null)["accessToken"].asText()
        assertEquals(platformId,sessionService.authenticate(adminToken).id)
        learningMapper.days(qanda.backend.platform.queries.StatsFilter(Instant.now().minusSeconds(86400),Instant.now()))
        activityMapper.activityDays(qanda.backend.platform.queries.StatsFilter(Instant.now().minusSeconds(86400),Instant.now()))
    }
    private fun raw(method: String,path: String,body: Any?=null,token: String?=adminToken,key: UUID?=UUID.randomUUID(),contentType: String="application/json",accept: String?=null,extraHeaders: Map<String,String> = emptyMap()): HttpResponse<String> {
        val builder=HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/v1$path")).timeout(Duration.ofSeconds(30))
        token?.let { builder.header("Authorization","Bearer $it") };key?.let { builder.header("Idempotency-Key",it.toString()) }
        if(body!=null) builder.header("Content-Type",contentType)
        accept?.let { builder.header("Accept",it) };extraHeaders.forEach { (name,value) -> builder.header(name,value) }
        val bytes=when(body) { null -> ByteArray(0);is ByteArray -> body;else -> json.writeValueAsBytes(body) }
        val response=http.send(builder.method(method,HttpRequest.BodyPublishers.ofByteArray(bytes)).build(),HttpResponse.BodyHandlers.ofString())
        exchanges.add(mapOf("method" to method,"path" to "/api/v1$path","status" to response.statusCode(),"validateRequest" to (response.statusCode()<400),
            "requestHeaders" to buildMap<String,String> { putAll(extraHeaders);if(body!=null) put("Content-Type",contentType);key?.let { put("Idempotency-Key",it.toString()) } },
            "requestBody" to if(body is ByteArray) null else json.valueToTree<JsonNode>(body),"responseHeaders" to response.headers().map().mapValues { it.value.joinToString(",") },
            "responseBody" to runCatching { json.readTree(response.body()) }.getOrNull()))
        return response
    }
    private fun call(method: String,path: String,body: Any?=null,token: String?=adminToken,status: Int=200,key: UUID?=UUID.randomUUID()): JsonNode {
        val response=raw(method,path,body,token,key)
        assertEquals(status,response.statusCode(),"$method $path: ${response.body()}")
        assertEquals(listOf("no-store"),response.headers().allValues("Cache-Control"))
        assertEquals(1,response.headers().allValues("X-Request-Id").size)
        UUID.fromString(response.headers().firstValue("X-Request-Id").orElseThrow())
        return json.readTree(response.body())
    }
    @Test fun `guests browse published content and download readonly trial snapshots`() {
        val f=fixture()
        val bank=call("GET","/question-banks/${f.bank}?includeProgress=true",token=null)
        call("GET","/subjects/${f.subject}",token=null)
        call("GET","/question-banks/${f.bank}/chapters",token=null)
        val questions=call("GET","/question-banks/${f.bank}/questions",token=null)
        assertEquals(4,questions["total"].asInt())
        assertTrue(questions["items"].all { it["correctAnswer"].isNull && it["explanation"].isNull })
        call("GET","/me",token=null,status=401)
        val accounts=jdbc.queryForObject("SELECT count(*) FROM user_account",Long::class.java)
        val sessions=jdbc.queryForObject("SELECT count(*) FROM practice_session",Long::class.java)
        val scope=mapOf("questionBankId" to f.bank,"count" to 4,"order" to "SEQUENTIAL")
        val input=mapOf("scope" to scope,"expectedContentVersion" to bank["contentVersion"].asLong(),"feedback" to "IMMEDIATE")
        val trial=call("POST","/practice/trial-snapshots",input,null)
        assertEquals(4,trial["items"].size());assertEquals(4,trial["offlineGrading"].size())
        assertEquals(4,trial["items"].map { it["question"]["type"].asText() }.distinct().size)
        assertTrue(trial["items"].all { it["question"]["correctAnswer"].isNull && it["question"]["referenceAnswer"].isNull && it["question"]["explanation"].isNull })
        assertEquals(accounts,jdbc.queryForObject("SELECT count(*) FROM user_account",Long::class.java))
        assertEquals(sessions,jdbc.queryForObject("SELECT count(*) FROM practice_session",Long::class.java))
        call("POST","/practice/trial-snapshots",input+mapOf("expectedContentVersion" to bank["contentVersion"].asLong()+1),null,status=409)
        call("POST","/practice/trial-snapshots",input+mapOf("scope" to scope+mapOf("selectionKind" to "WRONG")),null,status=403)
        jdbc.update("UPDATE question_bank SET publication_status='DRAFT' WHERE id=?",f.bank)
        call("GET","/question-banks/${f.bank}",token=null,status=404)
        call("GET","/questions/${f.questions.first()}",token=null,status=404)
        call("POST","/practice/trial-snapshots",input,null,status=404)
    }
    private fun id(value: JsonNode)=UUID.fromString(value["id"].asText())
    private fun code(challengeId: UUID): String {
        val row=jdbc.queryForMap("SELECT * FROM mail_delivery WHERE challenge_id=?",challengeId)
        val expiry=(row["expires_at"] as java.sql.Timestamp).toInstant()
        return mailCrypto.decrypt(PreparedMailEnvelope(challengeId,row["template_code"] as String,1,expiry,row["ciphertext"] as String,row["nonce"] as String,(row["key_version"] as Number).toInt())).code
    }
    private fun student(): Student {
        val email="${UUID.randomUUID()}@example.test"
        val challenge=call("POST","/auth/email-challenges",mapOf("purpose" to "REGISTER","email" to email),null,201)
        val registration=call("POST","/auth/email-registrations",mapOf("challengeId" to id(challenge),"code" to code(id(challenge)),"password" to password,"nickname" to "测试学生"),null,201)
        val login=call("POST","/auth/sessions",mapOf("email" to email,"password" to password,"deviceId" to UUID.randomUUID(),"clientType" to "WEB"),null)
        return Student(id(registration),email,login["accessToken"].asText())
    }
    private fun question(bank: UUID,type: String): Map<String,Any?> = mapOf("questionBankId" to bank,"type" to type,"stem" to "原题$type","explanation" to "原解析",
        "options" to if(type.endsWith("CHOICE")) listOf(mapOf("key" to "A","content" to "甲"),mapOf("key" to "B","content" to "乙"),mapOf("key" to "C","content" to "丙")) else emptyList<Any>(),
        "correctAnswer" to when(type) { "SINGLE_CHOICE" -> listOf("A");"MULTIPLE_CHOICE" -> listOf("A","B");else -> emptyList<String>() },
        "correctValue" to false.takeIf { type=="TRUE_FALSE" },"referenceAnswer" to "原参考答案".takeIf { type=="SHORT_ANSWER" })
    private fun fixture(audiences: List<Map<String,Any>> = emptyList(),maintainers: List<UUID> = emptyList()): Fixture {
        val subject=id(call("POST","/admin/subjects",mapOf("name" to "课程${UUID.randomUUID()}")))
        val bank=id(call("POST","/admin/question-banks",mapOf("subjectId" to subject,"name" to "复习题库","description" to "课程练习题库","scopeType" to if(audiences.isEmpty()) "ALL" else "TARGETED","audiences" to audiences,"maintainerIds" to maintainers)))
        val questions=listOf("SINGLE_CHOICE","MULTIPLE_CHOICE","TRUE_FALSE","SHORT_ANSWER").map { id(call("POST","/admin/questions",question(bank,it))) }
        val current=call("GET","/admin/question-banks/$bank")
        call("PUT","/admin/question-banks/$bank/publication",mapOf("expectedVersion" to current["version"].asLong(),"status" to "PUBLISHED"))
        return Fixture(subject,bank,questions)
    }
    @Test fun `admin aggregates filtered pages and direct resources serve independent clients`() {
        val f=fixture();val s=student()
        val college=id(call("POST","/admin/colleges",mapOf("name" to "聚合学院","code" to "AGG")))
        val major=id(call("POST","/admin/majors",mapOf("collegeId" to college,"name" to "聚合专业","code" to "AGG")))
        call("PUT","/me/profile",mapOf("expectedVersion" to 1,"nickname" to "聚合学生","collegeId" to college,"majorId" to major,"currentGrade" to 3),s.token)
        assertEquals("聚合学院",call("GET","/admin/colleges/$college")["name"].asText())
        assertEquals("聚合专业",call("GET","/admin/majors/$major")["name"].asText())
        assertEquals(f.subject.toString(),call("GET","/admin/subjects/${f.subject}")["id"].asText())
        assertEquals(platformId.toString(),call("GET","/admin/administrators/$platformId")["id"].asText())
        val summary=call("GET","/admin/directory-summary?collegeId=$college&majorId=$major")
        assertEquals(1,summary["studentCount"].asInt())
        assertEquals(5,summary["grades"].size())
        assertEquals(1,summary["grades"].first { it["grade"].asInt()==3 }["studentCount"].asInt())
        assertEquals(1,call("GET","/admin/colleges?keyword=聚合&pageSize=1")["items"].first()["studentCount"].asInt())
        assertEquals(major.toString(),call("GET","/admin/majors?collegeId=$college&keyword=聚合")["items"].first()["id"].asText())
        assertEquals(1,call("GET","/admin/users?collegeId=$college&grade=3")["total"].asInt())
        assertEquals(0,call("GET","/admin/users?collegeId=$college&grade=2")["total"].asInt())
        val chapter=id(call("POST","/admin/question-banks/${f.bank}/chapters",mapOf("name" to "聚合章节","sortOrder" to 0)))
        call("PUT","/admin/questions/${f.questions.first()}",question(f.bank,"SINGLE_CHOICE")+mapOf("chapterId" to chapter,"expectedVersion" to 1))
        assertEquals(1,call("GET","/admin/question-banks/${f.bank}/chapters").first()["questionCount"].asInt())
        assertEquals(1,call("GET","/admin/question-banks/${f.bank}/questions?type=SINGLE_CHOICE&pageSize=1")["total"].asInt())
        assertEquals(3,call("GET","/admin/question-banks/${f.bank}/questions?unassigned=true")["total"].asInt())
        assertTrue(call("GET","/admin/question-banks/${f.bank}/publication-checks").all { it["passed"].asBoolean() })
        assertTrue(call("GET","/admin/dashboard")["publishedBankCount"].asLong()>0)
        val logs=call("GET","/admin/audit-logs?keyword=CREATE_COLLEGE&result=SUCCESS&pageSize=1")
        assertTrue(logs["total"].asLong()>0);assertEquals("SUCCESS",logs["items"].first()["outcome"].asText())
        call("GET","/admin/audit-logs?result=UNKNOWN",status=422)
        call("GET","/admin/directory-summary",token=s.token,status=403)
        call("GET","/admin/administrators/$platformId",token=null,status=401)
    }
    private fun createPractice(s: Student,f: Fixture,feedback: String="AFTER_FINISH"): JsonNode {
        val bank=call("GET","/question-banks/${f.bank}",token=s.token)
        return call("POST","/practice/sessions",mapOf("scope" to mapOf("questionBankId" to f.bank,"count" to 4,"order" to "RANDOM"),"expectedContentVersion" to bank["contentVersion"].asLong(),"feedback" to feedback,"deviceId" to UUID.randomUUID()),s.token)
    }
    private fun answers(session: JsonNode): List<Map<String,Any>> = session["items"].map { item ->
        val answer=when(item["question"]["type"].asText()) { "SINGLE_CHOICE" -> mapOf("optionKeys" to listOf("A"));"MULTIPLE_CHOICE" -> mapOf("optionKeys" to listOf("B","A"));"TRUE_FALSE" -> mapOf("value" to false);else -> mapOf("text" to "学生作答") }
        mapOf("itemId" to item["itemId"].asText(),"answer" to answer,"confirmed" to true,"marked" to true)
    }

    @Test fun `profile scope switches freely while course grants and snapshots remain independent`() {
        val student=student()
        val college=id(call("POST","/admin/colleges",mapOf("name" to "范围学院${UUID.randomUUID()}","code" to UUID.randomUUID().toString())))
        val major=id(call("POST","/admin/majors",mapOf("collegeId" to college,"name" to "范围专业","code" to "SCOPE")))
        val fixture=fixture(listOf(mapOf("majorId" to major,"grade" to 2)))
        call("GET","/question-banks/${fixture.bank}",token=null)
        call("GET","/questions/${fixture.questions.first()}",token=student.token,status=404)
        val initial=call("GET","/me",token=student.token)
        assertFalse(initial["profileComplete"].asBoolean())
        call("PUT","/me/profile",mapOf("expectedVersion" to initial["version"].asLong(),"nickname" to "范围学生","collegeId" to college,"majorId" to major,"currentGrade" to 2),student.token)
        val profile=call("GET","/me",token=student.token)
        assertTrue(profile["profileComplete"].asBoolean())
        assertEquals(2,profile["currentGrade"].asInt())
        assertEquals(4,call("GET","/question-banks/${fixture.bank}",token=student.token)["questionCount"].asInt())
        call("PUT","/me/favorites/${fixture.questions.first()}",token=student.token)
        val practice=createPractice(student,fixture)
        call("PUT","/me/profile",mapOf("expectedVersion" to profile["version"].asLong(),"nickname" to "范围学生","collegeId" to college,"majorId" to major,"currentGrade" to 3),student.token)
        call("GET","/question-banks/${fixture.bank}",token=student.token,status=404)
        assertFalse(call("GET","/me/favorites",token=student.token)["items"].first { it["questionId"].asText()==fixture.questions.first().toString() }["available"].asBoolean())
        call("GET","/practice/sessions/${id(practice)}",token=student.token)
        val version=jdbc.queryForObject("SELECT version FROM subject WHERE id=?",Long::class.java,fixture.subject)!!
        val granted=call("POST","/admin/subjects/${fixture.subject}/user-access",mapOf("userId" to student.id,"expectedVersion" to version))
        call("GET","/question-banks/${fixture.bank}",token=student.token)
        assertEquals(1,call("GET","/admin/subjects/${fixture.subject}/user-access")["total"].asInt())
        call("DELETE","/admin/subjects/${fixture.subject}/user-access/${student.id}?expectedVersion=${granted["version"].asLong()}")
        call("GET","/question-banks/${fixture.bank}",token=student.token,status=404)
        assertEquals(3,jdbc.queryForObject("SELECT current_grade(2,2025,date '2026-09-01')",Int::class.java))
        assertEquals(2,jdbc.queryForObject("SELECT current_grade(2,2025,date '2026-08-31')",Int::class.java))
    }

    @Test fun `activity uses foreground sessions distinct days and stable ranking orders`() {
        val one=student();val two=student();val three=student()
        val college=id(call("POST","/admin/colleges",mapOf("name" to "活跃学院${UUID.randomUUID()}","code" to UUID.randomUUID().toString())))
        val major=id(call("POST","/admin/majors",mapOf("collegeId" to college,"name" to "活跃专业","code" to "ACTIVITY")))
        listOf(one,two,three).forEach { s ->
            call("PUT","/me/profile",mapOf("expectedVersion" to 1,"nickname" to "活跃学生","collegeId" to college,"majorId" to major,"currentGrade" to 1),s.token)
            jdbc.update("UPDATE domain_event_outbox SET processed_at=now() WHERE user_id=?",s.id)
            jdbc.update("DELETE FROM user_activity WHERE user_id=?",s.id)
        }
        val filter="collegeId=$college&majorId=$major&grade=1"
        call("POST","/me/activity/heartbeat",token=null,status=401)
        call("POST","/me/activity/heartbeat",token=one.token)
        val secondDevice=call("POST","/auth/sessions",mapOf("email" to one.email,"password" to password,"deviceId" to UUID.randomUUID(),"clientType" to "MINI_PROGRAM"),null)
        val secondToken=secondDevice["accessToken"].asText()
        call("POST","/me/activity/heartbeat",token=secondToken)
        call("POST","/me/activity/heartbeat",token=two.token)
        activityProjection.drain()
        jdbc.update("INSERT INTO user_activity(user_id,platform,activity_date) VALUES(?,'WEB',(now() AT TIME ZONE 'Asia/Shanghai')::date-6)",two.id)
        jdbc.update("INSERT INTO user_activity(user_id,platform,activity_date) VALUES(?,'WEB',(now() AT TIME ZONE 'Asia/Shanghai')::date-29)",three.id)
        val metrics=call("GET","/admin/statistics/activity?period=WEEK&$filter")
        assertEquals(2,metrics["onlineUsers"].asInt());assertEquals(2,metrics["dailyActive"].asInt())
        assertEquals(2,metrics["weeklyActive"].asInt());assertEquals(3,metrics["monthlyActive"].asInt())
        assertEquals(7,metrics["records"].size());assertEquals(5,metrics["records"].count { it["activeUsers"].asInt()==0 })
        assertEquals(1,call("GET","/admin/statistics/activity?period=WEEK&$filter&platform=MINI_PROGRAM")["onlineUsers"].asInt())
        assertEquals(2L,onlineUsers.list(college,major,1,null,null,qanda.backend.platform.http.PageSpec(1,20)).total)
        val online=call("GET","/admin/statistics/online-users?$filter")
        assertEquals(2,online["total"].asInt())
        val onlineOne=online["items"].first { it["userId"].asText()==one.id.toString() }
        assertEquals(2,onlineOne["onlineSessionCount"].asInt());assertEquals(2,onlineOne["clients"].size())
        assertEquals(1,call("GET","/admin/statistics/online-users?$filter&platform=MINI_PROGRAM")["total"].asInt())
        call("GET","/admin/statistics/online-users",token=one.token,status=403)
        val f=fixture();val practice=createPractice(one,f);val practiceId=id(practice)
        jdbc.update("UPDATE practice_session SET created_at=created_at-interval '1 minute' WHERE id=?",practiceId)
        val finish=mapOf("expectedVersion" to 1,"durationSeconds" to 30,"items" to answers(practice),"writerToken" to practice["writer"]["writerToken"].asText())
        call("POST","/practice/sessions/$practiceId/finish",finish,one.token)
        call("POST","/practice/sessions/$practiceId/finish",finish,one.token)
        val active=call("GET","/admin/statistics/rankings?period=WEEK&$filter&sort=ACTIVE_DAYS&pageSize=1")
        assertEquals(two.id.toString(),active["items"][0]["userId"].asText());assertEquals(2,active["total"].asInt())
        val next=call("GET","/admin/statistics/rankings?period=WEEK&$filter&sort=ACTIVE_DAYS&pageSize=1&page=2")
        assertEquals(one.id.toString(),next["items"][0]["userId"].asText());assertEquals(2,next["items"][0]["rank"].asInt())
        listOf("ANSWERED_COUNT","DURATION").forEach { sort ->
            val first=call("GET","/admin/statistics/rankings?period=WEEK&$filter&sort=$sort")["items"][0]
            assertEquals(one.id.toString(),first["userId"].asText());assertEquals(4,first["answeredCount"].asInt());assertEquals(30,first["durationSeconds"].asInt())
            assertEquals(1,first["activeDays"].asInt())
        }
        jdbc.update("UPDATE session_presence SET foreground_seen_at=now()-interval '121 seconds' WHERE session_id IN(SELECT id FROM user_session WHERE user_id=?)",two.id)
        call("GET","/me",token=two.token)
        assertEquals(1,call("GET","/admin/statistics/activity?$filter")["onlineUsers"].asInt())
        call("DELETE","/auth/sessions/current",token=one.token)
        assertEquals(1,call("GET","/admin/statistics/activity?$filter")["onlineUsers"].asInt())
        call("DELETE","/auth/sessions/current",token=secondToken)
        assertEquals(0,call("GET","/admin/statistics/activity?$filter")["onlineUsers"].asInt())
        call("POST","/me/activity/heartbeat",token=secondToken,status=401)
    }

    @Test fun `reading groups preserve material revisions and fill blanks grade as atomic questions`() {
        val s=student();val f=fixture()
        val fill=mapOf("questionBankId" to f.bank,"type" to "FILL_BLANK","stem" to "协议 {{1}}，方法 {{2}}","explanation" to "网络协议",
            "blanks" to listOf(mapOf("answers" to listOf("HTTP","超文本传输协议")),mapOf("answers" to listOf("GET"))))
        val fillId=id(call("POST","/admin/questions",fill))
        listOf("{{1}} {{02}}","{{1}} {{2}} {{extra}}","{{1}} {{1}}").forEach { stem ->
            call("POST","/admin/questions",fill+mapOf("stem" to stem),status=422)
        }
        val firstId=UUID.randomUUID();val secondId=UUID.randomUUID()
        val group=mapOf("questionBankId" to f.bank,"type" to "READING","stem" to "阅读练习","passage" to "第一版材料\n保持换行",
            "subQuestions" to listOf(mapOf("id" to firstId,"type" to "TRUE_FALSE","stem" to "第一小题","correctValue" to true,"explanation" to "判断依据"),
                mapOf("id" to secondId,"type" to "SHORT_ANSWER","stem" to "第二小题","referenceAnswer" to "参考内容","explanation" to "作答思路","scoringPoints" to listOf("观点明确"))))
        val groupId=id(call("POST","/admin/questions",group))
        val bank=call("GET","/question-banks/${f.bank}",token=s.token)
        assertEquals(7,bank["questionCount"].asInt())
        val preview=call("POST","/practice/scope-preview",mapOf("questionBankId" to f.bank,"count" to 6),s.token)
        assertEquals(7,preview["availableCount"].asInt());assertEquals(5,preview["selectedCount"].asInt())
        val scope=mapOf("questionBankId" to f.bank,"count" to 7)
        val session=call("POST","/practice/sessions",mapOf("scope" to scope,"expectedContentVersion" to bank["contentVersion"].asLong(),"deviceId" to UUID.randomUUID(),"feedback" to "AFTER_FINISH"),s.token)
        assertEquals(7,session["items"].size())
        assertEquals(listOf(firstId.toString(),secondId.toString()),session["items"].toList().takeLast(2).map { it["question"]["id"].asText() })
        assertTrue(session["items"].all { it["question"]["blanks"].isNull && it["question"]["scoringPoints"].isNull })
        call("PUT","/admin/questions/$groupId",group+mapOf("expectedVersion" to 1,"passage" to "第二版材料"))
        val restored=call("GET","/practice/sessions/${id(session)}",token=s.token)
        assertEquals("第一版材料\n保持换行",restored["items"].last()["question"]["material"]["passage"].asText())
        val changes=session["items"].map { item ->
            val q=item["question"];val answer=when(q["type"].asText()) {
                "SINGLE_CHOICE" -> mapOf("optionKeys" to listOf("A"));"MULTIPLE_CHOICE" -> mapOf("optionKeys" to listOf("A","B"))
                "TRUE_FALSE" -> mapOf("value" to (q["id"].asText()==firstId.toString()))
                "FILL_BLANK" -> mapOf("blanks" to listOf(" http ","get"));else -> mapOf("text" to "我的回答")
            }
            mapOf("itemId" to item["itemId"].asText(),"answer" to answer,"confirmed" to true)
        }
        val result=call("POST","/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText(),"items" to changes),s.token)
        assertEquals(7,result["answeredCount"].asInt());assertEquals(5,result["objective"]["correct"].asInt())
        assertEquals("CORRECT",result["items"].first { it["question"]["id"].asText()==fillId.toString() }["outcome"].asText())
        assertEquals("观点明确",result["items"].last()["question"]["scoringPoints"][0].asText())
        call("PUT","/me/favorites/$firstId",token=s.token)
        val selected=call("POST","/practice/scope-preview",mapOf("questionBankId" to f.bank,"count" to 1,"selectionKind" to "FAVORITE"),s.token)
        assertEquals(1,selected["selectedCount"].asInt())
        call("POST","/practice/scope-preview",mapOf("questionBankId" to f.bank,"count" to 1,"questionIds" to listOf(firstId)),s.token,422)
    }

    @Test fun `imports count answering items with atomic retries and request byte limits`() {
        val f=fixture();val bank=call("GET","/admin/question-banks/${f.bank}")
        val input=mapOf("expectedContentVersion" to bank["contentVersion"].asLong(),"questions" to List(3000) { question(f.bank,"TRUE_FALSE") })
        assertEquals(3000,call("POST","/admin/question-banks/${f.bank}/import-preview",input)["questionCount"].asInt())
        call("POST","/admin/question-banks/${f.bank}/import-preview",input+mapOf("questions" to List(3001) { question(f.bank,"TRUE_FALSE") }),status=422)
        val key=UUID.randomUUID()
        val imported=call("POST","/admin/question-banks/${f.bank}/imports",input,key=key)
        assertEquals(3000,imported["questionIds"].size());assertEquals(bank["contentVersion"].asLong()+1,imported["contentVersion"].asLong())
        assertEquals(imported,call("POST","/admin/question-banks/${f.bank}/imports",input,key=key))
        val broken=mapOf("expectedContentVersion" to imported["contentVersion"].asLong(),"questions" to listOf(question(f.bank,"TRUE_FALSE"),question(f.bank,"TRUE_FALSE")+mapOf("correctValue" to null)))
        call("POST","/admin/question-banks/${f.bank}/imports",broken,status=422)
        assertEquals(3004,call("GET","/admin/question-banks/${f.bank}")["questionCount"].asInt())
        val jsonBody="{\"expectedContentVersion\":1,\"questions\":[]}"
        val bytes=(jsonBody+" ".repeat(8*1024*1024-jsonBody.length)).toByteArray()
        assertNotEquals(413,raw("POST","/admin/question-banks/${f.bank}/imports",bytes).statusCode())
        assertEquals(413,raw("POST","/admin/question-banks/${f.bank}/imports",bytes+byteArrayOf(32)).statusCode())
    }

    @Test fun `shared content recommendation choice practice grading feedback and real statistics form one HTTP loop`() {
        val s=student();val empty=call("GET","/me",token=s.token);assertTrue(empty["majorId"].isNull)
        val college=id(call("POST","/admin/colleges",mapOf("name" to "学院${UUID.randomUUID()}","code" to UUID.randomUUID().toString())))
        val major=id(call("POST","/admin/majors",mapOf("collegeId" to college,"name" to "专业","code" to "M1")))
        val f=fixture(listOf(mapOf("majorId" to major)))
        assertEquals(0,call("GET","/me/recommendations",token=s.token)["items"].count { it["subject"]["id"].asText()==f.subject.toString() })
        call("GET","/question-banks/${f.bank}",token=s.token,status=404)
        call("PUT","/me/profile",mapOf("expectedVersion" to empty["version"].asLong(),"nickname" to "自主注册用户","collegeId" to college,"majorId" to major,"currentGrade" to 2),s.token)
        assertTrue(jdbc.queryForMap("SELECT college_id FROM user_profile WHERE user_id=?",s.id)["college_id"]==null)
        assertEquals(college.toString(),call("GET","/me",token=s.token)["collegeId"].asText())
        assertTrue(call("GET","/me/recommendations",token=s.token)["items"].any { it["subject"]["id"].asText()==f.subject.toString() })
        call("PUT","/me/subjects/${f.subject}",mapOf("preferredBankId" to f.bank),s.token)
        assertTrue(call("GET","/me/subjects",token=s.token)["items"].any { it["subject"]["id"].asText()==f.subject.toString() })
        call("PUT","/me/favorites/${f.questions.first()}",token=s.token)
        val session=createPractice(s,f);val sessionId=id(session)
        session["items"].forEach { assertTrue(it["question"]["explanation"].isNull);assertTrue(it["question"]["correctAnswer"].isNull);assertTrue(it["question"]["referenceAnswer"].isNull) }
        val originalItem=session["items"].first { it["question"]["type"].asText()=="TRUE_FALSE" }
        val originalQuestion=UUID.fromString(originalItem["question"]["id"].asText())
        call("PUT","/admin/questions/$originalQuestion",question(f.bank,"TRUE_FALSE")+mapOf("stem" to "更新后的题干","correctValue" to true,"expectedVersion" to 1))
        val progress=mapOf("expectedVersion" to 1,"currentIndex" to 1,"durationSeconds" to 0,"items" to answers(session),"writerToken" to session["writer"]["writerToken"].asText(),"clientSequence" to 1)
        val saved=call("PUT","/practice/sessions/$sessionId/progress-ack",progress,s.token)
        call("PUT","/practice/sessions/$sessionId/progress-ack",progress,s.token,409)
        val restored=call("GET","/practice/sessions/$sessionId",token=s.token)
        assertEquals(session["items"].map { it["itemId"].asText() },restored["items"].map { it["itemId"].asText() })
        assertEquals("原题TRUE_FALSE",restored["items"].first { it["question"]["type"].asText()=="TRUE_FALSE" }["question"]["stem"].asText())
        val finish=mapOf("expectedVersion" to saved["version"].asLong(),"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText())
        val result=call("POST","/practice/sessions/$sessionId/finish",finish,s.token)
        assertEquals(result,call("GET","/practice/sessions/$sessionId/result",token=s.token))
        assertEquals(result,call("GET","/me/practice-history/$sessionId",token=s.token))
        assertEquals(result,call("GET","/admin/students/${s.id}/practice-history/$sessionId"))
        assertEquals(1,call("GET","/admin/students/${s.id}/practice-history")["total"].asInt())
        assertEquals(1,call("GET","/admin/students/${s.id}/statistics?period=ALL")["practiceCount"].asInt())
        assertEquals(3,result["objective"]["correct"].asInt());assertEquals(1,result["shortAnswer"]["unrated"].asInt())
        assertEquals(result["id"],call("POST","/practice/sessions/$sessionId/finish",finish,s.token)["id"])
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM practice_result WHERE session_id=?",Int::class.java,sessionId))
        val short=result["items"].first { it["question"]["type"].asText()=="SHORT_ANSWER" }
        call("PUT","/practice/sessions/$sessionId/items/${short["itemId"].asText()}/self-assessment",mapOf("expectedVersion" to result["version"].asLong(),"assessment" to "WRONG"),s.token)
        val stats=call("GET","/me/statistics?period=ALL",token=s.token);assertEquals(1,stats["practiceCount"].asInt());assertEquals(3,stats["correctCount"].asInt());assertEquals(1,stats["selfRatedWrongCount"].asInt())
        assertEquals(1,call("GET","/me/wrong-questions",token=s.token)["total"].asInt())
        assertEquals(1,call("GET","/me/wrong-questions/${short["question"]["id"].asText()}/history",token=s.token)["total"].asInt())
        assertEquals(1,call("GET","/me/favorites",token=s.token)["total"].asInt())
        call("DELETE","/me/subjects/${f.subject}",token=s.token)
        assertEquals(1,call("GET","/me/practice-history",token=s.token)["total"].asInt())
        val feedback=id(call("POST","/me/question-feedback",mapOf("questionId" to originalQuestion,"revisionId" to originalItem["question"]["revisionId"].asText(),"category" to "ANSWER","body" to "请核查参考答案"),s.token))
        call("PUT","/admin/question-feedback/$feedback",mapOf("expectedVersion" to 1,"status" to "RESOLVED","response" to "已核实并修正"))
        val reply=call("GET","/me/question-feedback",token=s.token)["items"].first { it["id"].asText()==feedback.toString() }
        assertEquals("原题TRUE_FALSE",reply["question"]["stem"].asText());assertEquals("已核实并修正",reply["response"].asText())
        assertTrue(call("GET","/admin/question-feedback")["items"].any { it["id"].asText()==feedback.toString() })
        val request=id(call("POST","/me/course-requests",mapOf("courseName" to "尚未提供的课程","body" to "希望增加复习题库"),s.token))
        call("PUT","/admin/course-requests/$request",mapOf("expectedVersion" to 1,"status" to "IN_PROGRESS","response" to "正在整理"))
        assertEquals("IN_PROGRESS",call("GET","/me/course-requests",token=s.token)["items"].first()["status"].asText())
        assertTrue(call("GET","/admin/course-requests")["items"].any { it["id"].asText()==request.toString() })
        call("GET","/admin/statistics/summary?period=ALL");call("GET","/admin/statistics/activity");call("GET","/admin/statistics/rankings");call("GET","/admin/statistics/organizations")
        assertTrue(call("GET","/admin/dashboard")["answeredCount"].asInt()>=4)
    }

    @Test fun `administrators share full access with independent sessions and last administrator protection`() {
        val student=student()
        call("GET","/admin/users",token=student.token,status=403);call("GET","/me",token=adminToken,status=403)
        val admin=id(call("POST","/admin/administrators",mapOf("username" to "admin_${UUID.randomUUID().toString().take(8)}","name" to "新管理员","password" to password)))
        val username=jdbc.queryForObject("SELECT username FROM admin_account WHERE id=?",String::class.java,admin)!!
        fun login()=call("POST","/admin/auth/sessions",mapOf("username" to username,"password" to password,"deviceId" to UUID.randomUUID()),null)["accessToken"].asText()
        val token=login();val secondToken=login();assertNotEquals(token,secondToken)
        assertEquals("SUPER_ADMIN",call("GET","/admin/auth/me",token=token)["role"].asText())
        val other=fixture();val bank=call("GET","/admin/question-banks/${other.bank}",token=token)
        val edit=mapOf("subjectId" to other.subject,"name" to "编辑后的题库","description" to "已发布题库说明","expectedVersion" to bank["version"].asLong(),"maintainerIds" to listOf(admin))
        call("PUT","/admin/question-banks/${other.bank}",edit,token)
        assertEquals(admin.toString(),call("GET","/admin/question-banks/${other.bank}",token=token)["maintainerIds"].first().asText())
        call("GET","/admin/users",token=token);call("GET","/admin/administrators",token=token)
        call("GET","/admin/course-requests",token=token);call("GET","/admin/monitoring/health",token=token)
        val third=id(call("POST","/admin/administrators",mapOf("username" to "third_${UUID.randomUUID().toString().take(8)}","name" to "同事","status" to "DISABLED","password" to password),token))
        assertEquals("SUPER_ADMIN",call("GET","/admin/administrators/$third",token=token)["role"].asText())
        val self=call("GET","/admin/auth/me")
        assertFalse(self.has("passwordHash"));assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM user_account WHERE id=?",Int::class.java,platformId))
        call("PUT","/admin/administrators/$admin",mapOf("username" to username,"name" to "更新后的管理员","expectedVersion" to 1))
        call("POST","/admin/auth/logout",token=token)
        call("GET","/admin/auth/me",token=token,status=401)
        call("GET","/admin/auth/me",token=secondToken)
        call("DELETE","/admin/administrators/$admin?expectedVersion=2")
        call("GET","/admin/auth/me",token=secondToken,status=401)
        org.springframework.transaction.support.TransactionTemplate(transactionManager).executeWithoutResult { transaction ->
            jdbc.update("UPDATE admin_account SET status='INACTIVE' WHERE id<>? AND status='ACTIVE'",platformId)
            val version=jdbc.queryForObject("SELECT version FROM admin_account WHERE id=?",Long::class.java,platformId)!!
            val error=assertThrows(qanda.backend.platform.http.ApiException::class.java) { adminService.disable(platformId,version) }
            assertEquals("LAST_ADMIN",error.code)
            transaction.setRollbackOnly()
        }
        assertTrue(call("GET","/admin/audit-logs?pageSize=100")["items"].any { it["actorAdminId"].asText()==admin.toString() && it["operation"].asText()=="CREATE_ADMIN" })
    }

    @Test fun `administrator status contract maps disabled and rejects undocumented inactive`() {
        val username="disabled_${UUID.randomUUID().toString().take(8)}"
        val createdDisabled=id(call("POST","/admin/administrators",mapOf("username" to username,"name" to "停用管理员","status" to "DISABLED","password" to password)))
        assertEquals("DISABLED",call("GET","/admin/administrators?pageSize=100")["items"].first { it["id"].asText()==createdDisabled.toString() }["status"].asText())
        call("PUT","/admin/administrators/$createdDisabled",mapOf("username" to username,"name" to "停用管理员","status" to "DISABLED","expectedVersion" to 1))
        val listed=call("GET","/admin/administrators?pageSize=100")["items"].first { it["id"].asText()==createdDisabled.toString() }
        assertEquals("DISABLED",listed["status"].asText())
        call("PUT","/admin/administrators/$createdDisabled",mapOf("username" to username,"name" to "停用管理员","status" to "INACTIVE","expectedVersion" to 2),status=422)
        call("PUT","/admin/administrators/$createdDisabled",mapOf("username" to username,"name" to "停用管理员","role" to "CONTENT_ADMIN","expectedVersion" to 2),status=422)
    }

    @Test fun `administrator migration preserves account data and restricts roles`() {
        java.sql.DriverManager.getConnection(postgres.jdbcUrl,postgres.username,postgres.password).use { connection ->
            connection.createStatement().use { statement ->
                statement.execute("CREATE TEMP TABLE admin_account (id integer PRIMARY KEY, role varchar(20) NOT NULL CHECK(role IN ('PLATFORM_ADMIN','CONTENT_ADMIN')), status text NOT NULL, credential_version bigint NOT NULL, version bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())")
                statement.execute("INSERT INTO admin_account(id,role,status,credential_version,version) VALUES (1,'PLATFORM_ADMIN','ACTIVE',4,8),(2,'CONTENT_ADMIN','INACTIVE',7,9)")
                val migration=javaClass.getResourceAsStream("/db/migrations/20261101_super_admin.sql")!!.bufferedReader().use { it.readText() }
                statement.execute(migration);statement.execute(migration)
                statement.executeQuery("SELECT role,status,credential_version,version FROM admin_account ORDER BY id").use { rows ->
                    assertTrue(rows.next());assertEquals("SUPER_ADMIN",rows.getString(1));assertEquals("ACTIVE",rows.getString(2));assertEquals(4L,rows.getLong(3));assertEquals(9L,rows.getLong(4))
                    assertTrue(rows.next());assertEquals("SUPER_ADMIN",rows.getString(1));assertEquals("INACTIVE",rows.getString(2));assertEquals(7L,rows.getLong(3));assertEquals(10L,rows.getLong(4))
                    assertFalse(rows.next())
                }
                assertThrows(java.sql.SQLException::class.java) { statement.execute("UPDATE admin_account SET role='CONTENT_ADMIN' WHERE id=1") }
            }
        }
    }

    @Test fun `idempotency compares payload and importing invalid documents rolls back the whole batch`() {
        val key=UUID.randomUUID();val body=mapOf("name" to "幂等${UUID.randomUUID()}","code" to UUID.randomUUID().toString())
        val first=call("POST","/admin/colleges",body,key=key);assertEquals(first,call("POST","/admin/colleges",body,key=key))
        call("POST","/admin/colleges",body+mapOf("name" to "不同内容"),status=409,key=key)
        val f=fixture();val bank=call("GET","/admin/question-banks/${f.bank}")
        val invalid=question(f.bank,"SINGLE_CHOICE")+mapOf("correctAnswer" to listOf("X"))
        val batch=mapOf("expectedContentVersion" to bank["contentVersion"].asLong(),"questions" to listOf(question(f.bank,"TRUE_FALSE"),invalid))
        assertFalse(call("POST","/admin/question-banks/${f.bank}/import-preview",batch)["valid"].asBoolean())
        call("POST","/admin/question-banks/${f.bank}/imports",batch,status=422)
        assertEquals(4,jdbc.queryForObject("SELECT count(*) FROM question WHERE bank_id=?",Int::class.java,f.bank))
        val valid=batch+mapOf("questions" to listOf(question(f.bank,"TRUE_FALSE")))
        assertEquals(1,call("POST","/admin/question-banks/${f.bank}/imports",valid)["questionIds"].size())
        val version=call("GET","/admin/question-banks/${f.bank}")["contentVersion"].asLong()
        jdbc.execute("CREATE FUNCTION reject_test_revision() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.stem = ''中断批次'' THEN RAISE EXCEPTION ''simulated write failure''; END IF; RETURN NEW; END'")
        jdbc.execute("CREATE TRIGGER reject_test_revision BEFORE INSERT ON question_revision FOR EACH ROW EXECUTE FUNCTION reject_test_revision()")
        try {
            val interrupted=mapOf("expectedContentVersion" to version,"questions" to listOf(question(f.bank,"TRUE_FALSE"),question(f.bank,"TRUE_FALSE")+mapOf("stem" to "中断批次")))
            call("POST","/admin/question-banks/${f.bank}/imports",interrupted,status=500)
            assertEquals(5,jdbc.queryForObject("SELECT count(*) FROM question WHERE bank_id=?",Int::class.java,f.bank))
            assertEquals(version,call("GET","/admin/question-banks/${f.bank}")["contentVersion"].asLong())
        } finally { jdbc.execute("DROP TRIGGER reject_test_revision ON question_revision");jdbc.execute("DROP FUNCTION reject_test_revision()") }
    }

    @Test fun `concurrent progress and finish commands cannot overwrite answers or duplicate results`() {
        val s=student();val f=fixture();val session=createPractice(s,f);val id=id(session)
        val progress=mapOf("expectedVersion" to 1,"currentIndex" to 0,"durationSeconds" to 0,"items" to answers(session),"writerToken" to session["writer"]["writerToken"].asText(),"clientSequence" to 1)
        val pool=Executors.newFixedThreadPool(2)
        try {
            val updates=(1..2).map { pool.submit<Int> { raw("PUT","/practice/sessions/$id/progress-ack",progress,s.token).statusCode() } }.map { it.get() }.sorted()
            assertEquals(listOf(200,409),updates)
            val finish=mapOf("expectedVersion" to 2,"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText())
            val results=(1..2).map { pool.submit<String> { val r=raw("POST","/practice/sessions/$id/finish",finish,s.token);assertEquals(200,r.statusCode(),r.body());json.readTree(r.body())["id"].asText() } }.map { it.get() }
            assertEquals(results[0],results[1]);assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM practice_result WHERE session_id=?",Int::class.java,id))
        } finally { pool.shutdownNow() }
    }

    @Test fun `immediate feedback freezes confirmed answers and wrong favorite practice can be resumed or cancelled`() {
        val s=student();val f=fixture();val session=createPractice(s,f,"IMMEDIATE");val sessionId=id(session)
        val multiple=session["items"].first { it["question"]["type"].asText()=="MULTIPLE_CHOICE" }
        val itemId=multiple["itemId"].asText();val questionId=multiple["question"]["id"].asText()
        fun progress(version: Int,keys: List<String>,confirmed: Boolean)=mapOf("expectedVersion" to version,"currentIndex" to 0,"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText(),"clientSequence" to version,
            "items" to listOf(mapOf("itemId" to itemId,"answer" to mapOf("optionKeys" to keys),"confirmed" to confirmed)))
        call("PUT","/practice/sessions/$sessionId/progress-ack",progress(1,listOf("A"),false),s.token)
        val draft=call("GET","/practice/sessions/$sessionId",token=s.token)
        assertTrue(draft["items"].first { it["itemId"].asText()==itemId }["question"]["correctAnswer"].isNull)
        call("PUT","/practice/sessions/$sessionId/progress-ack",progress(2,listOf("B","A"),true),s.token)
        val confirmed=call("GET","/practice/sessions/$sessionId",token=s.token)
        assertEquals("CORRECT",confirmed["items"].first { it["itemId"].asText()==itemId }["outcome"].asText())
        call("PUT","/practice/sessions/$sessionId/progress-ack",progress(3,listOf("A","B"),true),s.token)
        call("PUT","/practice/sessions/$sessionId/progress-ack",progress(4,listOf("A"),true),s.token,409)
        call("POST","/practice/sessions/$sessionId/cancel",mapOf("expectedVersion" to 4,"writerToken" to session["writer"]["writerToken"].asText()),s.token)
        call("PUT","/practice/sessions/$sessionId/progress-ack",progress(5,listOf("A","B"),true),s.token,409)
        call("GET","/practice/sessions/$sessionId/result",token=s.token,status=409)
        call("PUT","/me/favorites/$questionId",token=s.token)
        fun scope(kind: String)=mapOf("questionBankId" to f.bank,"count" to 1,"order" to "SEQUENTIAL","selectionKind" to kind)
        fun selected(kind: String): JsonNode {
            val preview=call("POST","/practice/scope-preview",scope(kind),s.token)
            assertEquals(1,preview["availableCount"].asInt())
            return call("POST","/practice/sessions",mapOf("scope" to scope(kind),"expectedContentVersion" to preview["contentVersion"].asLong(),"deviceId" to UUID.randomUUID()),s.token)
        }
        val favorite=selected("FAVORITE")
        assertEquals(questionId,favorite["items"].first()["question"]["id"].asText())
        call("POST","/practice/sessions/${id(favorite)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to favorite["writer"]["writerToken"].asText(),
            "items" to listOf(mapOf("itemId" to favorite["items"].first()["itemId"].asText(),"answer" to mapOf("optionKeys" to listOf("A")),"confirmed" to true))),s.token)
        assertEquals(1,call("GET","/me/wrong-questions?questionBankId=${f.bank}",token=s.token)["total"].asInt())
        val wrong=selected("WRONG")
        call("POST","/practice/sessions/${id(wrong)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to wrong["writer"]["writerToken"].asText(),"items" to answers(wrong)),s.token)
        assertEquals(0,call("GET","/me/wrong-questions?questionBankId=${f.bank}",token=s.token)["total"].asInt())
        assertEquals(1,call("GET","/me/wrong-questions?status=MASTERED&questionBankId=${f.bank}",token=s.token)["total"].asInt())
        assertEquals(2,call("GET","/me/wrong-questions/$questionId/history",token=s.token)["total"].asInt())
        assertEquals(id(wrong).toString(),call("GET","/me/recent-learning",token=s.token)["items"].first()["id"].asText())
        call("DELETE","/me/favorites/$questionId",token=s.token)
        assertEquals(0,call("POST","/practice/scope-preview",scope("FAVORITE"),s.token)["availableCount"].asInt())
    }

    @Test fun `announcements respect recipients platforms and scheduled visibility`() {
        val one=student();val two=student()
        val announcement=id(call("POST","/admin/announcements",mapOf("title" to "定向公告","summary" to "摘要","body" to "正文","audience" to "SELECTED","userIds" to listOf(one.id),"platforms" to listOf("WEB"),"status" to "SCHEDULED","publishAt" to Instant.now().plusSeconds(3600))))
        call("PUT","/admin/announcements/$announcement",mapOf("title" to "更新后的定向公告","summary" to "摘要","body" to "正文","audience" to "SELECTED","userIds" to listOf(one.id),"platforms" to listOf("WEB"),"status" to "SCHEDULED","publishAt" to Instant.now().plusSeconds(3600),"expectedVersion" to 1))
        assertTrue(call("GET","/admin/announcements")["items"].any { it["id"].asText()==announcement.toString() })
        assertFalse(call("GET","/announcements",token=one.token)["items"].any { it["id"].asText()==announcement.toString() })
        jdbc.update("UPDATE announcement SET publish_at=now()-interval '1 minute' WHERE id=?",announcement)
        assertTrue(call("GET","/announcements",token=one.token)["items"].any { it["id"].asText()==announcement.toString() })
        assertFalse(call("GET","/announcements",token=two.token)["items"].any { it["id"].asText()==announcement.toString() })
        call("DELETE","/admin/announcements/$announcement?expectedVersion=2")
        assertFalse(call("GET","/announcements",token=one.token)["items"].any { it["id"].asText()==announcement.toString() })
    }

    @Test fun `offline snapshots compact synchronization and strict writer handoff preserve all answers`() {
        val s=student();val other=student();val f=fixture();val device=UUID.randomUUID();val next=UUID.randomUUID()
        val bank=call("GET","/question-banks/${f.bank}",token=s.token)
        val selected=mapOf("questionBankId" to f.bank,"count" to 1,"questionIds" to listOf(f.questions.first()))
        val selectedSession=call("POST","/practice/sessions",mapOf("scope" to selected,"expectedContentVersion" to bank["contentVersion"].asLong(),"deviceId" to UUID.randomUUID()),s.token)
        assertEquals(f.questions.first().toString(),selectedSession["items"].first()["question"]["id"].asText())
        call("POST","/practice/scope-preview",selected+mapOf("questionIds" to listOf(UUID.randomUUID())),s.token,422)
        val create=mapOf("scope" to mapOf("questionBankId" to f.bank,"count" to 4,"order" to "RANDOM"),"expectedContentVersion" to bank["contentVersion"].asLong(),"deviceId" to device)
        val session=call("POST","/practice/sessions",create,s.token);val sessionId=id(session)
        assertEquals(4,session["configuration"]["count"].asInt());assertEquals(4,session["offlineGrading"].size())
        assertTrue(session["items"].all { it["question"]["correctAnswer"].isNull && it["question"]["referenceAnswer"].isNull })
        val token=session["writer"]["writerToken"].asText();assertEquals("ACTIVE",session["writer"]["state"].asText())
        val plain=call("GET","/practice/sessions/$sessionId",token=s.token)
        assertTrue(plain["offlineGrading"].isNull);assertTrue(plain["writer"]["writerToken"].isNull)
        fun snapshot(d: UUID,t: String,status: Int=200): JsonNode {
            val response=raw("GET","/practice/sessions/$sessionId/snapshot?deviceId=$d",token=s.token,extraHeaders=mapOf("X-Practice-Writer" to t))
            assertEquals(status,response.statusCode(),response.body());return json.readTree(response.body())
        }
        assertEquals(session["offlineGrading"],snapshot(device,token)["offlineGrading"])
        snapshot(next,token,409)
        val acquireKey=UUID.randomUUID();val waiting=call("POST","/practice/sessions/$sessionId/writer-acquire",mapOf("deviceId" to next),s.token,key=acquireKey)
        assertEquals("WAITING",waiting["state"].asText());assertTrue(waiting["writerToken"].isNull)
        assertEquals(waiting,call("POST","/practice/sessions/$sessionId/writer-acquire",mapOf("deviceId" to next),s.token,key=acquireKey))
        call("POST","/practice/sessions/$sessionId/writer-acquire",mapOf("deviceId" to UUID.randomUUID()),s.token,409)
        call("GET","/practice/sessions/$sessionId/writer-state?deviceId=$device",token=other.token,status=404)
        assertEquals(next.toString(),call("GET","/practice/sessions/$sessionId/writer-state?deviceId=$device",token=s.token)["pendingDeviceId"].asText())
        // A separate practice can be created while the first practice waits for handoff.
        assertNotEquals(sessionId,id(call("POST","/practice/sessions",create,s.token)))
        val progress=mapOf("expectedVersion" to 1,"currentIndex" to 2,"durationSeconds" to 0,"items" to answers(session),"writerToken" to token,"clientSequence" to 3)
        val saveKey=UUID.randomUUID();val ack=call("PUT","/practice/sessions/$sessionId/progress-ack",progress,s.token,key=saveKey)
        assertEquals(3,ack["acknowledgedSequence"].asInt());assertFalse(ack.has("items"))
        assertEquals(ack,call("PUT","/practice/sessions/$sessionId/progress-ack",progress,s.token,key=saveKey))
        call("PUT","/practice/sessions/$sessionId/progress-ack",progress+mapOf("expectedVersion" to 2),s.token,422)
        val release=mapOf("deviceId" to device,"writerToken" to token,"expectedVersion" to 2,"clientSequence" to 4)
        call("POST","/practice/sessions/$sessionId/writer-release",release,s.token,409)
        val releaseKey=UUID.randomUUID()
        call("POST","/practice/sessions/$sessionId/writer-release",release+mapOf("clientSequence" to 3),s.token,key=releaseKey)
        call("POST","/practice/sessions/$sessionId/writer-release",release+mapOf("clientSequence" to 3),s.token,key=releaseKey)
        val acquired=call("GET","/practice/sessions/$sessionId/writer-state?deviceId=$next",token=s.token)
        assertEquals("ACTIVE",acquired["state"].asText());assertEquals(0,acquired["acknowledgedSequence"].asInt());assertTrue(acquired["pendingDeviceId"].isNull)
        val nextToken=acquired["writerToken"].asText();assertNotEquals(token,nextToken)
        val restored=snapshot(next,nextToken);assertEquals(2,restored["currentIndex"].asInt());assertTrue(restored["items"].all { !it["answer"].isNull })
        snapshot(device,token,409)
        call("PUT","/practice/sessions/$sessionId/progress-ack",progress+mapOf("expectedVersion" to 2,"clientSequence" to 4),s.token,409)
        call("POST","/practice/sessions/$sessionId/cancel",mapOf("expectedVersion" to 2,"writerToken" to token),s.token,409)
        val finish=mapOf("expectedVersion" to 2,"durationSeconds" to 0,"writerToken" to nextToken)
        call("POST","/practice/sessions/$sessionId/finish",finish+mapOf("writerToken" to token),s.token,409)
        val result=call("POST","/practice/sessions/$sessionId/finish",finish,s.token)
        assertEquals(3,result["objective"]["correct"].asInt());assertEquals(1,result["shortAnswer"]["answered"].asInt())
        val short=result["items"].first { it["question"]["type"].asText()=="SHORT_ANSWER" }
        call("PUT","/practice/sessions/$sessionId/items/${short["itemId"].asText()}/self-assessment",mapOf("expectedVersion" to result["version"].asLong(),"assessment" to "CORRECT"),s.token)
        call("PUT","/practice/sessions/$sessionId/items/${short["itemId"].asText()}/self-assessment",mapOf("expectedVersion" to result["version"].asLong(),"assessment" to "WRONG"),s.token,409)
    }

    @Test fun `released writers reacquire safely and compact acknowledgements bound repeated response size`() {
        val s=student();val f=fixture();val session=createPractice(s,f);val id=id(session);val device=UUID.fromString(session["writer"]["deviceId"].asText())
        val writer=call("POST","/practice/sessions/$id/writer-acquire",mapOf("deviceId" to device),s.token)
        val token=writer["writerToken"].asText()
        call("POST","/practice/sessions/$id/writer-release",mapOf("deviceId" to device,"writerToken" to token,"expectedVersion" to 1,"clientSequence" to 0),s.token)
        val released=call("GET","/practice/sessions/$id/writer-state?deviceId=$device",token=s.token)
        assertEquals("RELEASED",released["state"].asText());assertTrue(released["writerToken"].isNull)
        call("PUT","/practice/sessions/$id/progress-ack",mapOf("expectedVersion" to 1,"currentIndex" to 0,"durationSeconds" to 0,"writerToken" to token,"clientSequence" to 1),s.token,409)
        val renewed=call("POST","/practice/sessions/$id/writer-acquire",mapOf("deviceId" to device),s.token)
        val renewedToken=renewed["writerToken"].asText();assertNotEquals(token,renewedToken)
        val os=java.lang.management.ManagementFactory.getOperatingSystemMXBean() as com.sun.management.OperatingSystemMXBean
        val cpu=os.processCpuTime;val started=System.nanoTime();var bytes=0
        repeat(30) { index ->
            val ack=call("PUT","/practice/sessions/$id/progress-ack",mapOf("expectedVersion" to index+1,"currentIndex" to index%4,"durationSeconds" to 0,"writerToken" to renewedToken,"clientSequence" to index+1),s.token)
            assertEquals(index+1,ack["acknowledgedSequence"].asInt());bytes+=json.writeValueAsBytes(ack).size
        }
        val compactCpu=(os.processCpuTime-cpu)/1000000;val compactWall=(System.nanoTime()-started)/1000000
        val full=call("GET","/practice/sessions/$id",token=s.token)
        val fullBytes=json.writeValueAsBytes(full).size
        assertTrue(bytes/30<fullBytes)
        val report=mapOf("scenario" to "4题练习，30次串行增量保存；与单次完整练习读取比较响应大小", "requests" to 30,"concurrency" to 1,
            "compact" to mapOf("wallMillis" to compactWall,"jvmCpuMillis" to compactCpu,"responseBytes" to bytes,"averageResponseBytes" to bytes/30),
            "fullRead" to mapOf("responseBytes" to fullBytes))
        val dir=Path.of(".backend-runtime/verification");Files.createDirectories(dir);Files.writeString(dir.resolve("practice-sync-observation.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(report))
        assertEquals(31L,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Long::class.java,id))
    }

    @Test fun `v1 requires writer credentials and exposes one profile read and progress write`() {
        val s=student();val f=fixture();val bank=call("GET","/question-banks/${f.bank}",token=s.token)
        val input=mapOf("scope" to mapOf("questionBankId" to f.bank,"count" to 4),"expectedContentVersion" to bank["contentVersion"].asLong())
        call("POST","/practice/sessions",input,s.token,400)
        val session=createPractice(s,f);val sessionId=id(session)
        call("PUT","/practice/sessions/$sessionId/progress-ack",mapOf("expectedVersion" to 1,"currentIndex" to 0,"durationSeconds" to 0),s.token,400)
        call("PUT","/practice/sessions/$sessionId/progress",mapOf("expectedVersion" to 1),s.token,404)
        call("GET","/me/profile",token=s.token,status=405)
        call("GET","/me",token=s.token)
    }

    @Test fun `global question search is paginated and progress contains latest personal graded outcomes`() {
        val s=student();val another=student();val f=fixture();val hidden=fixture();val marker="search-${UUID.randomUUID()}"
        for((bank,q) in listOf(f.bank to f.questions[0],f.bank to f.questions[1],hidden.bank to hidden.questions[0])) {
            val current=call("GET","/admin/questions/$q")
            val type=current["type"].asText()
            val payload=question(bank,type)+mapOf("stem" to "$marker $type","expectedVersion" to current["version"].asLong())
            call("PUT","/admin/questions/$q",if(q==f.questions[0]) payload+mapOf("options" to listOf(mapOf("key" to "A","content" to "option-$marker"),mapOf("key" to "B","content" to "乙"),mapOf("key" to "C","content" to "丙"))) else payload)
        }
        val hiddenBank=call("GET","/admin/question-banks/${hidden.bank}")
        call("PUT","/admin/question-banks/${hidden.bank}/publication",mapOf("expectedVersion" to hiddenBank["version"].asLong(),"status" to "UNPUBLISHED"))
        val found=call("GET","/questions?keyword=$marker&pageSize=1",token=s.token)
        assertEquals(2,found["total"].asInt());assertEquals(1,found["items"].size())
        val first=found["items"].first();assertEquals(f.bank.toString(),first["questionBankId"].asText())
        val optionMatch=call("GET","/questions?keyword=option-$marker",token=s.token)
        assertEquals(1,optionMatch["total"].asInt());assertEquals(f.questions[0].toString(),optionMatch["items"].first()["id"].asText())
        assertTrue(first["correctAnswer"].isNull);assertTrue(first["referenceAnswer"].isNull);assertTrue(first["explanation"].isNull)
        val second=call("GET","/questions?keyword=$marker&pageSize=1&page=2",token=s.token)
        assertNotEquals(first["id"],second["items"].first()["id"])
        call("GET","/questions?keyword=%20",token=s.token,status=422)
        call("GET","/questions?keyword="+"x".repeat(201),token=s.token,status=422)
        assertEquals(2,call("GET","/questions?keyword=$marker",token=null)["total"].asInt())
        val session=createPractice(s,f)
        val result=call("POST","/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText(),"items" to answers(session)),s.token)
        assertEquals(3,call("GET","/me/question-progress",token=s.token)["total"].asInt())
        val short=result["items"].first { it["question"]["type"].asText()=="SHORT_ANSWER" }
        call("PUT","/practice/sessions/${id(session)}/items/${short["itemId"].asText()}/self-assessment",mapOf("expectedVersion" to result["version"].asLong(),"assessment" to "WRONG"),s.token)
        val progress=call("GET","/me/question-progress?questionBankId=${f.bank}&pageSize=2",token=s.token)
        assertEquals(4,progress["total"].asInt());assertEquals(2,progress["items"].size())
        val rest=call("GET","/me/question-progress?questionBankId=${f.bank}&pageSize=2&page=2",token=s.token)
        val all=progress["items"].toList()+rest["items"].toList()
        assertEquals(4,all.map { it["questionId"].asText() }.distinct().size)
        assertEquals("WRONG",all.first { it["questionId"]==short["question"]["id"] }["outcome"].asText())
        assertTrue(all.all { it["questionBankId"].asText()==f.bank.toString() && it["lastPracticedAt"].isTextual })
        assertEquals(0,call("GET","/me/question-progress",token=another.token)["total"].asInt())
        val again=createPractice(s,f)
        val single=again["items"].first { it["question"]["type"].asText()=="SINGLE_CHOICE" }
        call("POST","/practice/sessions/${id(again)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to again["writer"]["writerToken"].asText(),"items" to listOf(mapOf("itemId" to single["itemId"].asText(),"answer" to mapOf("optionKeys" to listOf("C")),"confirmed" to true))),s.token)
        val latest=call("GET","/me/question-progress",token=s.token)
        assertEquals(4,latest["total"].asInt());assertEquals("WRONG",latest["items"].first { it["questionId"]==single["question"]["id"] }["outcome"].asText())
    }

    @Test fun `miniapp runtime uses real HTTP and PostgreSQL for a complete practice`() {
        val s=student();val f=fixture()
        val report=Path.of(".backend-runtime/verification/miniapp-live.json");Files.createDirectories(report.parent)
        val builder=ProcessBuilder("node","../miniapp/tests/live-backend.cjs").redirectErrorStream(true).redirectOutput(report.toFile())
        builder.environment().putAll(mapOf("QANDA_TEST_URL" to "http://127.0.0.1:$port","QANDA_TEST_TOKEN" to s.token,"QANDA_TEST_BANK_ID" to f.bank.toString(),"QANDA_TEST_USER_ID" to s.id.toString()))
        val process=builder.start()
        if(!process.waitFor(90,java.util.concurrent.TimeUnit.SECONDS)) { process.destroyForcibly();fail<Unit>("小程序真实HTTP验收超时") }
        assertEquals(0,process.exitValue(),Files.readString(report));assertTrue(json.readTree(Files.readString(report))["passed"].asBoolean())
    }

    @Test fun `OpenAPI contains current typed endpoints and version one`() {
        val response=http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/v3/api-docs")).GET().build(),HttpResponse.BodyHandlers.ofString())
        assertEquals(200,response.statusCode(),response.body());val spec=json.readTree(response.body())
        assertEquals("1.0.0",spec["info"]["version"].asText());assertTrue(spec["paths"].has("/api/v1/practice/sessions"));assertTrue(spec["components"]["schemas"].has("QuestionInput"))
        val operations=spec["paths"].fields().asSequence().flatMap { it.value.fields().asSequence() }.filter { it.key in setOf("get","post","put","patch","delete") }.map { it.value }.toList()
        assertEquals(operations.size,operations.map { it["operationId"].asText() }.distinct().size)
        val dir=Path.of(".backend-runtime/verification");Files.createDirectories(dir);Files.writeString(dir.resolve("openapi.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(spec))
    }

    @Test fun `verification attempt limits survive failed registration transactions`() {
        val address="${UUID.randomUUID()}@example.test"
        val challenge=call("POST","/auth/email-challenges",mapOf("purpose" to "REGISTER","email" to address),null,201)
        val actual=code(id(challenge));val wrong=if(actual=="000000") "111111" else "000000"
        val payload=mapOf("challengeId" to id(challenge),"code" to wrong,"password" to password)
        repeat(5) { call("POST","/auth/email-registrations",payload,null,409) }
        assertEquals(5,jdbc.queryForObject("SELECT failed_attempts FROM email_challenge WHERE id=?",Int::class.java,id(challenge)))
        call("POST","/auth/email-registrations",payload+mapOf("code" to actual),null,409)
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM user_account WHERE email_key=?",Int::class.java,address))
        call("POST","/auth/email-challenges",mapOf("purpose" to "REGISTER","email" to address),null,429)
        outbox.dispatchOne()
        assertEquals("CANCELLED",jdbc.queryForObject("SELECT state FROM mail_delivery WHERE challenge_id=?",String::class.java,id(challenge)))
    }

    @Test fun `local mail uses encrypted outbox and a real SMTP capture transport`() {
        val address="${UUID.randomUUID()}@example.test"
        val challenge=call("POST","/auth/email-challenges",mapOf("purpose" to "REGISTER","email" to address),null,201)
        repeat(200) { if(jdbc.queryForObject("SELECT state FROM mail_delivery WHERE challenge_id=?",String::class.java,id(challenge))!="ACCEPTED") outbox.dispatchOne() }
        assertEquals("ACCEPTED",jdbc.queryForObject("SELECT state FROM mail_delivery WHERE challenge_id=?",String::class.java,id(challenge)))
        val uri=URI("http://127.0.0.1:${mailpit.getMappedPort(8025)}/api/v1/search?query="+java.net.URLEncoder.encode("to:$address",Charsets.UTF_8))
        val search=json.readTree(http.send(HttpRequest.newBuilder(uri).GET().build(),HttpResponse.BodyHandlers.ofString()).body())
        val messageId=search["messages"].first()["ID"].asText()
        val message=json.readTree(http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:${mailpit.getMappedPort(8025)}/api/v1/message/$messageId")).GET().build(),HttpResponse.BodyHandlers.ofString()).body())
        assertTrue(message["Text"].asText().contains(code(id(challenge))))
        val material=jdbc.queryForObject("SELECT ciphertext FROM mail_delivery WHERE challenge_id=?",String::class.java,id(challenge))!!
        assertFalse(material.contains(address));assertFalse(material.contains(code(id(challenge))))
    }

    @Test fun `HTTP rejects unknown duplicate malformed and oversized input with structured errors`() {
        val duplicate="{\"name\":\"甲\",\"name\":\"乙\",\"code\":\"DUP\"}".toByteArray()
        assertEquals(400,raw("POST","/admin/colleges",duplicate).statusCode())
        call("POST","/admin/colleges",mapOf("name" to "额外字段","code" to "UNKNOWN","unexpected" to true),status=400)
        assertEquals(400,raw("POST","/admin/colleges",byteArrayOf(0xc3.toByte(),0x28)).statusCode())
        val media=raw("GET","/health",token=null,accept="text/html")
        assertEquals(406,media.statusCode());assertEquals("NOT_ACCEPTABLE",json.readTree(media.body())["code"].asText())
        assertEquals("application/json",media.headers().firstValue("Content-Type").orElseThrow().substringBefore(';'))
        val f=fixture()
        assertEquals(413,raw("POST","/admin/question-banks/${f.bank}/images",ByteArray(5*1024*1024+1),contentType="image/png").statusCode())
    }

    @Test fun `password resets disable old sessions and disabled accounts cannot authenticate`() {
        val s=student()
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",s.email)
        val challenge=call("POST","/auth/email-challenges",mapOf("purpose" to "RESET_PASSWORD","email" to s.email),null,201)
        val newPassword="New-learner-password-456"
        call("POST","/auth/password-resets",mapOf("challengeId" to id(challenge),"code" to code(id(challenge)),"newPassword" to newPassword),null)
        call("GET","/me",token=s.token,status=401)
        call("POST","/auth/sessions",mapOf("email" to s.email,"password" to password,"deviceId" to UUID.randomUUID()),null,401)
        val login=call("POST","/auth/sessions",mapOf("email" to s.email,"password" to newPassword,"deviceId" to UUID.randomUUID()),null)
        val token=login["accessToken"].asText();val me=call("GET","/me",token=token)
        call("PUT","/admin/users/${s.id}/status",mapOf("expectedVersion" to me["version"].asLong(),"status" to "DISABLED"))
        call("GET","/me",token=token,status=401)
    }

    @Test fun `configured administrator login locking idle timeout and password rules are enforced`() {
        val before=call("GET","/admin/security-policy")
        val strict=mapOf("expectedVersion" to before["version"].asLong(),"lockEnabled" to true,"maxAttempts" to 3,"lockMinutes" to 5,"sessionMinutes" to 5,"minPasswordLength" to 16,"requireLetter" to true,"requireNumber" to true,"requireMixedCase" to false)
        call("PUT","/admin/security-policy",strict)
        try {
            call("POST","/admin/administrators",mapOf("username" to "short_${UUID.randomUUID().toString().take(8)}","name" to "短密码","password" to "Abc123456789"),status=422)
            val username="locked_${UUID.randomUUID().toString().take(8)}"
            val target=id(call("POST","/admin/administrators",mapOf("username" to username,"name" to "锁定测试","password" to password)))
            repeat(3) { call("POST","/admin/auth/sessions",mapOf("username" to username,"password" to "Wrong-password-123","deviceId" to UUID.randomUUID()),null,401) }
            call("POST","/admin/auth/sessions",mapOf("username" to username,"password" to password,"deviceId" to UUID.randomUUID()),null,429)
            jdbc.update("DELETE FROM login_attempt")
            val login=call("POST","/admin/auth/sessions",mapOf("username" to username,"password" to password,"deviceId" to UUID.randomUUID()),null)
            jdbc.update("UPDATE admin_session SET last_seen_at=now()-interval '6 minutes' WHERE admin_id=?",target)
            call("GET","/admin/auth/me",token=login["accessToken"].asText(),status=401)
            assertTrue(jdbc.queryForObject("SELECT count(*) FROM audit_log WHERE outcome='FAILURE'",Int::class.java)!!>0)
        } finally {
            val current=call("GET","/admin/security-policy")
            call("PUT","/admin/security-policy",strict+mapOf("expectedVersion" to current["version"].asLong(),"maxAttempts" to 5,"lockMinutes" to 30,"sessionMinutes" to 30,"minPasswordLength" to 12))
        }
    }

    @Test fun `images are normalized scoped and still available to their issued practice owner`() {
        val s=student();val f=fixture()
        val image=BufferedImage(2,2,BufferedImage.TYPE_INT_ARGB);val buffer=ByteArrayOutputStream();ImageIO.write(image,"png",buffer)
        val upload=raw("POST","/admin/question-banks/${f.bank}/images",buffer.toByteArray(),contentType="image/png")
        assertEquals(200,upload.statusCode(),upload.body());val file=id(json.readTree(upload.body()))
        call("PUT","/admin/questions/${f.questions.first()}",question(f.bank,"SINGLE_CHOICE")+mapOf("expectedVersion" to 1,"assetIds" to listOf(file)))
        val session=createPractice(s,f)
        fun readImage(token: String?): HttpResponse<ByteArray> {
            val request=HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/v1/files/$file")).GET()
            if(token!=null)request.header("Authorization","Bearer $token")
            val response=http.send(request.build(),HttpResponse.BodyHandlers.ofByteArray())
            exchanges.add(mapOf("method" to "GET","path" to "/api/v1/files/$file","status" to response.statusCode(),"responseHeaders" to response.headers().map().mapValues { it.value.joinToString(",") },"responseBody" to if(response.statusCode()==200) null else json.readTree(response.body())))
            if(response.statusCode()==200) { assertEquals("image/png",response.headers().firstValue("Content-Type").orElseThrow());assertEquals(listOf("nosniff"),response.headers().allValues("X-Content-Type-Options"));assertArrayEquals(buffer.toByteArray(),response.body()) }
            return response
        }
        assertEquals(200,readImage(s.token).statusCode())
        assertEquals(200,readImage(null).statusCode())
        jdbc.update("UPDATE question SET status='INACTIVE' WHERE id=?",f.questions.first())
        assertEquals(404,readImage(null).statusCode())
        assertEquals(200,readImage(s.token).statusCode())
        jdbc.update("UPDATE question SET status='ACTIVE' WHERE id=?",f.questions.first())
        val bank=call("GET","/admin/question-banks/${f.bank}")
        call("PUT","/admin/question-banks/${f.bank}/publication",mapOf("expectedVersion" to bank["version"].asLong(),"status" to "UNPUBLISHED"))
        call("GET","/question-banks/${f.bank}",token=s.token,status=404)
        assertEquals(404,readImage(null).statusCode())
        assertEquals(200,readImage(s.token).statusCode())
        assertEquals(404,readImage(student().token).statusCode())
        call("GET","/practice/sessions/${id(session)}",token=s.token)
        assertEquals(415,raw("POST","/admin/question-banks/${f.bank}/images","<svg/>".toByteArray(),contentType="image/svg+xml").statusCode())
    }

    @Test fun `local WeChat registration creates optional profile without a student email`() {
        val first=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-1:${UUID.randomUUID()}","deviceId" to UUID.randomUUID()),null)
        assertTrue(first["session"].isNull)
        val registration=call("POST","/auth/wechat-registrations",mapOf("registrationToken" to first["registrationToken"].asText(),"nickname" to "微信学生"),null,201)
        val login=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-1:${UUID.randomUUID()}","deviceId" to UUID.randomUUID()),null)
        val user=call("GET","/me",token=login["session"]["accessToken"].asText())
        assertEquals(registration["id"],user["id"]);assertTrue(user["email"].isNull);assertTrue(user["majorId"].isNull);assertTrue(user["wechatBound"].asBoolean())
    }

    @Test fun `database rejects broken references and immutable historical edits`() {
        assertThrows(org.springframework.dao.DataIntegrityViolationException::class.java) { jdbc.update("INSERT INTO major(id,college_id,code,name,status) VALUES(?,?,?,?,'ACTIVE')",UUID.randomUUID(),UUID.randomUUID(),"BAD","非法专业") }
        val f=fixture()
        assertThrows(org.springframework.dao.DataAccessException::class.java) { jdbc.update("UPDATE question_revision SET stem='静默修改' WHERE question_id=?",f.questions.first()) }
        val other=fixture()
        val chapter=id(call("POST","/admin/question-banks/${other.bank}/chapters",mapOf("name" to "其他题库章节","sortOrder" to 0)))
        call("POST","/admin/questions",question(f.bank,"TRUE_FALSE")+mapOf("chapterId" to chapter),status=422)
        assertThrows(org.springframework.dao.DataIntegrityViolationException::class.java) { jdbc.update("UPDATE question SET chapter_id=? WHERE id=?",chapter,f.questions.first()) }
        val s=student()
        assertThrows(org.springframework.dao.DataIntegrityViolationException::class.java) { jdbc.update("INSERT INTO user_subject(user_id,subject_id,preferred_bank_id) VALUES(?,?,?)",s.id,f.subject,other.bank) }
        call("PUT","/me/favorites/${f.questions.first()}",token=s.token)
        assertThrows(org.springframework.dao.DataIntegrityViolationException::class.java) { jdbc.update("INSERT INTO user_favorite(user_id,question_id) VALUES(?,?)",s.id,f.questions.first()) }
        assertEquals(4,jdbc.queryForObject("SELECT count(*) FROM question WHERE bank_id=?",Int::class.java,f.bank))
    }

    @Test fun `statistics use Shanghai calendar days and count one user once across repeated activity`() {
        val s=student();val f=fixture();val session=createPractice(s,f)
        val result=call("POST","/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText(),"items" to answers(session)),s.token)
        jdbc.update("UPDATE practice_session SET submitted_at=? WHERE id=?",java.sql.Timestamp.from(Instant.parse("2026-10-27T16:30:00Z")),id(session))
        val days=call("GET","/me/statistics/days?startDate=2026-10-27&endDateExclusive=2026-10-29",token=s.token)
        assertEquals(0,days[0]["practiceCount"].asInt());assertEquals(1,days[1]["practiceCount"].asInt())
        val daily=call("GET","/me/statistics?period=DAY&periodDate=2026-10-28",token=s.token)
        assertEquals(1,daily["practiceCount"].asInt());assertEquals(3,daily["correctCount"].asInt())
        activityProjection.drain()
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM user_activity WHERE user_id=? AND platform='WEB'",Int::class.java,s.id))
    }

    @Test fun `statistics reject dates outside the supported database range`() {
        val s=student();val date="%2B999999999-12-31"
        call("GET","/me/statistics?period=DAY&periodDate=$date",token=s.token,status=422)
        call("GET","/admin/students/${s.id}/statistics?period=DAY&periodDate=$date",status=422)
        call("GET","/admin/statistics/summary?period=DAY&periodDate=$date",status=422)
        call("GET","/admin/statistics/activity?period=DAY&periodDate=$date",status=422)
        call("GET","/admin/statistics/rankings?period=DAY&periodDate=$date",status=422)
        call("GET","/admin/statistics/organizations?period=DAY&periodDate=$date",status=422)
        call("GET","/me/statistics/days?startDate=$date&endDateExclusive=$date",token=s.token,status=422)
    }

    @Test fun `directories chapter ordering account lists and session ownership use real relational records`() {
        val s=student();val f=fixture()
        val college=id(call("POST","/admin/colleges",mapOf("name" to "目录${UUID.randomUUID()}","code" to UUID.randomUUID().toString())))
        val major=id(call("POST","/admin/majors",mapOf("collegeId" to college,"name" to "目录专业","code" to "M")))
        assertTrue(call("GET","/colleges?pageSize=100",token=null)["items"].any { it["id"].asText()==college.toString() })
        assertEquals(major.toString(),call("GET","/colleges/$college/majors",token=null)["items"].first()["id"].asText())
        call("PUT","/admin/colleges/$college",mapOf("name" to "更新后的学院","code" to UUID.randomUUID().toString(),"expectedVersion" to 1))
        call("PUT","/admin/majors/$major",mapOf("collegeId" to college,"name" to "更新后的专业","code" to "UPDATED","expectedVersion" to 1))
        call("PUT","/admin/subjects/${f.subject}",mapOf("name" to "更新后的课程${UUID.randomUUID()}","description" to "课程描述","expectedVersion" to 1))
        call("GET","/admin/colleges");call("GET","/admin/colleges/$college/majors");call("GET","/admin/subjects");call("GET","/subjects",token=s.token);call("GET","/subjects/${f.subject}",token=s.token)
        val first=id(call("POST","/admin/question-banks/${f.bank}/chapters",mapOf("name" to "第一章","sortOrder" to 0)))
        val second=id(call("POST","/admin/question-banks/${f.bank}/chapters",mapOf("name" to "第二章","sortOrder" to 1)))
        val bank=call("GET","/admin/question-banks/${f.bank}")
        call("GET","/admin/question-banks");call("GET","/admin/question-banks/${f.bank}/chapters")
        call("GET","/question-banks?subjectId=${f.subject}",token=s.token)
        call("PUT","/admin/question-banks/${f.bank}/chapter-order",mapOf("expectedContentVersion" to bank["contentVersion"].asLong(),"ids" to listOf(second,first)))
        assertEquals(second.toString(),call("GET","/question-banks/${f.bank}/chapters",token=s.token).first()["id"].asText())
        call("PUT","/admin/question-banks/${f.bank}/chapters/$first",mapOf("name" to "已修改章节","sortOrder" to 1,"expectedVersion" to 2))
        call("DELETE","/admin/question-banks/${f.bank}/chapters/$second?expectedVersion=2")
        call("PUT","/admin/questions/${f.questions.first()}",question(f.bank,"SINGLE_CHOICE")+mapOf("chapterId" to first,"expectedVersion" to 1))
        call("DELETE","/admin/question-banks/${f.bank}/chapters/$first?expectedVersion=3",status=409)
        assertEquals(1,call("GET","/question-banks/${f.bank}/questions?chapterId=$first",token=s.token)["total"].asInt())
        assertTrue(call("GET","/questions/${f.questions.first()}",token=s.token)["correctAnswer"].isNull)
        assertEquals("原题SINGLE_CHOICE",call("GET","/admin/questions/${f.questions.first()}")["stem"].asText())
        assertEquals(4,call("GET","/admin/question-banks/${f.bank}/questions")["total"].asInt())
        call("DELETE","/admin/questions/${f.questions.last()}?expectedVersion=1")
        assertEquals(3,call("GET","/question-banks/${f.bank}/questions",token=s.token)["total"].asInt())
        assertEquals("1.0.0",call("GET","/health",token=null)["version"].asText())
        val me=call("GET","/me",token=s.token)
        call("PUT","/me/wechat-binding",mapOf("expectedVersion" to me["version"].asLong(),"code" to "local-learner-3:${UUID.randomUUID()}"),s.token)
        assertTrue(call("GET","/me",token=s.token)["wechatBound"].asBoolean())
        assertTrue(call("GET","/admin/administrators")["items"].any { it["id"].asText()==platformId.toString() })
        call("GET","/admin/users/${s.id}");call("GET","/admin/users")
        val other=student();val otherSession=call("GET","/me/sessions",token=other.token).first()["id"].asText()
        call("DELETE","/me/sessions/$otherSession",token=s.token,status=404)
        call("DELETE","/auth/sessions/current",token=other.token)
        call("GET","/me",token=other.token,status=401)
        val extra=call("POST","/auth/sessions",mapOf("email" to s.email,"password" to password,"deviceId" to UUID.randomUUID()),null)
        call("DELETE","/me/sessions/${extra["sessionId"].asText()}",token=s.token)
        call("GET","/me",token=extra["accessToken"].asText(),status=401)
    }

    @Test fun `email binding password change and two proofs for email replacement preserve one user identity`() {
        val ticket=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-2:${UUID.randomUUID()}","deviceId" to UUID.randomUUID()),null)
        val registration=call("POST","/auth/wechat-registrations",mapOf("registrationToken" to ticket["registrationToken"].asText()),null,201)
        fun wechatToken(): String=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-2:${UUID.randomUUID()}","deviceId" to UUID.randomUUID()),null)["session"]["accessToken"].asText()
        val token=wechatToken();val address="${UUID.randomUUID()}@example.test"
        val binding=call("POST","/me/email-challenges",mapOf("purpose" to "BIND_EMAIL","email" to address),token)
        call("PUT","/me/email-binding",mapOf("expectedVersion" to 1,"newChallengeId" to id(binding),"newCode" to code(id(binding))),token)
        call("GET","/me",token=token,status=401)
        val boundToken=wechatToken()
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",address)
        val passwordProof=call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_PASSWORD"),boundToken)
        call("PUT","/me/password",mapOf("expectedVersion" to 2,"challengeId" to id(passwordProof),"code" to code(id(passwordProof)),"newPassword" to password),boundToken)
        val login=call("POST","/auth/sessions",mapOf("email" to address,"password" to password,"deviceId" to UUID.randomUUID()),null)
        val currentToken=login["accessToken"].asText()
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",address)
        val oldProof=call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_EMAIL_OLD"),currentToken)
        val replacement="${UUID.randomUUID()}@example.test"
        val newProof=call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_EMAIL_NEW","email" to replacement),currentToken)
        call("PUT","/me/email-binding",mapOf("expectedVersion" to 3,"oldChallengeId" to id(oldProof),"oldCode" to code(id(oldProof)),"newChallengeId" to id(newProof),"newCode" to code(id(newProof))),currentToken)
        val finalLogin=call("POST","/auth/sessions",mapOf("email" to replacement,"password" to password,"deviceId" to UUID.randomUUID()),null)
        assertEquals(registration["id"],call("GET","/me",token=finalLogin["accessToken"].asText())["id"])
        call("POST","/auth/sessions",mapOf("email" to address,"password" to password,"deviceId" to UUID.randomUUID()),null,401)
    }

    @Test fun `packaged commands initialize an empty isolated database and bootstrap through a real terminal`() {
        PostgreSQLContainer<Nothing>("postgres:17.6-alpine").apply { withDatabaseName("qanda_backend");withUsername("qanda_backend");withPassword("isolated-cli-password") }.use { database ->
            database.start()
            val apiPort=java.net.ServerSocket(0).use { it.localPort }
            val environment=mapOf("BACKEND_MODE" to "test","BACKEND_BIND_ADDRESS" to "127.0.0.1","BACKEND_API_PORT" to apiPort.toString(),
                "BACKEND_DB_URL" to database.jdbcUrl,"BACKEND_DB_USER" to database.username,"BACKEND_DB_PASSWORD" to database.password,
                "BACKEND_COMMAND_DIGEST_KEYS" to "1:$key","BACKEND_IDENTITY_MAC_KEYS" to "1:$key","BACKEND_IDENTITY_RATE_KEY" to key,
                "BACKEND_WECHAT_PROVIDER" to "local","BACKEND_MAIL_ENABLED" to "false","BACKEND_FILES_ENABLED" to "false","BACKEND_DOCS_ENABLED" to "false")
            val config=Files.createTempFile("qanda-cli-verification-",".json")
            try {
                Files.setPosixFilePermissions(config,java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"))
                Files.writeString(config,json.writeValueAsString(mapOf("environment" to environment,"java" to Path.of(System.getProperty("java.home"),"bin","java").toString(),"jar" to Path.of("target/qanda-backend-1.0.0.jar").toAbsolutePath().toString())))
                val report=Path.of(".backend-runtime/verification/bootstrap-cli.json");Files.createDirectories(report.parent)
                val process=ProcessBuilder("python3","scripts/verify-bootstrap-local.py",config.toString()).redirectErrorStream(true).redirectOutput(report.toFile()).start()
                if(!process.waitFor(180,java.util.concurrent.TimeUnit.SECONDS)) {
                    process.descendants().forEach { it.destroyForcibly() };process.destroyForcibly()
                    fail<Unit>("CLI verification timed out")
                }
                assertEquals(0,process.exitValue(),Files.readString(report));assertEquals("PASS",json.readTree(Files.readString(report))["status"].asText())
            } finally { Files.deleteIfExists(config) }
        }
    }

    @Test fun `paged collections keep whole summaries and server selected practice scope`() {
        val s=student();val other=student();val f=fixture()
        val extra=(1..3).map { id(call("POST","/admin/questions",question(f.bank,"SINGLE_CHOICE"))) }
        val ids=f.questions+extra
        ids.forEach { call("PUT","/me/favorites/$it",token=s.token) }
        val summary=call("GET","/me/question-collections/summary?kind=FAVORITE",token=s.token)
        assertEquals(7,summary["total"].asInt());assertEquals(7,summary["pendingCount"].asInt())
        assertEquals(7,summary["facets"].sumOf { it["count"].asInt() })
        assertEquals(0,call("GET","/me/question-collections/summary?kind=FAVORITE",token=other.token)["total"].asInt())
        val first=call("GET","/me/favorites?page=1&pageSize=5&chip=pending&sort=old&subjectId=${f.subject}",token=s.token)
        val second=call("GET","/me/favorites?page=2&pageSize=5&questionBankId=${f.bank}",token=s.token)
        assertEquals(7,first["total"].asInt());assertEquals(5,first["items"].size());assertEquals(2,second["items"].size())
        assertEquals("复习题库",first["items"][0]["questionBankName"].asText())
        call("GET","/me/favorites?chip=repeat",token=s.token,status=422)
        call("GET","/me/question-collections/summary?kind=UNKNOWN",token=s.token,status=422)
        val questions=call("GET","/question-banks/${f.bank}/questions?view=summary&pageSize=5",token=s.token)
        assertEquals(7,questions["total"].asInt());assertEquals(5,questions["items"].size())
        questions["items"].forEach { assertTrue(it["correctAnswer"].isNull);assertTrue(it["explanation"].isNull);assertEquals(0,it["options"].size()) }
        val full=call("GET","/questions/${ids.first()}",token=s.token)
        assertEquals(3,full["options"].size())
        call("GET","/questions?keyword=原题&view=summary&pageSize=5",token=s.token)
        call("GET","/questions?keyword=原题&view=invalid",token=s.token,status=422)
        val bank=call("GET","/question-banks/${f.bank}",token=s.token)
        val session=call("POST","/practice/sessions",mapOf("scope" to mapOf("questionBankId" to f.bank,"selectionKind" to "FAVORITE","collectionChip" to "pending","count" to 7),"expectedContentVersion" to bank["contentVersion"].asLong(),"feedback" to "AFTER_FINISH","deviceId" to UUID.randomUUID()),s.token)
        assertEquals(7,session["items"].size());assertEquals(7,session["favoriteQuestionIds"].size())
        val items=session["items"].map { item -> mapOf("itemId" to item["itemId"].asText(),"answer" to when(item["question"]["type"].asText()) {
            "TRUE_FALSE" -> mapOf("value" to true);"SHORT_ANSWER" -> mapOf("text" to "练习回答");else -> mapOf("optionKeys" to listOf("C"))
        },"confirmed" to true) }
        call("PUT","/practice/sessions/${id(session)}/progress-ack",mapOf("expectedVersion" to 1,"writerToken" to session["writer"]["writerToken"].asText(),"clientSequence" to 1,"currentIndex" to 0,"durationSeconds" to 0,"items" to items),s.token)
        call("POST","/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 2,"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText()),s.token)
        val wrong=call("GET","/me/wrong-questions?pageSize=5&sort=urgent&chip=recent",token=s.token)
        assertEquals(6,wrong["total"].asInt());assertEquals(5,wrong["items"].size())
        val wrongSummary=call("GET","/me/question-collections/summary?kind=WRONG",token=s.token)
        assertEquals(6,wrongSummary["total"].asInt());assertEquals(6,wrongSummary["wrongCount"].asInt());assertEquals(0,wrongSummary["repeatCount"].asInt())
        val overview=call("GET","/me/learning-overview",token=s.token)
        assertEquals(6,overview["answeredCount"].asInt());assertEquals(6,overview["wrongCount"].asInt());assertEquals(7,overview["favoriteCount"].asInt())
        assertEquals(1,overview["practiceCount"].asInt());assertTrue(overview["recentSession"].isNull)
        val progressBanks=call("GET","/question-banks?subjectId=${f.subject}&includeProgress=true",token=s.token)
        assertEquals(7,progressBanks["items"][0]["activeQuestionCount"].asInt());assertEquals(6,progressBanks["items"][0]["progress"]["answeredCount"].asInt())
        call("GET","/subjects?includeProgress=true",token=s.token)
        val subject=call("GET","/subjects/${f.subject}?includeProgress=true",token=s.token)
        assertEquals(7,subject["questionCount"].asInt());assertEquals(1,subject["bankCount"].asInt());assertEquals(6,subject["progress"]["answeredCount"].asInt())
        val after=call("GET","/me/question-collections/summary?kind=FAVORITE",token=s.token)
        assertEquals(6,after["practicedCount"].asInt());assertEquals(1,after["pendingCount"].asInt())
        val repeat=call("GET","/me/wrong-questions?chip=repeat&pageSize=5",token=s.token);assertEquals(0,repeat["total"].asInt())
    }

    @AfterAll fun exportEvidence() {
        consumers.stop()
        val response=http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/v3/api-docs")).GET().build(),HttpResponse.BodyHandlers.ofString())
        val spec=json.readTree(response.body())
        val operations=spec["paths"].fields().asSequence().flatMap { route -> route.value.fields().asSequence().filter { it.key in setOf("get","post","put","patch","delete") }.map { method -> Triple(route.key,method.key.uppercase(),method.value["operationId"].asText()) } }.toList()
        fun redact(node: JsonNode?): JsonNode? {
            if(node==null) return null
            if(node.isObject) {
                val result=json.createObjectNode()
                node.fields().forEachRemaining { (key,value) ->
                    result.set<JsonNode>(key,when {
                        key in setOf("password","newPassword") -> json.valueToTree("Redacted-password-123")
                        key=="writerToken" && value.isTextual -> json.valueToTree("00000000-0000-0000-0000-000000000001")
                        key in setOf("accessToken","registrationToken") && value.isTextual -> json.valueToTree((if(value.asText().startsWith("u_")) "u_" else if(value.asText().startsWith("a_")) "a_" else "")+"x".repeat(43))
                        key in setOf("code","oldCode","newCode") && value.isTextual && value.asText().matches(Regex("[0-9]{6}")) -> json.valueToTree("000000")
                        else -> redact(value)
                    })
                }
                return result
            }
            if(node.isArray) return json.createArrayNode().also { array -> node.forEach { array.add(redact(it)) } }
            return node
        }
        val events=exchanges.mapNotNull { event ->
            val op=operations.firstOrNull { (route,method,_) ->
                method==event["method"] && Regex("^"+route.split(Regex("\\{[^}]+}")).joinToString("[^/]+") { Regex.escape(it) }+"$").matches((event["path"] as String).substringBefore('?'))
            } ?: return@mapNotNull null
            event+mapOf("operationId" to op.third,"requestBody" to redact(event["requestBody"] as? JsonNode),"responseBody" to redact(event["responseBody"] as? JsonNode),"requestHeaders" to ((event["requestHeaders"] as? Map<*,*>) ?: emptyMap<Any,Any>()).mapValues { (key,value) -> if(key=="X-Practice-Writer") "00000000-0000-0000-0000-000000000001" else value })
        }
        val dir=Path.of(".backend-runtime/verification");Files.createDirectories(dir)
        Files.writeString(dir.resolve("openapi.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(spec))
        Files.writeString(dir.resolve("http-redacted.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(events))
        val tables=jdbc.queryForList("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",String::class.java).map { table -> mapOf(
            "name" to table,
            "columns" to jdbc.queryForList("SELECT column_name,data_type,udt_name,character_maximum_length,numeric_precision,numeric_scale,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=? ORDER BY ordinal_position",table),
            "constraints" to jdbc.queryForList("SELECT conname name,contype type,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid=to_regclass(?) ORDER BY conname",table),
            "indexes" to jdbc.queryForList("SELECT indexname name,indexdef definition FROM pg_indexes WHERE schemaname='public' AND tablename=? ORDER BY indexname",table)
        ) }
        Files.writeString(dir.resolve("database-schema.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(tables))
        Files.walk(assetRoot).use { paths -> paths.sorted(java.util.Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) } }
    }
}
