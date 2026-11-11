package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import java.util.UUID
import java.util.concurrent.Executors

class RefactorPostgresTest : PostgresFixture() {
    @Test fun `default twenty questions admit the complete first reading group`() {
        val subject=id(call("POST","/admin/subjects",mapOf("name" to "完整题组${UUID.randomUUID()}")))
        val bank=id(call("POST","/admin/question-banks",mapOf("subjectId" to subject,"name" to "长题组","description" to "完整阅读题组选题验证")))
        call("POST","/admin/questions",mapOf("questionBankId" to bank,"type" to "READING","stem" to "阅读材料","passage" to "根据材料判断。","explanation" to "材料解析",
            "subQuestions" to (1..25).map { mapOf("type" to "TRUE_FALSE","stem" to "第${it}小题","correctValue" to true,"explanation" to "小题解析") }))
        val version=call("GET","/admin/question-banks/$bank")["version"].asLong()
        call("PUT","/admin/question-banks/$bank/publication",mapOf("expectedVersion" to version,"status" to "PUBLISHED"))
        val preview=call("POST","/practice/scope-preview",mapOf("questionBankId" to bank,"count" to 20,"order" to "SEQUENTIAL","completeFirstGroup" to true),null)
        assertEquals(25,preview["selectedCount"].asInt())
        assertEquals(25,preview["selectedQuestionIds"].size())
    }

