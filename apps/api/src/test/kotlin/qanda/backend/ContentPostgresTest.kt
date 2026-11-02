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

class ContentPostgresTest : PostgresFixture() {
    @Test fun `announcement query timeout leaves catalog and practice available`() {
        val s=student();val f=fixture();val session=createPractice(s,f)
        jdbc.dataSource!!.connection.use { blocked ->
            blocked.autoCommit=false
            try {
                blocked.createStatement().use { it.execute("LOCK TABLE announcement IN ACCESS EXCLUSIVE MODE") }
                val reading=java.util.concurrent.CompletableFuture.supplyAsync { raw("GET","/announcements",null,s.token) }
                call("GET","/me",token=s.token)
                call("GET","/subjects",token=null)
                progress("/practice/sessions/${id(session)}/progress-commands",progressBody(session),s.token)
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
        progress("/practice/sessions/${id(session)}/progress-commands",progressBody(session),s.token)
        call("GET","/announcements",token=s.token)
    }

    @Test fun `guests browse published content and download readonly trial snapshots`() {
        val f=fixture()
        val bank=call("GET","/question-banks/${f.bank}?includeProgress=true",token=null)
        call("GET","/subjects/${f.subject}",token=null)
        call("GET","/question-banks/${f.bank}/chapters",token=null)
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
        assertEquals(f.bank.toString(),call("GET","/question-banks?keyword=聚合章节",token=s.token)["items"].first()["id"].asText())
        call("PUT","/admin/questions/${f.questions.first()}",question(f.bank,"SINGLE_CHOICE")+mapOf("chapterId" to chapter,"expectedVersion" to 2,"status" to "INACTIVE"))
        assertEquals(1,call("GET","/admin/question-banks/${f.bank}/chapters").first()["questionCount"].asInt())
        assertEquals(0,call("GET","/question-banks/${f.bank}/chapters",token=s.token).first()["questionCount"].asInt())
        assertTrue(call("GET","/admin/dashboard")["publishedBankCount"].asLong()>0)
        val logs=call("GET","/admin/audit-logs?keyword=CREATE_COLLEGE&result=SUCCESS&pageSize=1")
        assertTrue(logs["total"].asLong()>0);assertEquals("SUCCESS",logs["items"].first()["outcome"].asText())
        call("GET","/admin/audit-logs?result=UNKNOWN",status=422)
        call("GET","/admin/directory-summary",token=s.token,status=403)
        call("GET","/admin/administrators/$platformId",token=null,status=401)
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

    @Test fun `markdown revisions retain drafts and subjective feedback stays unscored`() {
        val s=student();val f=fixture()
        val code=question(f.bank,"SHORT_ANSWER")+mapOf("contentFormat" to "MARKDOWN","presentation" to "CODE_ANALYSIS","stem" to "说明 `return a + b` 的作用。","referenceAnswer" to "将两个参数相加，并将结果返回给调用者。","scoringPoints" to listOf("返回计算结果。"))
        val codeId=id(call("POST","/admin/questions",code))
        call("POST","/admin/questions",question(f.bank,"SINGLE_CHOICE")+mapOf("presentation" to "CODE_WRITING"),status=422)
        call("POST","/admin/questions",code+mapOf("presentation" to "CODE_WRITING"),status=422)
        val fill=mapOf("questionBankId" to f.bank,"type" to "FILL_BLANK","contentFormat" to "MARKDOWN","presentation" to "CODE_ANALYSIS","stem" to "```javascript\nconst answer = {{1}}; // \\{{literal}}\n```","explanation" to "### 结论\n输出 `API`。","blanks" to listOf(mapOf("answers" to listOf("API"))),"blankMatch" to mapOf("ignoreCase" to false,"trimWhitespace" to true))
        val fillId=id(call("POST","/admin/questions",fill))
        val bank=call("GET","/question-banks/${f.bank}",token=s.token)
        fun create(ids: List<UUID>,feedback: String="IMMEDIATE",mode: String="practice")=call("POST","/practice/sessions",mapOf("scope" to mapOf("questionBankId" to f.bank,"count" to ids.size,"questionIds" to ids),"expectedContentVersion" to bank["contentVersion"].asLong(),"feedback" to feedback,"mode" to mode,"timeLimitSeconds" to 120,"deviceId" to UUID.randomUUID()),s.token)
        val session=create(listOf(f.questions[0],codeId,fillId));val sid=id(session);val writer=session["writer"]["writerToken"].asText()
        assertEquals("practice",session["configuration"]["mode"].asText());assertEquals(120,session["configuration"]["timeLimitSeconds"].asInt())
        val drafts=session["items"].filter { it["question"]["id"].asText()!=f.questions[0].toString() }.map { item -> mapOf("itemId" to item["itemId"].asText(),"confirmed" to false,"answer" to if(item["question"]["type"].asText()=="SHORT_ANSWER") mapOf("text" to "function add(a, b) {\n  return a + b;\n}") else mapOf("blanks" to listOf(" api "))) }
        progress("/practice/sessions/$sid/progress-commands",mapOf("expectedVersion" to 1,"writerToken" to writer,"clientSequence" to 1,"currentIndex" to 0,"durationSeconds" to 0,"items" to drafts),s.token)
        val saved=call("GET","/practice/sessions/$sid",token=s.token)
        assertTrue(saved["items"].all { it["question"]["referenceAnswer"].isNull && it["question"]["explanation"].isNull })
        val codeItem=saved["items"].first { it["question"]["id"].asText()==codeId.toString() }
        assertEquals("CODE_ANALYSIS",codeItem["question"]["presentation"].asText());assertEquals("MARKDOWN",codeItem["question"]["contentFormat"].asText())
        call("PUT","/admin/questions/$codeId",code+mapOf("expectedVersion" to 1,"contentFormat" to "PLAIN_TEXT","stem" to "新版题干"))
        val finish=mapOf("expectedVersion" to 2,"durationSeconds" to 0,"writerToken" to writer)
        val result=call("POST","/practice/sessions/$sid/finish",finish,s.token)
        assertEquals(2,result["answeredCount"].asInt());assertEquals(0,result["objective"]["score"].asInt());assertEquals(1,result["objective"]["wrong"].asInt());assertEquals(1,result["objective"]["unanswered"].asInt())
        val short=result["items"].first { it["question"]["id"].asText()==codeId.toString() }
        assertTrue(short["confirmed"].asBoolean());assertEquals("说明 `return a + b` 的作用。",short["question"]["stem"].asText());assertEquals("MARKDOWN",short["question"]["contentFormat"].asText())
        assertEquals("将两个参数相加，并将结果返回给调用者。",short["question"]["referenceAnswer"].asText())
        val rated=call("PUT","/practice/sessions/$sid/items/${short["itemId"].asText()}/self-assessment",mapOf("expectedVersion" to result["version"].asLong(),"assessment" to "WRONG"),s.token)
        assertEquals(result["objective"],rated["objective"])
        val wrong=call("GET","/me/wrong-questions",token=s.token);assertEquals(1,wrong["total"].asInt());assertEquals(fillId.toString(),wrong["items"].first()["questionId"].asText())
        val latestBank=call("GET","/question-banks/${f.bank}",token=s.token)
        val subjective=call("POST","/practice/sessions",mapOf("scope" to mapOf("questionBankId" to f.bank,"count" to 1,"questionIds" to listOf(codeId)),"expectedContentVersion" to latestBank["contentVersion"].asLong(),"feedback" to "IMMEDIATE","deviceId" to UUID.randomUUID()),s.token)
        val answer=mapOf("itemId" to subjective["items"].first()["itemId"].asText(),"answer" to mapOf("text" to "我的理解"),"confirmed" to true)
        progress("/practice/sessions/${id(subjective)}/progress-commands",mapOf("expectedVersion" to 1,"writerToken" to subjective["writer"]["writerToken"].asText(),"clientSequence" to 1,"currentIndex" to 0,"durationSeconds" to 0,"items" to listOf(answer)),s.token)
        val hidden=call("GET","/practice/sessions/${id(subjective)}",token=s.token)
        assertTrue(hidden["items"].first()["question"]["referenceAnswer"].isNull)
        val done=call("POST","/practice/sessions/${id(subjective)}/finish",mapOf("expectedVersion" to 2,"writerToken" to subjective["writer"]["writerToken"].asText(),"durationSeconds" to 0),s.token)
        assertTrue(done["objective"]["score"].isNull);assertTrue(done["objective"]["accuracy"].isNull)
        val stats=call("GET","/me/statistics?period=ALL",token=s.token);assertEquals(3,stats["answeredCount"].asInt());assertEquals(1,stats["wrongCount"].asInt());assertEquals(1,stats["selfRatedWrongCount"].asInt())
        assertEquals(0,done["shortAnswer"]["rated"].asInt());assertEquals(0,done["shortAnswer"]["correct"].asInt());assertEquals(0,done["shortAnswer"]["wrong"].asInt())
        val selfReview=call("GET","/me/wrong-questions?chip=subjective",token=s.token)
        assertEquals(1,selfReview["total"].asInt());assertEquals(codeId.toString(),selfReview["items"].first()["questionId"].asText());assertEquals(0,selfReview["items"].first()["wrongCount"].asInt())
        val summary=call("GET","/me/question-collections/summary?kind=WRONG",token=s.token)
        assertEquals(1,summary["total"].asInt());assertEquals(1,summary["subjectiveCount"].asInt());assertEquals(1,summary["subjectiveFacets"].size())
        val scope=call("POST","/practice/scope-preview",mapOf("questionBankId" to f.bank,"count" to 10,"selectionKind" to "WRONG","collectionChip" to "subjective"),s.token)
        assertEquals(1,scope["selectedCount"].asInt());assertEquals(codeId.toString(),scope["selectedQuestionIds"].first().asText())
        val mastered=call("PUT","/practice/sessions/$sid/items/${short["itemId"].asText()}/self-assessment",mapOf("expectedVersion" to rated["version"].asLong(),"assessment" to "CORRECT"),s.token)
        assertEquals(result["objective"],mastered["objective"])
        assertEquals(0,call("GET","/me/wrong-questions?chip=subjective",token=s.token)["total"].asInt())
        val studyInput=mapOf("scope" to mapOf("questionBankId" to f.bank,"count" to 1,"questionIds" to listOf(codeId)),"expectedContentVersion" to latestBank["contentVersion"].asLong(),"feedback" to "AFTER_FINISH","mode" to "view","deviceId" to UUID.randomUUID())
        val study=call("POST","/practice/sessions",studyInput,s.token)
        assertFalse(study["items"].first()["question"]["referenceAnswer"].isNull)
        call("POST","/practice/sessions/${id(study)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,"writerToken" to study["writer"]["writerToken"].asText()),s.token,409)
        val trial=call("POST","/practice/trial-snapshots",studyInput.filterKeys { it!="deviceId" },null)
        assertFalse(trial["items"].first()["question"]["referenceAnswer"].isNull)
        assertEquals("view",trial["configuration"]["mode"].asText())
        call("POST","/practice/sessions",studyInput+mapOf("timeLimitSeconds" to 1),s.token,422)
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

    @Test fun `immediate feedback freezes confirmed answers and wrong favorite practice can be resumed or cancelled`() {
        val s=student();val f=fixture();val session=createPractice(s,f,"IMMEDIATE");val sessionId=id(session)
        val multiple=session["items"].first { it["question"]["type"].asText()=="MULTIPLE_CHOICE" }
        val itemId=multiple["itemId"].asText();val questionId=multiple["question"]["id"].asText()
        fun progress(version: Int,keys: List<String>,confirmed: Boolean)=mapOf("expectedVersion" to version,"currentIndex" to 0,"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText(),"clientSequence" to version,
            "items" to listOf(mapOf("itemId" to itemId,"answer" to mapOf("optionKeys" to keys),"confirmed" to confirmed)))
        progress("/practice/sessions/$sessionId/progress-commands",progress(1,listOf("A"),false),s.token)
        val draft=call("GET","/practice/sessions/$sessionId",token=s.token)
        assertTrue(draft["items"].first { it["itemId"].asText()==itemId }["question"]["correctAnswer"].isNull)
        progress("/practice/sessions/$sessionId/progress-commands",progress(2,listOf("B","A"),true),s.token)
        val confirmed=call("GET","/practice/sessions/$sessionId",token=s.token)
        assertEquals("CORRECT",confirmed["items"].first { it["itemId"].asText()==itemId }["outcome"].asText())
        progress("/practice/sessions/$sessionId/progress-commands",progress(3,listOf("A","B"),true),s.token)
        progress("/practice/sessions/$sessionId/progress-commands",progress(4,listOf("A"),true),s.token,409)
        call("POST","/practice/sessions/$sessionId/cancel",mapOf("expectedVersion" to 4,"writerToken" to session["writer"]["writerToken"].asText()),s.token)
        progress("/practice/sessions/$sessionId/progress-commands",progress(5,listOf("A","B"),true),s.token,409)
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
        assertEquals(id(wrong).toString(),call("GET","/me/recent-learning",token=s.token)["items"].first()["id"].asText())
        call("DELETE","/me/favorites/$questionId",token=s.token)
        assertEquals(0,call("POST","/practice/scope-preview",scope("FAVORITE"),s.token)["availableCount"].asInt())
    }

    @Test fun `announcements respect recipients platforms and scheduled visibility`() {
        val one=student();val two=student()
        val announcement=id(call("POST","/admin/announcements",mapOf("title" to "定向公告","summary" to "摘要","body" to "正文","audience" to "SELECTED","userIds" to listOf(one.id),"status" to "SCHEDULED","publishAt" to Instant.now().plusSeconds(3600))))
        call("PUT","/admin/announcements/$announcement",mapOf("title" to "更新后的定向公告","summary" to "摘要","body" to "正文","audience" to "SELECTED","userIds" to listOf(one.id),"status" to "SCHEDULED","publishAt" to Instant.now().plusSeconds(3600),"expectedVersion" to 1))
        assertTrue(call("GET","/admin/announcements")["items"].any { it["id"].asText()==announcement.toString() })
        assertFalse(call("GET","/announcements",token=one.token)["items"].any { it["id"].asText()==announcement.toString() })
        jdbc.update("UPDATE announcement SET publish_at=now()-interval '1 minute' WHERE id=?",announcement)
        assertTrue(call("GET","/announcements",token=one.token)["items"].any { it["id"].asText()==announcement.toString() })
        assertFalse(call("GET","/announcements",token=two.token)["items"].any { it["id"].asText()==announcement.toString() })
        call("DELETE","/admin/announcements/$announcement?expectedVersion=2")
        assertFalse(call("GET","/announcements",token=one.token)["items"].any { it["id"].asText()==announcement.toString() })
    }

    @Test fun `announcements keep pinned community notice ahead of newer notices`() {
        val s=student()
        val body=mapOf("title" to "欢迎加入 QandA 用户交流群","summary" to "欢迎交流和反馈","body" to "课程复习与题库练习","status" to "PUBLISHED","pinned" to true,"showCommunityGroup" to true)
        val pinned=id(call("POST","/admin/announcements",body))
        val ordinary=id(call("POST","/admin/announcements",body + mapOf("title" to "更新公告","pinned" to false,"showCommunityGroup" to false)))
        val first=call("GET","/announcements?pageSize=1",token=s.token)["items"].first()
        assertEquals(pinned.toString(),first["id"].asText());assertTrue(first["showCommunityGroup"].asBoolean())
        call("PUT","/admin/announcements/$pinned",body + mapOf("pinned" to false,"expectedVersion" to 1))
        assertFalse(call("GET","/admin/announcements")["items"].first { it["id"].asText()==pinned.toString() }["pinned"].asBoolean())
        call("DELETE","/admin/announcements/$pinned?expectedVersion=2");call("DELETE","/admin/announcements/$ordinary?expectedVersion=1")
    }

    @Test fun `community group validates image permissions concurrency and expiry`() {
        val current=call("GET","/community/group",token=null)
        assertFalse(current["available"].asBoolean())
        call("GET","/admin/community/group",token=null,status=401)
        val image=ByteArrayOutputStream().also { ImageIO.write(BufferedImage(32,32,BufferedImage.TYPE_INT_RGB),"png",it) }.toByteArray()
        val body=mapOf("expectedVersion" to current["version"].asLong(),"image" to "data:image/png;base64,"+Base64.getEncoder().encodeToString(image),"expiresAt" to Instant.now().plusSeconds(3600))
        call("PUT","/admin/community/group",body,token=student().token,status=403)
        call("PUT","/admin/community/group",body + mapOf("expiresAt" to Instant.now().minusSeconds(1)),status=422)
        call("PUT","/admin/community/group",body + mapOf("image" to "data:image/png;base64,broken!"),status=422)
        val key=UUID.randomUUID()
        val saved=call("PUT","/admin/community/group",body,key=key)
        assertEquals(saved,call("PUT","/admin/community/group",body,key=key))
        assertTrue(call("GET","/community/group",token=null)["available"].asBoolean())
        call("PUT","/admin/community/group",body,status=409)
        val response=http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/v1/community/group/image")).GET().build(),HttpResponse.BodyHandlers.ofByteArray())
        assertEquals(200,response.statusCode());assertEquals("image/png",response.headers().firstValue("content-type").orElse(""))
        assertTrue(ImageIO.read(response.body().inputStream()) != null)
        jdbc.update("UPDATE community_group SET expires_at=now()-interval '1 minute' WHERE id=1")
        assertFalse(call("GET","/community/group",token=null)["available"].asBoolean())
        call("GET","/community/group/image",token=null,status=404)
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

    @Test fun `database rejects broken references and immutable historical edits`() {
        assertThrows(org.springframework.dao.DataIntegrityViolationException::class.java) { jdbc.update("INSERT INTO major(id,college_id,code,name,status) VALUES(?,?,?,?,'ACTIVE')",UUID.randomUUID(),UUID.randomUUID(),"BAD","非法专业") }
        val f=fixture()
        assertThrows(org.springframework.dao.DataAccessException::class.java) { jdbc.update("UPDATE question_revision SET stem='静默修改' WHERE question_id=?",f.questions.first()) }
        val other=fixture()
        val chapter=id(call("POST","/admin/question-banks/${other.bank}/chapters",mapOf("name" to "其他题库章节","sortOrder" to 0)))
        call("POST","/admin/questions",question(f.bank,"TRUE_FALSE")+mapOf("chapterId" to chapter),status=422)
        assertThrows(org.springframework.dao.DataIntegrityViolationException::class.java) { jdbc.update("UPDATE question SET chapter_id=? WHERE id=?",chapter,f.questions.first()) }
        val s=student()
        call("PUT","/me/favorites/${f.questions.first()}",token=s.token)
        assertThrows(org.springframework.dao.DataIntegrityViolationException::class.java) { jdbc.update("INSERT INTO user_favorite(user_id,question_id) VALUES(?,?)",s.id,f.questions.first()) }
        assertEquals(4,jdbc.queryForObject("SELECT count(*) FROM question WHERE bank_id=?",Int::class.java,f.bank))
    }

}
