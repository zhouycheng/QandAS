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

class SyncPostgresTest : PostgresFixture() {
    @Test fun `practice stays bound to its creating device and never reveals credentials on reads`() {
        val owner=student();val session=createPractice(owner,fixture());val sessionId=id(session)
        val writer=session["writer"];val token=writer["writerToken"].asText();val device=writer["deviceId"].asText()
        val other=createPractice(owner,fixture())
        val overview=call("GET","/me/learning-overview?deviceId=$device",token=owner.token)
        assertEquals(sessionId.toString(),overview["recentSession"]["id"].asText())
        val recent=call("GET","/me/recent-learning?deviceId=$device",token=owner.token)["items"]
        assertTrue(recent.any { it["id"].asText()==sessionId.toString() })
        assertFalse(recent.any { it["id"].asText()==id(other).toString() })
        val read=call("GET","/practice/sessions/$sessionId",token=owner.token)
        assertTrue(read["writer"]["writerToken"].isNull)
        val otherDevice=raw("GET","/practice/sessions/$sessionId/snapshot?deviceId=${UUID.randomUUID()}",token=owner.token,
            extraHeaders=mapOf("X-Practice-Writer" to token))
        assertEquals(409,otherDevice.statusCode())
        val restored=raw("GET","/practice/sessions/$sessionId/snapshot?deviceId=$device",token=owner.token,
            extraHeaders=mapOf("X-Practice-Writer" to token))
        assertEquals(200,restored.statusCode());assertEquals(token,json.readTree(restored.body())["writer"]["writerToken"].asText())
        call("GET","/practice/sessions/$sessionId",token=student().token,status=404)
        val saved=progress("/practice/sessions/$sessionId/progress-commands",progressBody(session),owner.token)
        assertEquals(token,saved["writer"]["writerToken"].asText())
        assertEquals(device,saved["writer"]["deviceId"].asText())
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

    @Test fun `multi bank practice validates the whole scope and preserves per bank progress`() {
        val s=student();val f=fixture();val outside=fixture()
        val second=id(call("POST","/admin/question-banks",mapOf("subjectId" to f.subject,"name" to "第二题库","description" to "课程练习题库")))
        val q=id(call("POST","/admin/questions",question(second,"SINGLE_CHOICE")))
        val unpublished=call("GET","/admin/question-banks/$second")
        call("PUT","/admin/question-banks/$second/publication",mapOf("expectedVersion" to unpublished["version"].asLong(),"status" to "PUBLISHED"))
        val scope=mapOf("questionBankId" to f.bank,"questionBankIds" to listOf(f.bank,second),"count" to 100,"order" to "SEQUENTIAL")
        fun preview(input: Map<String,Any> = scope)=call("POST","/practice/scope-preview",input,s.token)
        var selection=preview()
        assertEquals(5,selection["selectedCount"].asInt());assertEquals(2,selection["contentVersions"].size())
        fun body()=mapOf("scope" to scope,"expectedContentVersion" to selection["contentVersion"].asLong(),"expectedContentVersions" to selection["contentVersions"],"deviceId" to UUID.randomUUID(),"mode" to "order")
        call("POST","/practice/sessions",body()-"expectedContentVersions",s.token,status=422)
        call("POST","/practice/scope-preview",scope+mapOf("questionBankIds" to listOf(f.bank,f.bank)),s.token,status=422)
        call("POST","/practice/scope-preview",scope+mapOf("questionBankIds" to listOf(f.bank,outside.bank)),s.token,status=422)
        call("POST","/practice/scope-preview",scope+mapOf("questionBankIds" to listOf(second)),s.token,status=422)
        call("POST","/practice/scope-preview",scope+mapOf("questionIds" to listOf(outside.questions.first())),s.token,status=422)
        call("PUT","/admin/questions/$q",question(second,"SINGLE_CHOICE")+mapOf("stem" to "更新后的第二题库","expectedVersion" to 1))
        call("POST","/practice/sessions",body(),s.token,status=409)
        selection=preview()
        val trial=call("POST","/practice/trial-snapshots",body()-"deviceId",token=null)
        assertEquals(5,trial["items"].size());assertEquals(2,trial["configuration"]["questionBankIds"].size())
        val session=call("POST","/practice/sessions",body(),s.token)
        assertEquals(5,session["items"].size());assertEquals(2,session["configuration"]["questionBankIds"].size())
        assertEquals(session["configuration"],call("GET","/practice/sessions/${id(session)}",token=s.token)["configuration"])
        val changed=answers(session).map { item ->
            val original=session["items"].first { it["itemId"].asText()==item["itemId"] }
            if(original["question"]["type"].asText()=="SINGLE_CHOICE") item+mapOf("answer" to mapOf("optionKeys" to listOf("B"))) else item
        }
        val result=call("POST","/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 1,"writerToken" to session["writer"]["writerToken"].asText(),"items" to changed),s.token)
        assertEquals(5,result["totalCount"].asInt());assertEquals(2,result["objective"]["wrong"].asInt())
        val progress=call("GET","/question-banks?subjectId=${f.subject}&includeProgress=true",token=s.token)["items"]
        assertEquals(4,progress.first { it["id"].asText()==f.bank.toString() }["progress"]["answeredCount"].asInt())
        assertEquals(1,progress.first { it["id"].asText()==second.toString() }["progress"]["answeredCount"].asInt())
        assertTrue(progress.all { it["progress"]["wrongCount"].asInt()==1 })
        assertEquals(2,preview(scope+mapOf("selectionKind" to "WRONG"))["selectedCount"].asInt())
        val single=preview(scope+mapOf("questionBankIds" to listOf(f.bank)))
        assertEquals(4,single["selectedCount"].asInt())
        val bank=call("GET","/admin/question-banks/$second")
        call("PUT","/admin/question-banks/$second/publication",mapOf("expectedVersion" to bank["version"].asLong(),"status" to "DRAFT"))
        call("POST","/practice/scope-preview",scope,s.token,status=404)
        assertEquals(5,call("GET","/practice/sessions/${id(session)}/result",token=s.token)["totalCount"].asInt())
    }

    @Test fun `chapters report isolated progress and practice keeps the selected chapter`() {
        val s=student();val other=student();val f=fixture()
        val first=id(call("POST","/admin/question-banks/${f.bank}/chapters",mapOf("name" to "第一章","sortOrder" to 0)))
        val second=id(call("POST","/admin/question-banks/${f.bank}/chapters",mapOf("name" to "第二章","sortOrder" to 1)))
        call("PUT","/admin/questions/${f.questions[0]}",question(f.bank,"SINGLE_CHOICE")+mapOf("chapterId" to first,"expectedVersion" to 1))
        call("PUT","/admin/questions/${f.questions[1]}",question(f.bank,"MULTIPLE_CHOICE")+mapOf("chapterId" to second,"expectedVersion" to 1))
        assertTrue(call("GET","/question-banks/${f.bank}/chapters",token=null).all { it["progress"].isNull })
        val bank=call("GET","/question-banks/${f.bank}",token=s.token)
        val session=call("POST","/practice/sessions",mapOf("scope" to mapOf("questionBankId" to f.bank,"chapterIds" to listOf(first),"count" to 10,"order" to "SEQUENTIAL"),"expectedContentVersion" to bank["contentVersion"].asLong(),"deviceId" to UUID.randomUUID()),s.token)
        assertEquals(1,session["items"].size());assertEquals(f.questions[0].toString(),session["items"].first()["question"]["id"].asText())
        call("POST","/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 1,"writerToken" to session["writer"]["writerToken"].asText(),"items" to answers(session)),s.token)
        val chapters=call("GET","/question-banks/${f.bank}/chapters",token=s.token)
        assertEquals(1,chapters.first()["progress"]["answeredCount"].asInt());assertEquals(1,chapters.first()["progress"]["correctCount"].asInt())
        assertEquals(0,chapters.last()["progress"]["answeredCount"].asInt())
        assertTrue(call("GET","/question-banks/${f.bank}/chapters",token=other.token).all { it["progress"]["answeredCount"].asInt()==0 })
        assertTrue(call("GET","/admin/question-banks/${f.bank}/chapters").all { it["progress"].isNull })
        call("PUT","/admin/questions/${f.questions[0]}",question(f.bank,"SINGLE_CHOICE")+mapOf("chapterId" to first,"expectedVersion" to 2,"status" to "INACTIVE"))
        val inactive=call("GET","/question-banks/${f.bank}/chapters",token=s.token).first()
        assertEquals(0,inactive["questionCount"].asInt());assertEquals(0,inactive["progress"]["answeredCount"].asInt())
        assertEquals(1,call("GET","/admin/question-banks/${f.bank}/chapters").first()["questionCount"].asInt())
    }

    @Test fun `v1 requires writer credentials and exposes one profile read and progress write`() {
        val s=student();val f=fixture();val bank=call("GET","/question-banks/${f.bank}",token=s.token)
        val input=mapOf("scope" to mapOf("questionBankId" to f.bank,"count" to 4),"expectedContentVersion" to bank["contentVersion"].asLong())
        call("POST","/practice/sessions",input,s.token,400)
        val session=createPractice(s,f);val sessionId=id(session)
        progress("/practice/sessions/$sessionId/progress-commands",mapOf("expectedVersion" to 1,"currentIndex" to 0,"durationSeconds" to 0),s.token,400)
        call("PUT","/practice/sessions/$sessionId/progress",mapOf("expectedVersion" to 1),s.token,404)
        call("GET","/me/profile",token=s.token,status=405)
        call("GET","/me",token=s.token)
    }

    @Test fun `global question search is paginated and progress contains latest personal graded outcomes`() {
        val s=student();val f=fixture();val hidden=fixture();val marker="search-${UUID.randomUUID()}"
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
        val short=result["items"].first { it["question"]["type"].asText()=="SHORT_ANSWER" }
        call("PUT","/practice/sessions/${id(session)}/items/${short["itemId"].asText()}/self-assessment",mapOf("expectedVersion" to result["version"].asLong(),"assessment" to "WRONG"),s.token)
        val again=createPractice(s,f)
        val single=again["items"].first { it["question"]["type"].asText()=="SINGLE_CHOICE" }
        call("POST","/practice/sessions/${id(again)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to again["writer"]["writerToken"].asText(),"items" to listOf(mapOf("itemId" to single["itemId"].asText(),"answer" to mapOf("optionKeys" to listOf("C")),"confirmed" to true))),s.token)

    }

    @Test fun `miniapp runtime uses real HTTP and PostgreSQL for a complete practice`() {
        val s=student();val f=fixture()
        val report=evidenceDir.resolve("miniapp-live.json");Files.createDirectories(report.parent)
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
        val schemas=spec["components"]["schemas"]
        assertTrue(schemas["PracticeConfiguration"]["properties"]["mode"]["enum"].any { it.isNull })
        val property=schemas["LoginInput"]["properties"]["password"]
        assertEquals(16,property["minLength"].asInt());assertEquals(16,property["maxLength"].asInt())
        assertTrue(Regex(property["pattern"].asText()).matches("FixedCode1234567"))
        for(name in listOf("RegistrationInput","ResetPasswordInput","PasswordInput")) assertFalse(schemas.has(name))
        assertTrue(spec["paths"].has("/api/v1/search"));assertTrue(spec["paths"]["/api/v1/me"].has("delete"))
        val operations=spec["paths"].fields().asSequence().flatMap { it.value.fields().asSequence() }.filter { it.key in setOf("get","post","put","patch","delete") }.map { it.value }.toList()
        assertEquals(operations.size,operations.map { it["operationId"].asText() }.distinct().size)
        val dir=evidenceDir;Files.createDirectories(dir);Files.writeString(dir.resolve("openapi.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(spec))
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
                val report=evidenceDir.resolve("bootstrap-cli.json");Files.createDirectories(report.parent)
                val process=ProcessBuilder("python3","scripts/verify-bootstrap-local.py",config.toString()).redirectErrorStream(true).redirectOutput(report.toFile()).start()
                if(!process.waitFor(180,java.util.concurrent.TimeUnit.SECONDS)) {
                    process.descendants().forEach { it.destroyForcibly() };process.destroyForcibly()
                    fail<Unit>("CLI verification timed out")
                }
                assertEquals(0,process.exitValue(),Files.readString(report));assertEquals("PASS",json.readTree(Files.readString(report))["status"].asText())
            } finally { Files.deleteIfExists(config) }
        }
    }

}
