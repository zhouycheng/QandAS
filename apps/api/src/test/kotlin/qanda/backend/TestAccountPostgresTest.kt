package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.springframework.beans.factory.annotation.Autowired
import qanda.backend.identity.TestAccountService
import qanda.backend.platform.http.ApiException
import java.time.Instant
import java.util.UUID

class TestAccountPostgresTest: PostgresFixture() {
    @Autowired lateinit var testAccounts: TestAccountService
    private fun create(included: Boolean=false,key: UUID=UUID.randomUUID())=call("POST","/admin/test-accounts",mapOf("validDays" to 7,"includeInStatistics" to included),status=201,key=key)
    private fun credentials(id: UUID)=call("GET","/admin/test-accounts/$id/credentials")
    private fun login(id: UUID): Student {
        val c=credentials(id)
        val token=call("POST","/auth/sessions",mapOf("email" to c["email"].asText(),"password" to c["password"].asText(),"deviceId" to UUID.randomUUID()),null)
        return Student(id,c["email"].asText(),token["accessToken"].asText())
    }

    @Test fun `generated credentials are reusable encrypted audited and protected`() {
        val key=UUID.randomUUID();val row=create(key=key);val id=id(row)
        assertEquals(row,create(key=key));assertFalse(row.has("password"))
        call("POST","/admin/test-accounts",mapOf("validDays" to 8),status=409,key=key)
        for(days in listOf(0,-1,366)) call("POST","/admin/test-accounts",mapOf("validDays" to days),status=422)
        call("POST","/admin/test-accounts",mapOf("validDays" to 1.5),status=400)
        val c=credentials(id);assertEquals(c,credentials(id));assertEquals(16,c["password"].asText().length)
        assertNotEquals(c["password"].asText(),jdbc.queryForObject("SELECT password_ciphertext FROM test_account WHERE user_id=?",String::class.java,id))
        assertFalse(jdbc.queryForObject("SELECT response_json::text FROM command_receipt WHERE command_id=?",String::class.java,key)!!.contains(c["password"].asText()))
        assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM audit_log WHERE operation=?",Int::class.java,"VIEW_TEST_ACCOUNT_CREDENTIALS:$id"))
        val s=login(id);val me=call("GET","/me",token=s.token);assertTrue(me["isTestAccount"].asBoolean())
        val sessionExpiry=jdbc.queryForObject("SELECT max(expires_at) FROM user_session WHERE user_id=?",java.sql.Timestamp::class.java,id)!!.toInstant()
        assertTrue(sessionExpiry<=Instant.parse(row["expiresAt"].asText()))
        call("GET","/admin/test-accounts",token=s.token,status=403)
        call("GET","/admin/test-accounts/$id/credentials",token=null,status=401)
        call("GET","/admin/test-accounts/$id/credentials",token=s.token,status=403)
        call("GET","/admin/test-accounts?status=INVALID",status=422)
        assertEquals(id.toString(),call("GET","/admin/test-accounts?keyword=${s.email}&status=ACTIVE")["items"].single()["id"].asText())
        call("POST","/auth/email-challenges",mapOf("purpose" to "RESET_PASSWORD","email" to s.email),null,409)
        call("POST","/auth/email-challenges",mapOf("purpose" to "REGISTER","email" to "new@qanda.invalid"),null,409)
        call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_PASSWORD"),s.token,409)
        call("PUT","/me/wechat-binding",mapOf("expectedVersion" to 1,"code" to "unused"),s.token,409)
        val profile=mapOf("expectedVersion" to 1,"nickname" to "测试学生","accountCode" to me["accountCode"].asText(),"email" to s.email,"collegeId" to null,"majorId" to null,"currentGrade" to null)
        call("PUT","/admin/users/$id",profile+mapOf("email" to "different@example.test"),status=409)
        call("PUT","/admin/users/$id",profile)
        val disableKey=UUID.randomUUID();val input=mapOf("expectedVersion" to 2)
        val disabled=call("PUT","/admin/test-accounts/$id/status",input,key=disableKey)
        assertEquals(disabled,call("PUT","/admin/test-accounts/$id/status",input,key=disableKey))
        call("GET","/me",token=s.token,status=401);call("GET","/admin/test-accounts/$id/credentials",status=409)
        call("PUT","/admin/users/$id/status",mapOf("status" to "ACTIVE","expectedVersion" to 3),status=409)
        assertNull(jdbc.queryForObject("SELECT password_ciphertext FROM test_account WHERE user_id=?",String::class.java,id))
        assertEquals("DISABLED",call("GET","/admin/test-accounts?keyword=${s.email}")["items"].single()["status"].asText())
    }

