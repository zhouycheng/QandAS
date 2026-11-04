package qanda.backend

import com.fasterxml.jackson.databind.JsonNode
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import java.util.UUID
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.Base64
import javax.imageio.ImageIO

class ContentSafetyPostgresTest: PostgresFixture() {
    private fun prepare(s: Student,input: Any): JsonNode {
        val context=call("POST","/me/content-safety/contexts",mapOf("code" to "local-learner-1:${UUID.randomUUID()}"),s.token)
        return call("POST","/me/content-safety/requests",mapOf("operation" to "UPDATE_PROFILE","payload" to input,"contextId" to id(context)),s.token)
    }
    private fun state(s: Student,ticket: JsonNode): JsonNode=call("GET","/me/content-safety/requests/${id(ticket)}",token=s.token)
    private fun write(s: Student,input: Any,ticket: JsonNode,key: UUID=UUID.randomUUID())=raw("PUT","/me/profile",input,s.token,key,extraHeaders=mapOf("X-Content-Safety-Request" to id(ticket).toString()))

    @Test fun `stale running checks are reclaimed after a worker interruption`() {
        val s=student();val ticket=prepare(s,mapOf("expectedVersion" to 1,"nickname" to "重启后恢复"))
        jdbc.update("UPDATE content_safety_request SET state='RUNNING',worker_token=?,worker_heartbeat_at=now()-interval '2 minutes' WHERE id=?",UUID.randomUUID(),id(ticket))
        contentSafety.tick()
        eventually { state(s,ticket)["state"].asText()=="PASSED" }
    }

    @Test fun `email users get session bound content contexts without acquiring login identities`() {
        val s=student();val input=mapOf("expectedVersion" to 1,"nickname" to "检测通过昵称")
        assertEquals(409,raw("PUT","/me/profile",input,s.token).statusCode())
        val ticket=prepare(s,input);approveContentTicket(ticket,s.token)
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM user_wechat WHERE user_id=?",Int::class.java,s.id))
        val other=student()
        assertEquals(404,raw("GET","/me/content-safety/requests/${id(ticket)}",token=other.token).statusCode())
        assertEquals(403,raw("GET","/admin/content-safety/requests/${id(ticket)}",token=s.token).statusCode())
        assertEquals(409,write(other,input,ticket).statusCode())
        assertEquals(409,write(s,input+mapOf("nickname" to "检测后替换"),ticket).statusCode())
        val key=UUID.randomUUID();val saved=write(s,input,ticket,key)
        assertEquals(200,saved.statusCode(),saved.body());assertEquals(saved.body(),write(s,input,ticket,key).body())
        assertEquals(409,write(s,input,ticket).statusCode())
        assertEquals("检测通过昵称",call("GET","/me",token=s.token)["nickname"].asText())
    }

    @Test fun `rejected reviewed unavailable expired and old version checks retain original profile`() {
        val s=student();val original=call("GET","/me",token=s.token)
        for(marker in listOf("[risk]","[review]","[unavailable]")) {
            val input=mapOf("expectedVersion" to 1,"nickname" to marker)
            val ticket=prepare(s,input)
            eventually { state(s,ticket)["state"].asText()=="REJECTED" }
            assertEquals(409,write(s,input,ticket).statusCode())
            assertEquals(original,call("GET","/me",token=s.token))
        }
        val candidate=mapOf("expectedVersion" to 1,"nickname" to "旧版本")
        val stale=prepare(s,candidate);approveContentTicket(stale,s.token)
        call("PUT","/me/profile",candidate+mapOf("nickname" to "新版本"),s.token)
        assertEquals(409,write(s,candidate,stale).statusCode())
        val expiring=prepare(s,mapOf("expectedVersion" to 2,"nickname" to "到期内容"));approveContentTicket(expiring,s.token)
        jdbc.update("UPDATE content_safety_request SET expires_at=now()-interval '1 second' WHERE id=?",id(expiring))
        assertEquals(409,write(s,mapOf("expectedVersion" to 2,"nickname" to "到期内容"),expiring).statusCode())
        assertEquals("新版本",call("GET","/me",token=s.token)["nickname"].asText())
    }

    @Test fun `publication checks bind the exact bank revision and administrator session`() {
        val f=fixture();val bank=call("GET","/admin/question-banks/${f.bank}")
        val input=mapOf("expectedVersion" to bank["version"].asLong(),"status" to "PUBLISHED")
        val ticket=call("POST","/admin/content-safety/requests",mapOf("operation" to "PUBLISH_BANK:${f.bank}","payload" to input))
        assertEquals("WAITING_CONFIRMATION",ticket["state"].asText())
        assertEquals(409,raw("POST","/content-safety/confirmations",mapOf("requestId" to id(ticket),"token" to "a".repeat(43),"code" to "local-learner-1:${UUID.randomUUID()}"),null).statusCode())
        approveContentTicket(ticket,adminToken)
        call("PUT","/admin/questions/${f.questions.first()}",question(f.bank,"SINGLE_CHOICE")+mapOf("expectedVersion" to 1,"stem" to "新修订"))
        val response=raw("PUT","/admin/question-banks/${f.bank}/publication",input,extraHeaders=mapOf("X-Content-Safety-Request" to id(ticket).toString()))
        assertEquals(409,response.statusCode());assertEquals("CONTENT_CHECK_STALE",json.readTree(response.body())["code"].asText())
    }

    @Test fun `private pending avatars reject replayed risk callbacks and erasure prevents late writes`() {
        val s=student();val original=call("GET","/me",token=s.token)
        val bytes=ByteArrayOutputStream().also { ImageIO.write(BufferedImage(16,16,BufferedImage.TYPE_INT_RGB),"png",it) }.toByteArray()
        val input=mapOf("expectedVersion" to 1,"nickname" to "媒体检查","avatar" to "data:image/png;base64,"+Base64.getEncoder().encodeToString(bytes))
        val ticket=prepare(s,input)
        eventually { state(s,ticket)["state"].asText()=="PENDING" }
        val media=jdbc.queryForMap("SELECT id,trace_id FROM content_safety_media WHERE request_id=?",id(ticket))
        assertEquals(404,raw("GET","/content-safety/media/${media["id"]}?token=invalid",token=null).statusCode())
        assertEquals(original,call("GET","/me",token=s.token))
        val trace=media["trace_id"] as String
        contentSafety.callback(trace,"risky");contentSafety.callback(trace,"pass");contentSafety.callback(trace,"pass")
        assertEquals("REJECTED",state(s,ticket)["state"].asText())
        assertEquals(409,write(s,input,ticket).statusCode())
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",s.email)
        val challenge=call("POST","/me/email-challenges",mapOf("purpose" to "DELETE_ACCOUNT"),s.token)
        val proof=call("POST","/me/deletion-confirmations",mapOf("challengeId" to id(challenge),"code" to code(id(challenge))),s.token)
        call("DELETE","/me",mapOf("proof" to proof["proof"].asText(),"confirmed" to true),null)
        contentSafety.callback(trace,"pass")
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM content_safety_request WHERE actor_id=?",Int::class.java,s.id))
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM content_safety_media WHERE request_id=?",Int::class.java,id(ticket)))
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM user_account WHERE id=?",Int::class.java,s.id))
    }
}
