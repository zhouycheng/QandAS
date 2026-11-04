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

class IdentityPostgresTest : PostgresFixture() {
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
        call("PUT","/admin/administrators/$admin",mapOf("username" to username,"name" to "更新后的管理员","status" to "DISABLED","expectedVersion" to 2))
        call("GET","/admin/auth/me",token=secondToken,status=401)
        org.springframework.transaction.support.TransactionTemplate(transactionManager).executeWithoutResult { transaction ->
            jdbc.update("UPDATE admin_account SET status='INACTIVE' WHERE id<>? AND status='ACTIVE'",platformId)
            val version=jdbc.queryForObject("SELECT version FROM admin_account WHERE id=?",Long::class.java,platformId)!!
            val error=assertThrows(qanda.backend.platform.http.ApiException::class.java) { adminService.save(platformId,AdminInput("test_admin","测试管理员","SUPER_ADMIN","DISABLED",expectedVersion=version)) }
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

    @Test fun `verification attempt limits survive failed first login transactions`() {
        val address=UUID.randomUUID().toString()+"@example.test"
        val challenge=call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to address),null,201)
        val actual=code(id(challenge));val wrong=if(actual=="000000") "111111" else "000000"
        val payload=mapOf("challengeId" to id(challenge),"code" to wrong,"deviceId" to UUID.randomUUID())
        repeat(5) { call("POST","/auth/email-code-sessions",payload,null,409) }
        assertEquals(5,jdbc.queryForObject("SELECT failed_attempts FROM email_challenge WHERE id=?",Int::class.java,id(challenge)))
        call("POST","/auth/email-code-sessions",payload+mapOf("code" to actual),null,409)
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM user_account WHERE email_key=?",Int::class.java,address))
        call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to address),null,429)
        outbox.dispatchOne()
        assertEquals("CANCELLED",jdbc.queryForObject("SELECT state FROM mail_delivery WHERE challenge_id=?",String::class.java,id(challenge)))
    }

    @Test fun `local mail uses encrypted outbox and a real SMTP capture transport`() {
        val address="${UUID.randomUUID()}@example.test"
        val challenge=call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to address),null,201)
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

    @Test fun `ordinary accounts reject fixed credentials and disabled accounts cannot authenticate`() {
        val user=student()
        call("POST","/auth/sessions",mapOf("email" to user.email,"password" to "Invalid123456789","deviceId" to UUID.randomUUID()),null,401)
        for(path in listOf("/auth/email-registrations","/auth/password-resets","/me/password","/me/profile-setup/acknowledgement")) {
            call("POST",path,emptyMap<String,String>(),user.token,404)
        }
        val view=call("GET","/me",token=user.token)
        call("PUT","/admin/users/"+user.id+"/status",mapOf("expectedVersion" to view["version"].asLong(),"status" to "DISABLED"))
        call("GET","/me",token=user.token,status=401)
    }

    @Test fun `two first-login proofs create one identity and independent sessions`() {
        val address=UUID.randomUUID().toString()+"@example.test"
        val first=call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to address),null,201)
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE id=?",id(first))
        val second=call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to address.uppercase()),null,201)
        val inputs=listOf(first,second).map { mapOf("challengeId" to id(it),"code" to code(id(it)),"deviceId" to UUID.randomUUID()) }
        val executor=Executors.newFixedThreadPool(2)
        try {
            val responses=inputs.map { input -> executor.submit<HttpResponse<String>> { raw("POST","/auth/email-code-sessions",input,null) } }.map { it.get() }
            responses.forEach { assertEquals(200,it.statusCode(),it.body()) }
            assertEquals(2,responses.map { json.readTree(it.body())["accessToken"].asText() }.distinct().size)
        } finally { executor.shutdownNow() }
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM user_account WHERE email_key=?",Int::class.java,address))
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

    @Test fun `wechat first login directly returns the same bound learning identity`() {
        val code="local-learner-1:"+UUID.randomUUID()
        val first=call("POST","/auth/wechat-sessions",mapOf("code" to code,"deviceId" to UUID.randomUUID()),null)
        assertFalse(first.has("registrationToken"));val token=first["accessToken"].asText()
        val user=call("GET","/me",token=token)
        assertTrue(user["wechatBound"].asBoolean());assertFalse(user.has("profileComplete"));assertFalse(user.has("collegeId"))
        assertTrue(user["avatarUrl"].asText() in DefaultAvatars.values)
        val second=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-1:"+UUID.randomUUID(),"deviceId" to UUID.randomUUID()),null)
        val again=call("GET","/me",token=second["accessToken"].asText())
        assertEquals(user["id"],again["id"]);assertEquals(user["avatarUrl"],again["avatarUrl"])
        call("POST","/auth/wechat-sessions",mapOf("code" to code,"deviceId" to UUID.randomUUID()),null,401)
    }

    @Test fun `email registration assigns an avatar once and existing avatars survive login`() {
        val s=student();val first=call("GET","/me",token=s.token)
        assertTrue(first["avatarUrl"].asText() in DefaultAvatars.values)
        fun loginAgain(): JsonNode {
            jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",s.email)
            val proof=call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to s.email),null,201)
            val session=call("POST","/auth/email-code-sessions",mapOf("challengeId" to id(proof),"code" to code(id(proof)),"deviceId" to UUID.randomUUID()),null)
            return call("GET","/me",token=session["accessToken"].asText())
        }
        assertEquals(first["avatarUrl"],loginAgain()["avatarUrl"])
        val bytes=ByteArrayOutputStream().also { ImageIO.write(BufferedImage(16,16,BufferedImage.TYPE_INT_RGB),"png",it) }.toByteArray()
        val custom="data:image/png;base64,"+Base64.getEncoder().encodeToString(bytes)
        for(avatar in listOf(null,custom)) {
            jdbc.update("UPDATE user_account SET avatar=? WHERE id=?",avatar,s.id)
            val again=loginAgain()
            assertEquals(s.id.toString(),again["id"].asText())
            assertEquals(avatar,again["avatarUrl"]?.takeUnless { it.isNull }?.asText())
        }
    }

    @Test fun `category directory and chapter ordering remain independent of user profiles`() {
        val college=id(call("POST","/admin/colleges",mapOf("name" to "分类学院"+UUID.randomUUID(),"code" to "C"+UUID.randomUUID())))
        val major=id(call("POST","/admin/majors",mapOf("collegeId" to college,"name" to "分类专业","code" to "M")))
        assertFalse(call("GET","/admin/colleges/"+college).has("studentCount"))
        assertEquals(college.toString(),call("GET","/admin/majors/"+major)["collegeId"].asText())
        val f=fixture(listOf(mapOf("majorId" to major,"grade" to 2)))
        val a=id(call("POST","/admin/question-banks/"+f.bank+"/chapters",mapOf("name" to "第二章","sortOrder" to 1)))
        val b=id(call("POST","/admin/question-banks/"+f.bank+"/chapters",mapOf("name" to "第一章","sortOrder" to 0)))
        val bank=call("GET","/admin/question-banks/"+f.bank)
        call("PUT","/admin/question-banks/"+f.bank+"/chapter-order",mapOf("expectedContentVersion" to bank["contentVersion"].asLong(),"ids" to listOf(a,b)))
        assertEquals(listOf(a.toString(),b.toString()),call("GET","/question-banks/"+f.bank+"/chapters",token=null).map { it["id"].asText() })
        val owner=student();val other=student();val practice=createPractice(owner,f)
        call("GET","/practice/sessions/"+id(practice),token=other.token,status=404)
        assertFalse(call("GET","/admin/users/"+owner.id).has("currentGrade"))
    }

    @Test fun `email binding and replacement preserve learning identity and revoke old sessions`() {
        val session=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-2:"+UUID.randomUUID(),"deviceId" to UUID.randomUUID()),null)
        val token=session["accessToken"].asText();val user=call("GET","/me",token=token)
        val address=UUID.randomUUID().toString()+"@example.test"
        val proof=call("POST","/me/email-challenges",mapOf("purpose" to "BIND_EMAIL","email" to address),token)
        call("PUT","/me/email-binding",mapOf("expectedVersion" to user["version"].asLong(),"newChallengeId" to id(proof),"newCode" to code(id(proof))),token)
        call("GET","/me",token=token,status=401)
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",address)
        val loginProof=call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to address),null,201)
        val emailSession=call("POST","/auth/email-code-sessions",mapOf("challengeId" to id(loginProof),"code" to code(id(loginProof)),"deviceId" to UUID.randomUUID()),null)
        val emailToken=emailSession["accessToken"].asText();val bound=call("GET","/me",token=emailToken)
        assertEquals(user["id"],bound["id"]);assertTrue(bound["wechatBound"].asBoolean())
        val occupied=student()
        call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_EMAIL_NEW","email" to occupied.email),emailToken,409)
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",address)
        val oldProof=call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_EMAIL_OLD"),emailToken)
        val next=UUID.randomUUID().toString()+"@example.test"
        val newProof=call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_EMAIL_NEW","email" to next),emailToken)
        call("PUT","/me/email-binding",mapOf("expectedVersion" to bound["version"].asLong(),"oldChallengeId" to id(oldProof),"oldCode" to code(id(oldProof)),
            "newChallengeId" to id(newProof),"newCode" to code(id(newProof))),emailToken)
        call("GET","/me",token=emailToken,status=401)
        assertEquals(next,jdbc.queryForObject("SELECT email_key FROM user_account WHERE id=?",String::class.java,id(user)))
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM user_account WHERE email_key=?",Int::class.java,address))
    }

}