    @Test fun `expiry rejects sessions and queued progress before scheduled cleanup`() {
        val row=create();val id=id(row);val s=login(id);val session=createPractice(s,fixture());val sessionId=id(session);val key=UUID.randomUUID()
        consumers.stop()
        try {
            call("POST","/practice/sessions/$sessionId/progress-commands",progressBody(session),s.token,202,key)
            jdbc.update("UPDATE test_account SET expires_at=now()-interval '1 second' WHERE user_id=?",id)
            call("GET","/me",token=s.token,status=401)
            val c=call("GET","/admin/test-accounts?keyword=${s.email}&status=EXPIRED");assertEquals(1,c["total"].asInt())
            call("GET","/admin/test-accounts/$id/credentials",status=409)
            val envelope=qanda.backend.application.ProgressEnvelope(key,json.convertValue(progressBody(session),qanda.backend.practice.ProgressInput::class.java))
            assertEquals("UNAUTHENTICATED",assertThrows(ApiException::class.java) { progressCommands.consume(envelope) }.code)
        } finally { consumers.start() }
        eventually { jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,key)=="REJECTED" }
        assertEquals(1,jdbc.queryForObject("SELECT version FROM practice_session WHERE id=?",Int::class.java,sessionId))
        testAccounts.expireDue();testAccounts.expireDue()
        assertEquals("DISABLED",jdbc.queryForObject("SELECT status FROM user_account WHERE id=?",String::class.java,id))
        assertEquals(2,jdbc.queryForObject("SELECT credential_version FROM user_account WHERE id=?",Int::class.java,id))
        assertNull(jdbc.queryForObject("SELECT password_ciphertext FROM test_account WHERE user_id=?",String::class.java,id))
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM practice_session WHERE id=?",Int::class.java,sessionId))
    }

    @Test fun `statistics follow creation setting while personal learning is always retained`() {
        val baseline=call("GET","/admin/dashboard")["userCount"].asInt()
        val normal=student();val excluded=login(id(create()));val includedRow=create(true);val included=login(id(includedRow))
        val college=id(call("POST","/admin/colleges",mapOf("name" to "统计学院${UUID.randomUUID()}","code" to "TEST${UUID.randomUUID().toString().take(8)}")))
        val major=id(call("POST","/admin/majors",mapOf("collegeId" to college,"name" to "统计专业","code" to "STAT")))
        val answeredBaseline=call("GET","/admin/dashboard")["answeredCount"].asInt()
        val f=fixture()
        for(s in listOf(normal,excluded,included)) {
            jdbc.update("UPDATE user_profile SET major_id=?,grade=2,grade_academic_year=2026 WHERE user_id=?",major,s.id)
            val session=createPractice(s,f);val sessionId=id(session)
            progress("/practice/sessions/$sessionId/progress-commands",progressBody(session),s.token)
            jdbc.update("UPDATE practice_session SET created_at=now()-interval '1 minute' WHERE id=?",sessionId)
            call("POST","/practice/sessions/$sessionId/finish",mapOf("expectedVersion" to 2,"durationSeconds" to 30,"writerToken" to session["writer"]["writerToken"].asText()),s.token)
            call("POST","/me/activity/heartbeat",token=s.token)
            assertEquals(4,call("GET","/me/learning-overview",token=s.token)["answeredCount"].asInt())
        }
        assertEquals(baseline+2,call("GET","/admin/dashboard")["userCount"].asInt())
        assertEquals(answeredBaseline+8,call("GET","/admin/dashboard")["answeredCount"].asInt())
        assertEquals(2,call("GET","/admin/directory-summary?collegeId=$college")["studentCount"].asInt())
        assertEquals(2,call("GET","/admin/majors?collegeId=$college")["items"].single()["studentCount"].asInt())
        eventually { call("GET","/admin/statistics/activity?collegeId=$college")["dailyActive"].asInt()==2 }
        val scoped=call("GET","/admin/statistics/rankings?collegeId=$college")["items"]
        assertEquals(8,scoped.sumOf { it["answeredCount"].asInt() });assertEquals(60,scoped.sumOf { it["durationSeconds"].asInt() })
        val ranking=call("GET","/admin/statistics/rankings?period=ALL&pageSize=100")["items"].map { it["userId"].asText() }
        assertTrue(normal.id.toString() in ranking);assertTrue(included.id.toString() in ranking);assertFalse(excluded.id.toString() in ranking)
        val online=call("GET","/admin/statistics/online-users?pageSize=100")["items"].map { it["userId"].asText() }
        assertTrue(included.id.toString() in online);assertFalse(excluded.id.toString() in online)
        assertTrue(jdbc.queryForObject("SELECT account_in_statistics(?)",Boolean::class.java,normal.id)!!)
        assertFalse(jdbc.queryForObject("SELECT account_in_statistics(?)",Boolean::class.java,excluded.id)!!)
        call("PUT","/admin/test-accounts/${included.id}/status",mapOf("expectedVersion" to 1))
        assertEquals(baseline+2,call("GET","/admin/dashboard")["userCount"].asInt())
        assertEquals(4,call("GET","/admin/students/${excluded.id}/statistics?period=ALL")["answeredCount"].asInt())
        postgres.createConnection("").use { connection ->
            connection.createStatement().use { statement ->
                statement.execute("SET ROLE qanda_monitor")
                statement.executeQuery("SELECT count(*) FROM monitoring_student WHERE include_in_statistics").use { assertTrue(it.next()) }
                statement.executeQuery("SELECT expires_at,disabled_at FROM test_account LIMIT 1").use { assertTrue(it.next()) }
                assertThrows(java.sql.SQLException::class.java) { statement.executeQuery("SELECT password_ciphertext FROM test_account") }
            }
        }
    }
}