    @Test fun `concurrent distinct erasure proofs serialize on the account before locking proofs`() {
        val test=call("POST","/admin/test-accounts",mapOf("validDays" to 1,"includeInStatistics" to false),status=201)
        val credential=call("GET","/admin/test-accounts/${id(test)}/credentials")
        val token=call("POST","/auth/sessions",mapOf("email" to credential["email"].asText(),"password" to credential["password"].asText(),"deviceId" to UUID.randomUUID()),null)["accessToken"].asText()
        val proofs=(1..2).map { call("POST","/me/deletion-confirmations",mapOf("loginCode" to credential["password"].asText()),token)["proof"].asText() }
        val pool=Executors.newFixedThreadPool(2)
        try {
            val results=proofs.map { proof -> pool.submit<Int> { raw("DELETE","/me",mapOf("proof" to proof,"confirmed" to true),null).statusCode() } }.map { it.get() }
            assertEquals(1,results.count { it==200 });assertTrue(results.all { it in setOf(200,401,409,422) },results.toString())
            assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM user_account WHERE id=?",Int::class.java,id(test)))
        } finally { pool.shutdownNow() }
    }
    @Test fun `repeat answers accumulate attempts while erasure removes private history and supports lost response retry`() {
        val s=student();val f=fixture()
        repeat(2) {
            val session=createPractice(s,f)
            finish("/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to 1,"durationSeconds" to 0,
                "writerToken" to session["writer"]["writerToken"].asText(),"items" to answers(session)),s.token)
        }
        val bank=call("GET","/admin/question-banks/"+f.bank)
        call("PUT","/admin/question-banks/"+f.bank+"/publication",mapOf("expectedVersion" to bank["version"].asLong(),"status" to "UNPUBLISHED"))
        val overview=call("GET","/me/learning-overview",token=s.token)
        assertEquals(8,overview["answerAttemptCount"].asInt());assertEquals(4,overview["distinctQuestionCount"].asInt())
        assertEquals(6,overview["objectiveAnsweredCount"].asInt());assertEquals(1.0,overview["objectiveAccuracy"].asDouble())
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE user_id=? OR email_key=?",s.id,s.email)
        val challenge=call("POST","/me/email-challenges",mapOf("purpose" to "DELETE_ACCOUNT"),s.token)
        val proof=call("POST","/me/deletion-confirmations",mapOf("challengeId" to id(challenge),"code" to code(id(challenge))),s.token)["proof"].asText()
        val key=UUID.randomUUID();val deletion=mapOf("proof" to proof,"confirmed" to true)
        assertTrue(call("DELETE","/me",deletion,null,key=key)["completed"].asBoolean())
        assertTrue(call("DELETE","/me",deletion,null,key=key)["completed"].asBoolean())
        assertEquals(409,raw("DELETE","/me",deletion,null).statusCode())
        assertEquals(401,raw("GET","/me",token=s.token).statusCode())
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM user_account WHERE id=?",Int::class.java,s.id))
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM practice_session WHERE user_id=?",Int::class.java,s.id))
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM audit_log WHERE actor_user_id=?",Int::class.java,s.id))
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM email_challenge WHERE email_key=?",Int::class.java,s.email))
    }
    @Test fun `email first logins serialize account creation and consumed challenges cannot replay`() {
        val email="${UUID.randomUUID()}@example.test"
        val challenge=call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to email),null,201)
        val body=mapOf("challengeId" to id(challenge),"code" to code(id(challenge)),"deviceId" to UUID.randomUUID())
        val executor=Executors.newFixedThreadPool(2)
        try {
            val responses=(1..2).map { executor.submit<Int> { raw("POST","/auth/email-code-sessions",body,null).statusCode() } }.map { it.get() }.sorted()
            assertEquals(listOf(200,409),responses)
        } finally { executor.shutdownNow() }
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM user_account WHERE email_key=?",Int::class.java,email))
        assertEquals(409,raw("POST","/auth/email-code-sessions",body,null).statusCode())
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM information_schema.columns WHERE table_name='user_account' AND column_name IN ('password_hash','profile_setup_seen')",Int::class.java))
    }
    @Test fun `wechat directly creates a session and ordinary accounts cannot use fixed code login`() {
        val token=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-3:${UUID.randomUUID()}","deviceId" to UUID.randomUUID()),null)["accessToken"].asText()
        assertTrue(call("GET","/me",token=token)["wechatBound"].asBoolean())
        val s=student()
        assertEquals(401,raw("POST","/auth/sessions",mapOf("email" to s.email,"password" to "Unknown123456789","deviceId" to UUID.randomUUID()),null).statusCode())
        assertFalse(call("GET","/me",token=s.token).has("collegeId"))
    }
    @Test fun `categories filter discovery but never authorize public content`() {
        val college=id(call("POST","/admin/colleges",mapOf("name" to "学院${UUID.randomUUID()}","code" to "C${UUID.randomUUID()}")))
        val major=id(call("POST","/admin/majors",mapOf("name" to "专业${UUID.randomUUID()}","code" to "M${UUID.randomUUID()}","collegeId" to college)))
        val f=fixture(listOf(mapOf("majorId" to major,"grade" to 2)))
        val needle="检索"+UUID.randomUUID()
        val optionNeedle="选项检索"+UUID.randomUUID()
        call("PUT","/admin/questions/"+f.questions.first(),question(f.bank,"SINGLE_CHOICE")+mapOf("stem" to needle,"options" to listOf(mapOf("key" to "A","content" to optionNeedle),mapOf("key" to "B","content" to "其他选项")),"expectedVersion" to 1))
        val a=student();val b=student()
        for(token in listOf(null,a.token,b.token)) {
            assertEquals(f.bank.toString(),call("GET","/question-banks/${f.bank}",token=token)["id"].asText())
            val included=call("GET","/question-banks?subjectId=${f.subject}&collegeId=$college&majorId=$major&grade=2",token=token)
            assertEquals(1,included["total"].asInt())
            assertEquals(0,call("GET","/question-banks?subjectId=${f.subject}&grade=3",token=token)["total"].asInt())
            val search=call("GET","/search?keyword=$needle&majorId=$major&grade=2&kind=QUESTION",token=token)
            assertTrue(search["items"].any { it["questionBankId"].asText()==f.bank.toString() })
            val optionSearch=call("GET","/search?keyword=$optionNeedle&majorId=$major&grade=2&kind=QUESTION",token=token)
            assertTrue(optionSearch["items"].any { it["questionBankId"].asText()==f.bank.toString() })
            assertTrue(search["items"].all { !it.has("correctAnswer") && !it.has("explanation") })
        }
    }
}
