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
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
@org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
abstract class PostgresFixture {
    companion object {
        private var sharedAdminId: UUID? = null
        private val sharedExchanges=java.util.concurrent.ConcurrentLinkedQueue<Map<String,Any?>>()
        protected val queueNetwork=org.testcontainers.containers.Network.newNetwork()
        @JvmField val postgres=PostgreSQLContainer<Nothing>("postgres:17.6-alpine").apply {
            withDatabaseName("qanda_backend");withUsername("qanda_backend");withPassword("isolated-test-password")
            withCopyFileToContainer(MountableFile.forClasspathResource("db/schema.sql"),"/docker-entrypoint-initdb.d/001-schema.sql")
            withCopyFileToContainer(MountableFile.forClasspathResource("db/monitoring-permissions.sql"),"/docker-entrypoint-initdb.d/002-monitoring-permissions.sql")
            withCopyFileToContainer(MountableFile.forClasspathResource("db/migration/V2__ProfileSetupAndBankVisibility.sql"),"/docker-entrypoint-initdb.d/003-profile-setup.sql")
            withCopyFileToContainer(MountableFile.forClasspathResource("db/migration/V3__TestAccounts.sql"),"/docker-entrypoint-initdb.d/004-test-accounts.sql")
            withCopyFileToContainer(MountableFile.forClasspathResource("db/migration/V4__EmailCodeLogin.sql"),"/docker-entrypoint-initdb.d/005-email-code.sql")
        }
        @JvmField val mailpit=GenericContainer<Nothing>("axllent/mailpit:v1.32.0").apply { withExposedPorts(1025,8025) }
        @JvmField val rabbit=GenericContainer<Nothing>("rabbitmq:4.2.5-management").apply {
            withNetwork(queueNetwork);withNetworkAliases("rabbitmq")
            withEnv("RABBITMQ_DEFAULT_USER","qanda");withEnv("RABBITMQ_DEFAULT_PASS","isolated-queue-password")
            withExposedPorts(5672,15672,15692)
            withCopyFileToContainer(MountableFile.forHostPath(Path.of("monitoring/rabbitmq-plugins")),"/etc/rabbitmq/enabled_plugins")
            waitingFor(org.testcontainers.containers.wait.strategy.Wait.forLogMessage(".*Server startup complete.*",1))
        }
        @JvmField val prometheus=GenericContainer<Nothing>("prom/prometheus:v3.5.0").apply {
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
        val assetRoot=Files.createTempDirectory("qanda-v1-assets-")
        val key=Base64.getEncoder().encodeToString(ByteArray(32) { 13 })
        @JvmStatic @DynamicPropertySource fun properties(r: DynamicPropertyRegistry) {
            postgres.start();mailpit.start();rabbit.start();prometheus.start()
            r.add("qanda.backend.prometheus-url") { "http://${prometheus.host}:${prometheus.getMappedPort(9090)}" }
            r.add("spring.rabbitmq.host") { rabbit.host };r.add("spring.rabbitmq.port") { rabbit.getMappedPort(5672) }
            r.add("spring.rabbitmq.username") { "qanda" };r.add("spring.rabbitmq.password") { "isolated-queue-password" }
            r.add("qanda.backend.role") { "all" };r.add("qanda.backend.worker-enabled") { true };r.add("management.server.port") { 0 }
            r.add("spring.datasource.url") { postgres.jdbcUrl };r.add("spring.datasource.username") { postgres.username };r.add("spring.datasource.password") { postgres.password }
            r.add("qanda.backend.mode") { "test" };r.add("server.address") { "127.0.0.1" }
            r.add("BACKEND_WECHAT_PROVIDER") { "local" };r.add("BACKEND_COMMAND_DIGEST_KEYS") { "1:$key" };r.add("BACKEND_IDENTITY_MAC_KEYS") { "1:$key" };r.add("BACKEND_IDENTITY_RATE_KEY") { key }
            r.add("BACKEND_TEST_ACCOUNT_ENCRYPTION_KEYS") { "1:$key" };r.add("BACKEND_MAIL_ENCRYPTION_KEYS") { "1:$key" };r.add("qanda.backend.mail.enabled") { true };r.add("qanda.backend.mail.transport") { "local-capture" }
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
    protected val evidenceDir=Path.of(System.getenv("QANDA_QUALITY_EVIDENCE_DIR") ?: ".backend-runtime/verification")
    protected val http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    protected val exchanges=sharedExchanges
    protected lateinit var adminToken: String
    protected lateinit var platformId: UUID
    protected val password="Learner-password-123"
    protected val studentPassword="Learner123"
    protected data class Student(val id: UUID,val email: String,val token: String)
    protected data class Fixture(val subject: UUID,val bank: UUID,val questions: List<UUID>)

    protected fun eventually(seconds: Long=15,condition: () -> Boolean) {
        val end=System.nanoTime()+seconds*1_000_000_000
        while(!condition()) { assertTrue(System.nanoTime()<end,"等待条件超时");Thread.sleep(100) }
    }
    protected fun progressBody(session: JsonNode)=mapOf("expectedVersion" to session["version"].asLong(),"currentIndex" to 0,"durationSeconds" to 0,
        "writerToken" to session["writer"]["writerToken"].asText(),"clientSequence" to 1,"items" to answers(session))
    protected fun queueCounter(name: String): Double {
        val request=HttpRequest.newBuilder(URI("http://${rabbit.host}:${rabbit.getMappedPort(15692)}/metrics/detailed?family=queue_exchange_metrics&family=queue_delivery_metrics")).GET().build()
        val response=http.send(request,HttpResponse.BodyHandlers.ofString());assertEquals(200,response.statusCode())
        return response.body().lineSequence().filter { it.startsWith(name+"{") && it.contains("queue=\"qanda.sync.progress\"") }.sumOf { it.substringAfterLast(' ').toDouble() }
    }

    @BeforeAll fun bootstrap() {
        platformId=sharedAdminId ?: adminService.bootstrap("test_admin","测试管理员","Administrator-password-123").also { sharedAdminId=it }
        adminToken=call("POST","/admin/auth/sessions",mapOf("username" to "test_admin","password" to "Administrator-password-123","deviceId" to UUID.randomUUID()),null)["accessToken"].asText()
        assertEquals(platformId,sessionService.authenticate(adminToken).id)
        learningMapper.days(qanda.backend.platform.queries.StatsFilter(Instant.now().minusSeconds(86400),Instant.now()))
        activityMapper.activityDays(qanda.backend.platform.queries.StatsFilter(Instant.now().minusSeconds(86400),Instant.now()))
    }
    protected fun raw(method: String,path: String,body: Any?=null,token: String?=adminToken,key: UUID?=UUID.randomUUID(),contentType: String="application/json",accept: String?=null,extraHeaders: Map<String,String> = emptyMap()): HttpResponse<String> {
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
    protected fun progress(path: String,body: Any,token: String?,status: Int=200,key: UUID?=UUID.randomUUID()): JsonNode {
        val accepted=raw("POST",path,body,token,key)
        if(accepted.statusCode()!=202) {
            assertEquals(status,accepted.statusCode(),accepted.body())
            return json.readTree(accepted.body())
        }
        var command=json.readTree(accepted.body())
        eventually { command=call("GET","$path/$key",token=token);command["state"].asText() in setOf("COMMITTED","REJECTED") }
        if(command["state"].asText()=="REJECTED") { assertEquals(status,command["failure"]["status"].asInt());return command["failure"] }
        assertEquals(200,status)
        return command["acknowledgement"]
    }
    protected fun call(method: String,path: String,body: Any?=null,token: String?=adminToken,status: Int=200,key: UUID?=UUID.randomUUID()): JsonNode {
        val response=raw(method,path,body,token,key)
        assertEquals(status,response.statusCode(),"$method $path: ${response.body()}")
        assertEquals(listOf("no-store"),response.headers().allValues("Cache-Control"))
        assertEquals(1,response.headers().allValues("X-Request-Id").size)
        UUID.fromString(response.headers().firstValue("X-Request-Id").orElseThrow())
        return json.readTree(response.body())
    }
    protected fun id(value: JsonNode)=UUID.fromString(value["id"].asText())
    protected fun code(challengeId: UUID): String {
        val row=jdbc.queryForMap("SELECT * FROM mail_delivery WHERE challenge_id=?",challengeId)
        val expiry=(row["expires_at"] as java.sql.Timestamp).toInstant()
        return mailCrypto.decrypt(PreparedMailEnvelope(challengeId,row["template_code"] as String,1,expiry,row["ciphertext"] as String,row["nonce"] as String,(row["key_version"] as Number).toInt())).code
    }
    protected fun student(): Student {
        val email="${UUID.randomUUID()}@example.test"
        val challenge=call("POST","/auth/email-challenges",mapOf("purpose" to "REGISTER","email" to email),null,201)
        val registration=call("POST","/auth/email-registrations",mapOf("challengeId" to id(challenge),"code" to code(id(challenge)),"password" to studentPassword,"nickname" to "测试学生"),null,201)
        val login=call("POST","/auth/sessions",mapOf("email" to email,"password" to studentPassword,"deviceId" to UUID.randomUUID()),null)
        return Student(id(registration),email,login["accessToken"].asText())
    }
    protected fun question(bank: UUID,type: String): Map<String,Any?> = mapOf("questionBankId" to bank,"type" to type,"stem" to "原题$type","explanation" to "原解析",
        "options" to if(type.endsWith("CHOICE")) listOf(mapOf("key" to "A","content" to "甲"),mapOf("key" to "B","content" to "乙"),mapOf("key" to "C","content" to "丙")) else emptyList<Any>(),
        "correctAnswer" to when(type) { "SINGLE_CHOICE" -> listOf("A");"MULTIPLE_CHOICE" -> listOf("A","B");else -> emptyList<String>() },
        "correctValue" to false.takeIf { type=="TRUE_FALSE" },"referenceAnswer" to "原参考答案".takeIf { type=="SHORT_ANSWER" })
    protected fun fixture(audiences: List<Map<String,Any>> = emptyList(),maintainers: List<UUID> = emptyList()): Fixture {
        val subject=id(call("POST","/admin/subjects",mapOf("name" to "课程${UUID.randomUUID()}")))
        val bank=id(call("POST","/admin/question-banks",mapOf("subjectId" to subject,"name" to "复习题库","description" to "课程练习题库","scopeType" to if(audiences.isEmpty()) "ALL" else "TARGETED","audiences" to audiences,"maintainerIds" to maintainers)))
        val questions=listOf("SINGLE_CHOICE","MULTIPLE_CHOICE","TRUE_FALSE","SHORT_ANSWER").map { id(call("POST","/admin/questions",question(bank,it))) }
        val current=call("GET","/admin/question-banks/$bank")
        call("PUT","/admin/question-banks/$bank/publication",mapOf("expectedVersion" to current["version"].asLong(),"status" to "PUBLISHED"))
        return Fixture(subject,bank,questions)
    }
    protected fun createPractice(s: Student,f: Fixture,feedback: String="AFTER_FINISH"): JsonNode {
        val bank=call("GET","/question-banks/${f.bank}",token=s.token)
        return call("POST","/practice/sessions",mapOf("scope" to mapOf("questionBankId" to f.bank,"count" to 4,"order" to "RANDOM"),"expectedContentVersion" to bank["contentVersion"].asLong(),"feedback" to feedback,"deviceId" to UUID.randomUUID()),s.token)
    }
    protected fun answers(session: JsonNode): List<Map<String,Any>> = session["items"].map { item ->
        val answer=when(item["question"]["type"].asText()) { "SINGLE_CHOICE" -> mapOf("optionKeys" to listOf("A"));"MULTIPLE_CHOICE" -> mapOf("optionKeys" to listOf("B","A"));"TRUE_FALSE" -> mapOf("value" to false);else -> mapOf("text" to "学生作答") }
        mapOf("itemId" to item["itemId"].asText(),"answer" to answer,"confirmed" to true,"marked" to true)
    }

    @AfterAll fun exportEvidence() {
        val response=http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/v3/api-docs")).GET().build(),HttpResponse.BodyHandlers.ofString())
        val spec=json.readTree(response.body())
        val operations=spec["paths"].fields().asSequence().flatMap { route -> route.value.fields().asSequence().filter { it.key in setOf("get","post","put","patch","delete") }.map { method -> Triple(route.key,method.key.uppercase(),method.value["operationId"].asText()) } }.toList().sortedBy { it.first.count { c -> c=='{' } }
        fun redact(node: JsonNode?): JsonNode? {
            if(node==null) return null
            if(node.isObject) {
                val result=json.createObjectNode()
                node.fields().forEachRemaining { (key,value) ->
                    result.set<JsonNode>(key,when {
                        key in setOf("password","newPassword") -> json.valueToTree("Redacted1234")
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
        val dir=evidenceDir;Files.createDirectories(dir)
        Files.writeString(dir.resolve("openapi.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(spec))
        Files.writeString(dir.resolve("http-redacted.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(events))
        val tables=jdbc.queryForList("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",String::class.java).map { table -> mapOf(
            "name" to table,
            "columns" to jdbc.queryForList("SELECT column_name,data_type,udt_name,character_maximum_length,numeric_precision,numeric_scale,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=? ORDER BY ordinal_position",table),
            "constraints" to jdbc.queryForList("SELECT conname name,contype type,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid=to_regclass(?) ORDER BY conname",table),
            "indexes" to jdbc.queryForList("SELECT indexname name,indexdef definition FROM pg_indexes WHERE schemaname='public' AND tablename=? ORDER BY indexname",table)
        ) }
        Files.writeString(dir.resolve("database-schema.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(tables))

    }
}
