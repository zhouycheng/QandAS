package qanda.backend

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.*
import qanda.backend.application.ProgressEnvelope
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
    @Autowired lateinit var registry: io.micrometer.core.instrument.MeterRegistry
    @Test fun `admission rejects stale version before accepting first command`() {
        val owner=student();val session=createPractice(owner,fixture());val sessionId=id(session)
        val path="/practice/sessions/$sessionId/sync-commands"
        val body=progressBody(session)
        call("POST",path,body+mapOf("expectedVersion" to 999),owner.token,409)
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM sync_command WHERE session_id=?",Int::class.java,sessionId))
        consumers.stop()
        try {
            val key=UUID.randomUUID()
            val accepted=call("POST",path,body,owner.token,202,key)
            assertEquals("QUEUED",accepted["state"].asText())
            assertEquals(accepted,call("GET","$path/$key",token=owner.token))
            assertEquals(accepted,call("POST",path,body,owner.token,202,key))
            assertEquals(1,call("GET",path,token=owner.token)["acceptedSequence"].asInt())
        } finally { consumers.start() }
    }

    @Test fun `pending command budgets reject excess storage and stop appending behind terminal failures`() {
        val owner=student();val f=fixture();val session=createPractice(owner,f);val sessionId=id(session);val input=progressBody(session)
        val path="/practice/sessions/$sessionId/sync-commands"
        consumers.stop()
        fun clear() { jdbc.update("DELETE FROM sync_command WHERE session_id=?",sessionId);jdbc.update("UPDATE practice_sync_state SET accepted_sequence=0 WHERE session_id=?",sessionId) }
        fun copies(count: Int) {
            jdbc.update("""INSERT INTO sync_command(id,session_id,user_id,actor_session_id,writer_token,client_sequence,payload_digest,digest_key_version,request_id,kind,payload_json,state)
                SELECT gen_random_uuid(),session_id,user_id,actor_session_id,writer_token,n+1,payload_digest,digest_key_version,request_id,kind,payload_json,'QUEUED'
                FROM sync_command CROSS JOIN generate_series(1,?) n WHERE session_id=? AND client_sequence=1""",count,sessionId)
            jdbc.update("UPDATE practice_sync_state SET accepted_sequence=? WHERE session_id=?",count+1,sessionId)
        }
        try {
            call("POST",path,input,owner.token,202);copies(63)
            val full=raw("POST",path,input+mapOf("clientSequence" to 65),owner.token)
            assertEquals(503,full.statusCode());assertEquals("5",full.headers().firstValue("Retry-After").orElse(null))
            assertEquals(64,jdbc.queryForObject("SELECT count(*) FROM sync_command WHERE session_id=?",Int::class.java,sessionId))
            clear();call("POST",path,input,owner.token,202)
            jdbc.update("UPDATE sync_command SET payload_json=repeat('x',16777216) WHERE session_id=?",sessionId)
            call("POST",path,input+mapOf("clientSequence" to 2),owner.token,503)
            jdbc.update("UPDATE sync_command SET payload_json='{}' WHERE session_id=?",sessionId);copies(255)
            val next=createPractice(owner,f)
            call("POST","/practice/sessions/${id(next)}/sync-commands",progressBody(next),owner.token,503)
            clear();val key=UUID.randomUUID();call("POST",path,input,owner.token,202,key)
            progressCommands.failure(key,qanda.backend.platform.http.ApiException(org.springframework.http.HttpStatus.BAD_REQUEST,"INVALID_ANSWER","作答无效"))
            call("POST",path,input+mapOf("clientSequence" to 2),owner.token,409)
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM sync_command WHERE session_id=?",Int::class.java,sessionId))
        } finally { clear();consumers.start() }
    }
    @Test fun `broker outage accepts complete task and scanner delivers without another client request`() {
        val owner=student();val session=createPractice(owner,fixture());val id=id(session);val key=UUID.randomUUID();val body=progressBody(session)
        consumers.stop();rabbit.dockerClient.pauseContainerCmd(rabbit.containerId).exec()
        try {
            val accepted=call("POST","/practice/sessions/$id/sync-commands",body,owner.token,202,key)
            assertEquals("QUEUED",accepted["state"].asText())
            assertEquals(body["clientSequence"].toString(),json.readTree(jdbc.queryForObject("SELECT payload_json FROM sync_command WHERE id=?",String::class.java,key))["clientSequence"].asText())
            assertEquals(1,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,id))
        } finally { rabbit.dockerClient.unpauseContainerCmd(rabbit.containerId).exec();consumers.start() }
        eventually(40) { progressCommands.dispatch();jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,key)=="COMMITTED" }
        val checkpoint=call("GET","/practice/sessions/$id/sync-commands",token=owner.token)
        assertEquals(1,checkpoint["acceptedSequence"].asInt());assertEquals(1,checkpoint["processedSequence"].asInt())
    }
    @Test fun `save and final snapshot queue in order and duplicate delivery commits a single result`() {
        val owner=student();val session=createPractice(owner,fixture());val id=id(session);val saveKey=UUID.randomUUID();val finishKey=UUID.randomUUID()
        val save=progressBody(session)
        val finish=save+mapOf("kind" to "FINISH","clientSequence" to 2,"items" to answers(session))
        consumers.stop()
        try {
            call("POST","/practice/sessions/$id/sync-commands",save,owner.token,202,saveKey)
            call("POST","/practice/sessions/$id/sync-commands",finish,owner.token,202,finishKey)
            call("POST","/practice/sessions/$id/sync-commands",finish,owner.token,202,finishKey)
            call("POST","/practice/sessions/$id/sync-commands",save+mapOf("clientSequence" to 3),owner.token,409)
            progressCommands.consume(ProgressEnvelope(finishKey))
            assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM practice_result WHERE session_id=?",Int::class.java,id))
            progressCommands.consume(ProgressEnvelope(saveKey));progressCommands.consume(ProgressEnvelope(saveKey))
            progressCommands.consume(ProgressEnvelope(finishKey));progressCommands.consume(ProgressEnvelope(finishKey))
            assertTrue(registry.counter("qanda.sync.commands","stage","duplicate").count()>=2)
            val done=call("GET","/practice/sessions/$id/sync-commands/$finishKey",token=owner.token)
            assertEquals("COMMITTED",done["state"].asText());assertEquals(4,call("GET","/practice/sessions/$id/result",token=owner.token)["answeredCount"].asInt())
            assertEquals(0,call("GET","/practice/sessions/$id/result",token=owner.token)["objective"]["wrong"].asInt())
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM practice_result WHERE session_id=?",Int::class.java,id))
            assertEquals(2,call("GET","/practice/sessions/$id/sync-commands",token=owner.token)["processedSequence"].asInt())
            call("GET","/practice/sessions/$id/sync-commands/$finishKey",token=student().token,status=404)
        } finally { consumers.start() }
    }
    @Test fun `response loss identity conflicts and gaps are resolved by durable receipts`() {
        val owner=student();val session=createPractice(owner,fixture());val id=id(session);val key=UUID.randomUUID();val input=progressBody(session)
        consumers.stop()
        try {
            val first=call("POST","/practice/sessions/$id/sync-commands",input,owner.token,202,key)
            assertEquals(first,call("POST","/practice/sessions/$id/sync-commands",input,owner.token,202,key))
            call("POST","/practice/sessions/$id/sync-commands",input+mapOf("durationSeconds" to 1),owner.token,409,key)
            call("POST","/practice/sessions/$id/sync-commands",input+mapOf("clientSequence" to 3),owner.token,409)
            progressCommands.consume(ProgressEnvelope(key))
            assertEquals("COMMITTED",call("POST","/practice/sessions/$id/sync-commands",input,owner.token,202,key)["state"].asText())
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM command_receipt WHERE command_id=?",Int::class.java,key))
        } finally { consumers.start() }
    }
    @Test fun `temporary failures beyond eight retries and expired dispatch leases recover automatically`() {
        val owner=student();val session=createPractice(owner,fixture());val id=id(session);val key=UUID.randomUUID()
        consumers.stop()
        try {
            call("POST","/practice/sessions/$id/sync-commands",progressBody(session),owner.token,202,key)
            repeat(12) { val result=progressCommands.failure(key,java.io.IOException("transient outage"));assertEquals("retry",result.first);assertTrue(result.second in 1..60000) }
            assertEquals("RETRYING",jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,key))
            jdbc.update("UPDATE sync_command SET next_attempt_at=now(),dispatch_until=now()-interval '1 second' WHERE id=?",key)
            progressCommands.dispatch();consumers.start()
            eventually(40) { jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,key)=="COMMITTED" }
        } finally { consumers.start() }
    }
    @Test fun `accepted work survives natural token expiry but explicit revocation prevents execution`() {
        val owner=student();val session=createPractice(owner,fixture());val id=id(session);val key=UUID.randomUUID()
        consumers.stop()
        try {
            call("POST","/practice/sessions/$id/sync-commands",progressBody(session),owner.token,202,key)
            jdbc.update("UPDATE user_session SET issued_at=now()-interval '1 day',last_seen_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE user_id=?",owner.id)
            progressCommands.consume(ProgressEnvelope(key))
            assertEquals("COMMITTED",jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,key))
            val other=student();val next=createPractice(other,fixture());val rejected=UUID.randomUUID()
            val original=progressBody(next)+mapOf("kind" to "FINISH")
            call("POST","/practice/sessions/${id(next)}/sync-commands",original,other.token,202,rejected)
            jdbc.update("UPDATE user_session SET revoked_at=now() WHERE user_id=?",other.id)
            val error=assertThrows(qanda.backend.platform.http.ApiException::class.java) { progressCommands.consume(ProgressEnvelope(rejected)) }
            progressCommands.failure(rejected,error)
            assertEquals("REJECTED",jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,rejected))
            call("POST","/practice/sessions/${id(next)}/sync-commands",original,other.token,401,rejected)
            jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",other.email)
            val proof=call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to other.email),null,201)
            val login=call("POST","/auth/email-code-sessions",mapOf("challengeId" to id(proof),"code" to code(id(proof)),"deviceId" to UUID.randomUUID()),null)
            val token=login["accessToken"].asText()
            call("POST","/practice/sessions/${id(next)}/sync-commands",original+mapOf("durationSeconds" to 1),token,409,rejected)
            assertEquals("QUEUED",call("POST","/practice/sessions/${id(next)}/sync-commands",original,token,202,rejected)["state"].asText())
            progressCommands.consume(ProgressEnvelope(rejected))
            assertEquals("COMMITTED",call("GET","/practice/sessions/${id(next)}/sync-commands/$rejected",token=token)["state"].asText())
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM practice_result WHERE session_id=?",Int::class.java,id(next)))
        } finally { consumers.start() }
    }    @Test fun `practice stays bound to its creating device and never reveals credentials on reads`() {
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
        val saved=progress("/practice/sessions/$sessionId/sync-commands",progressBody(session),owner.token)
        assertEquals(token,saved["writer"]["writerToken"].asText())
        assertEquals(device,saved["writer"]["deviceId"].asText())
    }

    @Test fun `real broker metrics show paused backlog and SSE revokes expired administrators`() {
        val s=student();val f=fixture();val sessions=(1..12).map { createPractice(s,f) }
        eventually(40) {
            progressCommands.dispatch()
            jdbc.queryForObject("SELECT count(*) FROM sync_command WHERE state IN ('QUEUED','RETRYING')",Int::class.java)==0
        }
        consumers.stop()
        val started=System.nanoTime()
        val cpu=java.lang.management.ManagementFactory.getOperatingSystemMXBean() as com.sun.management.OperatingSystemMXBean
        val cpuBefore=cpu.processCpuTime
        val producedBefore=queueCounter("rabbitmq_detailed_queue_exchange_messages_published_total")
        val consumedBefore=queueCounter("rabbitmq_detailed_queue_messages_acked_total")
        try {
            sessions.forEach { session ->
                call("POST","/practice/sessions/${id(session)}/sync-commands",progressBody(session),s.token,202)
                Thread.sleep(500)
            }
            // Dispatch leases may publish duplicate notifications; business commits remain unique.
            val published=queueCounter("rabbitmq_detailed_queue_exchange_messages_published_total")-producedBefore
            assertTrue(published>=12.0)
            eventually(75) { syncHealth.sample();syncHealth.snapshot().status=="HEALTHY" && syncHealth.snapshot().metrics.queued!!>=12.0 && syncHealth.snapshot().metrics.processing==0.0 && syncHealth.snapshot().metrics.consumers==0.0 }
            val queued=syncHealth.snapshot()
            assertEquals(0.0,queued.metrics.processing);assertEquals(0.0,queued.metrics.consumers)
            assertTrue(queued.metrics.productionPerSecond!!>=0);assertTrue(queued.metrics.consumptionPerSecond!=null)
            consumers.start()
            eventually(30) { syncHealth.sample();syncHealth.snapshot().metrics.queued==0.0 && (syncHealth.snapshot().metrics.consumptionPerSecond ?: 0.0)>0 && (syncHealth.snapshot().metrics.p95LatencyMs ?: 0.0)>0 && sessions.all { jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,id(it))==2 } }
            val drained=syncHealth.snapshot();assertTrue(drained.metrics.committedPerSecond!!>=12/60.0)
            assertTrue(drained.metrics.consumptionPerSecond!!>0);assertTrue(drained.metrics.p95LatencyMs!!>0)
            val acknowledged=queueCounter("rabbitmq_detailed_queue_messages_acked_total")-consumedBefore
            assertTrue(acknowledged>=12.0)
            assertEquals(12,jdbc.queryForObject("SELECT count(*) FROM sync_command WHERE session_id IN (${sessions.joinToString(",") { "?" }}) AND state='COMMITTED'",Int::class.java,*sessions.map { id(it) }.toTypedArray()))
            println("SYNC_METRICS_EVIDENCE commands=12 publishedDelta=$published ackDelta=$acknowledged uniqueCommits=12 producerIntervalMs=500 consumers=4 prefetch=1 elapsedMs=${(System.nanoTime()-started)/1_000_000} processCpuMs=${(cpu.processCpuTime-cpuBefore)/1_000_000} snapshot=${json.writeValueAsString(drained)}")
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
        val result=finish("/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 1,"writerToken" to session["writer"]["writerToken"].asText(),"items" to changed),s.token)
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
        finish("/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 1,"writerToken" to session["writer"]["writerToken"].asText(),"items" to answers(session)),s.token)
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
        progress("/practice/sessions/$sessionId/sync-commands",mapOf("expectedVersion" to 1,"currentIndex" to 0,"durationSeconds" to 0),s.token,400)
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
        val result=finish("/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText(),"items" to answers(session)),s.token)
        val short=result["items"].first { it["question"]["type"].asText()=="SHORT_ANSWER" }
        call("PUT","/practice/sessions/${id(session)}/items/${short["itemId"].asText()}/self-assessment",mapOf("expectedVersion" to result["version"].asLong(),"assessment" to "WRONG"),s.token)
        val again=createPractice(s,f)
        val single=again["items"].first { it["question"]["type"].asText()=="SINGLE_CHOICE" }
        finish("/practice/sessions/${id(again)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to again["writer"]["writerToken"].asText(),"items" to listOf(mapOf("itemId" to single["itemId"].asText(),"answer" to mapOf("optionKeys" to listOf("C")),"confirmed" to true))),s.token)

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
