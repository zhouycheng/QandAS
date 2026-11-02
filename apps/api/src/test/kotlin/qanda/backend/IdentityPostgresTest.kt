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

    @Test fun `verification attempt limits survive failed registration transactions`() {
        val address="${UUID.randomUUID()}@example.test"
        val challenge=call("POST","/auth/email-challenges",mapOf("purpose" to "REGISTER","email" to address),null,201)
        val actual=code(id(challenge));val wrong=if(actual=="000000") "111111" else "000000"
        val payload=mapOf("challengeId" to id(challenge),"code" to wrong,"password" to studentPassword)
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
        val newPassword="NewLearner456"
        call("POST","/auth/password-resets",mapOf("challengeId" to id(challenge),"code" to code(id(challenge)),"newPassword" to newPassword),null)
        call("GET","/me",token=s.token,status=401)
        assertEquals("邮箱或密码不正确，请检查后重试",call("POST","/auth/sessions",mapOf("email" to s.email,"password" to studentPassword,"deviceId" to UUID.randomUUID()),null,401)["message"].asText())
        val login=call("POST","/auth/sessions",mapOf("email" to s.email,"password" to newPassword,"deviceId" to UUID.randomUUID()),null)
        val token=login["accessToken"].asText();val me=call("GET","/me",token=token)
        call("PUT","/admin/users/${s.id}/status",mapOf("expectedVersion" to me["version"].asLong(),"status" to "DISABLED"))
        call("GET","/me",token=token,status=401)
    }

    @Test fun `student password policy covers registration login reset and change`() {
        val address="${UUID.randomUUID()}@example.test"
        val registrationProof=call("POST","/auth/email-challenges",mapOf("purpose" to "REGISTER","email" to address),null,201)
        val registration=mapOf("challengeId" to id(registrationProof),"code" to code(id(registrationProof)))
        val invalidPasswords=listOf("abc1234","abc12345678901234","abcdefgh","12345678")
        for (bad in invalidPasswords) call("POST","/auth/email-registrations",registration+mapOf("password" to bad),null,422)
        call("POST","/auth/email-registrations",registration+mapOf("password" to "abc12345"),null,201)
        fun login(value: String)=call("POST","/auth/sessions",mapOf("email" to address,"password" to value,"deviceId" to UUID.randomUUID()),null)["accessToken"].asText()
        login("abc12345")
        for (bad in invalidPasswords) call("POST","/auth/sessions",mapOf("email" to address,"password" to bad,"deviceId" to UUID.randomUUID()),null,422)

        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",address)
        val resetProof=call("POST","/auth/email-challenges",mapOf("purpose" to "RESET_PASSWORD","email" to address),null,201)
        val reset=mapOf("challengeId" to id(resetProof),"code" to code(id(resetProof)))
        for (bad in invalidPasswords) assertEquals("/newPassword",call("POST","/auth/password-resets",reset+mapOf("newPassword" to bad),null,422)["fieldErrors"][0]["field"].asText())
        call("POST","/auth/password-resets",reset+mapOf("newPassword" to "Abc1234567890123"),null)
        val token=login("Abc1234567890123")

        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",address)
        val changeProof=call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_PASSWORD"),token)
        val change=mapOf("expectedVersion" to call("GET","/me",token=token)["version"].asLong(),"challengeId" to id(changeProof),"code" to code(id(changeProof)))
        for (bad in invalidPasswords) assertEquals("/newPassword",call("PUT","/me/password",change+mapOf("newPassword" to bad),token,422)["fieldErrors"][0]["field"].asText())
        call("PUT","/me/password",change+mapOf("newPassword" to "Passw0rd"),token)
        login("Passw0rd")
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

    @Test fun `local WeChat registration creates optional profile without a student email`() {
        val first=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-1:${UUID.randomUUID()}","deviceId" to UUID.randomUUID()),null)
        assertTrue(first["session"].isNull)
        val registration=call("POST","/auth/wechat-registrations",mapOf("registrationToken" to first["registrationToken"].asText(),"nickname" to "微信学生"),null,201)
        val login=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-1:${UUID.randomUUID()}","deviceId" to UUID.randomUUID()),null)
        val user=call("GET","/me",token=login["session"]["accessToken"].asText())
        assertEquals(registration["id"],user["id"]);assertTrue(user["email"].isNull);assertTrue(user["majorId"].isNull);assertTrue(user["wechatBound"].asBoolean())
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
        call("GET","/admin/colleges");call("GET","/admin/majors?collegeId=$college");call("GET","/admin/subjects");call("GET","/subjects",token=s.token);call("GET","/subjects/${f.subject}",token=s.token)
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
        assertEquals(1,call("GET","/admin/question-banks/${f.bank}/questions?chapterId=$first")["total"].asInt())
        assertTrue(call("GET","/questions/${f.questions.first()}",token=s.token)["correctAnswer"].isNull)
        assertEquals("原题SINGLE_CHOICE",call("GET","/admin/questions/${f.questions.first()}")["stem"].asText())
        assertEquals(4,call("GET","/admin/question-banks/${f.bank}/questions")["total"].asInt())
        call("DELETE","/admin/questions/${f.questions.last()}?expectedVersion=1")
        assertEquals(3,call("POST","/practice/scope-preview",mapOf("questionBankId" to f.bank,"count" to 4),s.token)["availableCount"].asInt())
        assertEquals("1.0.0",call("GET","/health",token=null)["version"].asText())
        val me=call("GET","/me",token=s.token)
        call("PUT","/me/wechat-binding",mapOf("expectedVersion" to me["version"].asLong(),"code" to "local-learner-3:${UUID.randomUUID()}"),s.token)
        assertTrue(call("GET","/me",token=s.token)["wechatBound"].asBoolean())
        val boundVersion=call("GET","/me",token=s.token)["version"].asLong()
        assertEquals(boundVersion,call("PUT","/me/wechat-binding",mapOf("expectedVersion" to boundVersion,"code" to "local-learner-3:${UUID.randomUUID()}"),s.token)["version"].asLong())
        val avatarOutput=java.io.ByteArrayOutputStream()
        javax.imageio.ImageIO.write(java.awt.image.BufferedImage(160,160,java.awt.image.BufferedImage.TYPE_INT_RGB),"png",avatarOutput)
        val avatar="data:image/png;base64,"+java.util.Base64.getEncoder().encodeToString(avatarOutput.toByteArray())
        val profileInput=mapOf("expectedVersion" to boundVersion,"nickname" to "原生选择的微信名","collegeId" to college,"majorId" to major,"currentGrade" to 1,"avatar" to avatar)
        val profileKey=UUID.randomUUID()
        val profileSaved=call("PUT","/me/profile",profileInput,s.token,key=profileKey)
        assertEquals(profileSaved,call("PUT","/me/profile",profileInput,s.token,key=profileKey))
        val withAvatar=call("GET","/me",token=s.token)
        assertEquals(avatar,withAvatar["avatarUrl"].asText())
        assertEquals("原生选择的微信名",withAvatar["nickname"].asText())
        assertEquals(profileSaved["version"].asLong(),call("PUT","/me/wechat-binding",mapOf("expectedVersion" to profileSaved["version"].asLong(),"code" to "local-learner-3:${UUID.randomUUID()}"),s.token)["version"].asLong())
        val preserved=call("PUT","/me/profile",mapOf("expectedVersion" to profileSaved["version"].asLong(),"nickname" to "更新昵称","collegeId" to college,"majorId" to major),s.token)
        assertEquals(avatar,call("GET","/me",token=s.token)["avatarUrl"].asText(),"ordinary profile edits preserve the selected avatar")
        call("PUT","/me/profile",profileInput+mapOf("expectedVersion" to preserved["version"].asLong(),"avatar" to "https://example.test/avatar.jpg"),s.token,422)
        assertTrue(call("GET","/admin/administrators")["items"].any { it["id"].asText()==platformId.toString() })
        call("GET","/admin/users/${s.id}");call("GET","/admin/users")
        val other=student()
        assertEquals("WECHAT_ALREADY_BOUND",call("PUT","/me/wechat-binding",mapOf("expectedVersion" to 1,"code" to "local-learner-3:${UUID.randomUUID()}"),other.token,409)["code"].asText())
        assertFalse(call("GET","/me",token=other.token)["wechatBound"].asBoolean())
        call("DELETE","/auth/sessions/current",token=other.token)
        call("GET","/me",token=other.token,status=401)
    }

    @Test fun `email binding password change and two proofs for email replacement preserve one user identity`() {
        val ticket=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-2:${UUID.randomUUID()}","deviceId" to UUID.randomUUID()),null)
        val registration=call("POST","/auth/wechat-registrations",mapOf("registrationToken" to ticket["registrationToken"].asText()),null,201)
        fun wechatToken(): String=call("POST","/auth/wechat-sessions",mapOf("code" to "local-learner-2:${UUID.randomUUID()}","deviceId" to UUID.randomUUID()),null)["session"]["accessToken"].asText()
        val token=wechatToken();val address="${UUID.randomUUID()}@example.test"
        assertFalse(call("GET","/me",token=token)["passwordSet"].asBoolean())
        val binding=call("POST","/me/email-challenges",mapOf("purpose" to "BIND_EMAIL","email" to address),token)
        call("PUT","/me/email-binding",mapOf("expectedVersion" to 1,"newChallengeId" to id(binding),"newCode" to code(id(binding))),token)
        call("GET","/me",token=token,status=401)
        val boundToken=wechatToken()
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",address)
        val passwordProof=call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_PASSWORD"),boundToken)
        val verifyPath="/me/email-challenges/${id(passwordProof)}/verification"
        val verifyInput=mapOf("purpose" to "CHANGE_PASSWORD","code" to code(id(passwordProof)))
        val stranger=student()
        call("POST",verifyPath,verifyInput,stranger.token,409)
        call("POST",verifyPath,verifyInput + ("purpose" to "CHANGE_EMAIL_OLD"),boundToken,409)
        val wrongCode=if(verifyInput["code"]=="000000") "999999" else "000000"
        call("POST",verifyPath,verifyInput + ("code" to wrongCode),boundToken,409)
        assertEquals(1,jdbc.queryForObject("SELECT failed_attempts FROM email_challenge WHERE id=?",Int::class.java,id(passwordProof)))
        assertEquals(passwordProof["expiresAt"],call("POST",verifyPath,verifyInput,boundToken)["expiresAt"])
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM email_challenge WHERE id=? AND consumed_at IS NOT NULL",Int::class.java,id(passwordProof)))
        call("PUT","/me/password",mapOf("expectedVersion" to 2,"challengeId" to id(passwordProof),"code" to code(id(passwordProof)),"newPassword" to studentPassword),boundToken)
        call("GET","/me",token=boundToken,status=401)
        val login=call("POST","/auth/sessions",mapOf("email" to address,"password" to studentPassword,"deviceId" to UUID.randomUUID()),null)
        val currentToken=login["accessToken"].asText()
        assertTrue(call("GET","/me",token=currentToken)["passwordSet"].asBoolean())
        call("POST",verifyPath,verifyInput,currentToken,409)
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",address)
        val oldProof=call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_EMAIL_OLD"),currentToken)
        call("POST","/me/email-challenges/${id(oldProof)}/verification",mapOf("purpose" to "CHANGE_EMAIL_OLD","code" to code(id(oldProof))),currentToken)
        val replacement="${UUID.randomUUID()}@example.test"
        val newProof=call("POST","/me/email-challenges",mapOf("purpose" to "CHANGE_EMAIL_NEW","email" to replacement),currentToken)
        call("PUT","/me/email-binding",mapOf("expectedVersion" to 3,"oldChallengeId" to id(oldProof),"oldCode" to code(id(oldProof)),"newChallengeId" to id(newProof),"newCode" to code(id(newProof))),currentToken)
        val finalLogin=call("POST","/auth/sessions",mapOf("email" to replacement,"password" to studentPassword,"deviceId" to UUID.randomUUID()),null)
        assertEquals(registration["id"],call("GET","/me",token=finalLogin["accessToken"].asText())["id"])
        assertEquals("邮箱或密码不正确，请检查后重试",call("POST","/auth/sessions",mapOf("email" to address,"password" to studentPassword,"deviceId" to UUID.randomUUID()),null,401)["message"].asText())
    }

}
