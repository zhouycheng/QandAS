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

class LearningPostgresTest : PostgresFixture() {
    @Test fun `wrong book preference controls new entries while scores and prior entries stay accurate`() {
        val s=student();val f=fixture()
        fun submit(collect: Boolean,correct: Boolean=false) {
            val session=createPractice(s,f);val items=answers(session).map { answer ->
                if(answer["itemId"]==session["items"].first { it["question"]["id"].asText()==f.questions.first().toString() }["itemId"].asText())
                    answer+mapOf("answer" to mapOf("optionKeys" to listOf(if(correct) "A" else "B"))) else answer
            }
            val body=progressBody(session)+mapOf("items" to items)
            val saved=progress("/practice/sessions/${id(session)}/progress-commands",body,s.token)
            val result=call("POST","/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to saved["version"].asLong(),"durationSeconds" to 0,"writerToken" to body["writerToken"],"autoAddWrongBook" to collect),s.token)
            assertEquals(if(correct) 0 else 1,result["objective"]["wrong"].asInt())
        }
        fun wrongCount()=call("GET","/me/wrong-questions",token=s.token)["total"].asInt()
        submit(false);assertEquals(0,wrongCount())
        val overview=call("GET","/me/learning-overview",token=s.token)
        assertEquals(1,overview["wrongCount"].asInt());assertEquals(0,overview["wrongBookCount"].asInt())
        val bank=call("GET","/question-banks?subjectId=${f.subject}&includeProgress=true",token=s.token)["items"].first()
        assertEquals(0,bank["progress"]["wrongBookCount"].asInt())
        assertEquals(0,call("POST","/practice/scope-preview",mapOf("questionBankId" to f.bank,"selectionKind" to "WRONG"),s.token)["availableCount"].asInt())
        submit(true);assertEquals(1,wrongCount())
        submit(false);assertEquals(1,wrongCount())
        assertEquals(1,call("GET","/me/wrong-questions?chip=repeat",token=s.token)["total"].asInt())
        assertEquals(1,call("POST","/practice/scope-preview",mapOf("questionBankId" to f.bank,"selectionKind" to "WRONG","collectionChip" to "repeat"),s.token)["availableCount"].asInt())
        submit(false,true);assertEquals(0,wrongCount())
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
        val secondDevice=call("POST","/auth/sessions",mapOf("email" to one.email,"password" to studentPassword,"deviceId" to UUID.randomUUID()),null)
        val secondToken=secondDevice["accessToken"].asText()
        call("POST","/me/activity/heartbeat",token=secondToken)
        call("POST","/me/activity/heartbeat",token=two.token)
        activityProjection.drain()
        jdbc.update("INSERT INTO user_activity(user_id,activity_date) VALUES(?,(now() AT TIME ZONE 'Asia/Shanghai')::date-6)",two.id)
        jdbc.update("INSERT INTO user_activity(user_id,activity_date) VALUES(?,(now() AT TIME ZONE 'Asia/Shanghai')::date-29)",three.id)
        val metrics=call("GET","/admin/statistics/activity?period=WEEK&$filter")
        assertEquals(2,metrics["onlineUsers"].asInt());assertEquals(2,metrics["dailyActive"].asInt())
        assertEquals(2,metrics["weeklyActive"].asInt());assertEquals(3,metrics["monthlyActive"].asInt())
        assertEquals(7,metrics["records"].size());assertEquals(5,metrics["records"].count { it["activeUsers"].asInt()==0 })
        assertEquals(2,call("GET","/admin/statistics/activity?period=WEEK&$filter")["onlineUsers"].asInt())
        assertEquals(2L,onlineUsers.list(college,major,1,null,qanda.backend.platform.http.PageSpec(1,20)).total)
        val online=call("GET","/admin/statistics/online-users?$filter")
        assertEquals(2,online["total"].asInt())
        val onlineOne=online["items"].first { it["userId"].asText()==one.id.toString() }
        assertEquals(2,onlineOne["onlineSessionCount"].asInt());assertEquals(1,onlineOne["clients"].size())
        assertEquals(2,call("GET","/admin/statistics/online-users?$filter")["total"].asInt())
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
        call("PUT","/me/favorites/${f.questions.first()}",token=s.token)
        val session=createPractice(s,f);val sessionId=id(session)
        session["items"].forEach { assertTrue(it["question"]["explanation"].isNull);assertTrue(it["question"]["correctAnswer"].isNull);assertTrue(it["question"]["referenceAnswer"].isNull) }
        val originalItem=session["items"].first { it["question"]["type"].asText()=="TRUE_FALSE" }
        val originalQuestion=UUID.fromString(originalItem["question"]["id"].asText())
        call("PUT","/admin/questions/$originalQuestion",question(f.bank,"TRUE_FALSE")+mapOf("stem" to "更新后的题干","correctValue" to true,"expectedVersion" to 1))
        val progress=mapOf("expectedVersion" to 1,"currentIndex" to 1,"durationSeconds" to 0,"items" to answers(session),"writerToken" to session["writer"]["writerToken"].asText(),"clientSequence" to 1)
        val saved=progress("/practice/sessions/$sessionId/progress-commands",progress,s.token)
        progress("/practice/sessions/$sessionId/progress-commands",progress,s.token,409)
        val restored=call("GET","/practice/sessions/$sessionId",token=s.token)
        assertEquals(session["items"].map { it["itemId"].asText() },restored["items"].map { it["itemId"].asText() })
        assertEquals("原题TRUE_FALSE",restored["items"].first { it["question"]["type"].asText()=="TRUE_FALSE" }["question"]["stem"].asText())
        val finish=mapOf("expectedVersion" to saved["version"].asLong(),"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText())
        val result=call("POST","/practice/sessions/$sessionId/finish",finish,s.token)
        assertEquals(result,call("GET","/practice/sessions/$sessionId/result",token=s.token))
        assertEquals(1,call("GET","/admin/students/${s.id}/statistics?period=ALL")["practiceCount"].asInt())
        assertEquals(3,result["objective"]["correct"].asInt());assertEquals(1,result["shortAnswer"]["unrated"].asInt())
        assertEquals(result["id"],call("POST","/practice/sessions/$sessionId/finish",finish,s.token)["id"])
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM practice_result WHERE session_id=?",Int::class.java,sessionId))
        val short=result["items"].first { it["question"]["type"].asText()=="SHORT_ANSWER" }
        call("PUT","/practice/sessions/$sessionId/items/${short["itemId"].asText()}/self-assessment",mapOf("expectedVersion" to result["version"].asLong(),"assessment" to "WRONG"),s.token)
        val stats=call("GET","/me/statistics?period=ALL",token=s.token);assertEquals(1,stats["practiceCount"].asInt());assertEquals(3,stats["correctCount"].asInt());assertEquals(1,stats["selfRatedWrongCount"].asInt())
        assertEquals(0,call("GET","/me/wrong-questions",token=s.token)["total"].asInt())
        assertEquals(1,call("GET","/me/favorites",token=s.token)["total"].asInt())
        val feedback=id(call("POST","/me/question-feedback",mapOf("questionId" to originalQuestion,"revisionId" to originalItem["question"]["revisionId"].asText(),"category" to "ANSWER","body" to "请核查参考答案"),s.token))
        call("PUT","/admin/question-feedback/$feedback",mapOf("expectedVersion" to 1,"status" to "RESOLVED","response" to "已核实并修正"))
        val reply=call("GET","/me/question-feedback",token=s.token)["items"].first { it["id"].asText()==feedback.toString() }
        assertEquals("原题TRUE_FALSE",reply["question"]["stem"].asText());assertEquals("已核实并修正",reply["response"].asText())
        assertTrue(call("GET","/admin/question-feedback")["items"].any { it["id"].asText()==feedback.toString() })
        val request=id(call("POST","/me/course-requests",mapOf("courseName" to "尚未提供的课程","body" to "希望增加复习题库"),s.token))
        call("PUT","/admin/course-requests/$request",mapOf("expectedVersion" to 1,"status" to "IN_PROGRESS","response" to "正在整理"))
        assertEquals("IN_PROGRESS",call("GET","/me/course-requests",token=s.token)["items"].first()["status"].asText())
        assertTrue(call("GET","/admin/course-requests")["items"].any { it["id"].asText()==request.toString() })
        call("GET","/admin/statistics/activity");call("GET","/admin/statistics/rankings");
        assertTrue(call("GET","/admin/dashboard")["answeredCount"].asInt()>=4)
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
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM user_activity WHERE user_id=?",Int::class.java,s.id))
    }

    @Test fun `statistics reject dates outside the supported database range`() {
        val s=student();val date="%2B999999999-12-31"
        call("GET","/me/statistics?period=DAY&periodDate=$date",token=s.token,status=422)
        call("GET","/admin/students/${s.id}/statistics?period=DAY&periodDate=$date",status=422)
        call("GET","/admin/statistics/activity?period=DAY&periodDate=$date",status=422)
        call("GET","/admin/statistics/rankings?period=DAY&periodDate=$date",status=422)
        call("GET","/me/statistics/days?startDate=$date&endDateExclusive=$date",token=s.token,status=422)
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
        val questions=call("GET","/questions?keyword=%E5%8E%9F%E9%A2%98&pageSize=5&view=summary",token=s.token)
        assertTrue(questions["total"].asInt()>=7);assertEquals(5,questions["items"].size())
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
        progress("/practice/sessions/${id(session)}/progress-commands",mapOf("expectedVersion" to 1,"writerToken" to session["writer"]["writerToken"].asText(),"clientSequence" to 1,"currentIndex" to 0,"durationSeconds" to 0,"items" to items),s.token)
        call("POST","/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 2,"durationSeconds" to 0,"writerToken" to session["writer"]["writerToken"].asText()),s.token)
        val wrong=call("GET","/me/wrong-questions?pageSize=5&sort=urgent&chip=recent",token=s.token)
        assertEquals(6,wrong["total"].asInt());assertEquals(5,wrong["items"].size())
        val wrongSummary=call("GET","/me/question-collections/summary?kind=WRONG",token=s.token)
        assertEquals(6,wrongSummary["total"].asInt());assertEquals(6,wrongSummary["wrongCount"].asInt());assertEquals(0,wrongSummary["repeatCount"].asInt())
        val overview=call("GET","/me/learning-overview",token=s.token)
        assertEquals(7,overview["answeredCount"].asInt());assertEquals(6,overview["wrongCount"].asInt());assertEquals(7,overview["favoriteCount"].asInt())
        assertEquals(1,overview["practiceCount"].asInt());assertTrue(overview["recentSession"].isNull)
        val progressBanks=call("GET","/question-banks?subjectId=${f.subject}&includeProgress=true",token=s.token)
        assertEquals(7,progressBanks["items"][0]["activeQuestionCount"].asInt());assertEquals(7,progressBanks["items"][0]["progress"]["answeredCount"].asInt())
        call("GET","/subjects?includeProgress=true",token=s.token)
        val subject=call("GET","/subjects/${f.subject}?includeProgress=true",token=s.token)
        assertEquals(7,subject["questionCount"].asInt());assertEquals(1,subject["bankCount"].asInt());assertEquals(7,subject["progress"]["answeredCount"].asInt())
        val after=call("GET","/me/question-collections/summary?kind=FAVORITE",token=s.token)
        assertEquals(7,after["practicedCount"].asInt());assertEquals(0,after["pendingCount"].asInt())
        val repeat=call("GET","/me/wrong-questions?chip=repeat&pageSize=5",token=s.token);assertEquals(0,repeat["total"].asInt())
        call("PUT","/admin/questions/${extra.first()}",question(f.bank,"SINGLE_CHOICE")+mapOf("status" to "INACTIVE","expectedVersion" to 1))
        val reduced=call("GET","/question-banks?subjectId=${f.subject}&includeProgress=true",token=s.token)["items"][0]
        assertEquals(6,reduced["activeQuestionCount"].asInt());assertEquals(6,reduced["progress"]["answeredCount"].asInt())
        assertEquals(7,call("GET","/me/learning-overview",token=s.token)["answeredCount"].asInt())
        assertEquals(7,call("GET","/me/question-collections/summary?kind=FAVORITE",token=s.token)["total"].asInt())
    }

}
