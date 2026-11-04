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

    @Test fun `interrupted avatar checks retain their stored media for recovery`() {
        val actor=sessionService.authenticate(student().token)
        val context=contentSafety.context(actor,"local-learner-1:${UUID.randomUUID()}")
        val requestId=UUID.randomUUID();val mediaId=UUID.randomUUID();val workerToken=UUID.randomUUID()
        val bytes=ByteArrayOutputStream().also { ImageIO.write(BufferedImage(16,16,BufferedImage.TYPE_INT_RGB),"png",it) }.toByteArray()
        val hash=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes))
        org.springframework.transaction.support.TransactionTemplate(transactionManager).executeWithoutResult {
            jdbc.update("INSERT INTO content_safety_request(id,actor_id,session_id,actor_kind,operation,payload_json,payload_digest,context_id,state,expires_at,worker_token,worker_heartbeat_at) VALUES(?,?,?,'USER','UPDATE_PROFILE','{}',?,?, 'RUNNING',now()+interval '30 minutes',?,now()-interval '2 minutes')",
                requestId,actor.id,actor.sessionId,byteArrayOf(1),context.id,workerToken)
            jdbc.update("INSERT INTO content_safety_media(id,request_id,data,media_type,sha256,fetch_digest,fetch_expires_at,state) VALUES(?,?,?,'image/png',?,?,now()+interval '10 minutes','PENDING')",
                mediaId,requestId,bytes,hash,byteArrayOf(2))
        }

        contentSafety.tick()

        eventually {
            jdbc.queryForObject("SELECT count(*) FROM content_safety_media WHERE id=? AND trace_id IS NOT NULL",Int::class.java,mediaId)==1 &&
                jdbc.queryForObject("SELECT state FROM content_safety_request WHERE id=?",String::class.java,requestId)=="PENDING"
        }
        val trace=jdbc.queryForObject("SELECT trace_id FROM content_safety_media WHERE id=?",String::class.java,mediaId)
        contentSafety.callback(trace,"pass")
        eventually { jdbc.queryForObject("SELECT state FROM content_safety_request WHERE id=?",String::class.java,requestId)=="PASSED" }
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

    @Test fun `administrators edit and publish with permissions and versions`() {
        val f=fixture()
        val input=question(f.bank,"SINGLE_CHOICE")+mapOf("expectedVersion" to 1,"stem" to "新修订")
        assertEquals(401,raw("PUT","/admin/questions/${f.questions.first()}",input,null).statusCode())
        assertEquals(403,raw("PUT","/admin/questions/${f.questions.first()}",input,student().token).statusCode())
        val updated=raw("PUT","/admin/questions/${f.questions.first()}",input)
        assertEquals(200,updated.statusCode(),updated.body())
        val bank=call("GET","/admin/question-banks/${f.bank}")
        val publication=mapOf("expectedVersion" to bank["version"].asLong(),"status" to "PUBLISHED")
        assertEquals(200,raw("PUT","/admin/question-banks/${f.bank}/publication",publication).statusCode())
        assertEquals(409,raw("PUT","/admin/questions/${f.questions.first()}",input).statusCode())
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM content_safety_request WHERE actor_id=?",Int::class.java,platformId))
        assertEquals(404,raw("POST","/admin/content-safety/requests",emptyMap<String,String>()).statusCode())
        for(path in listOf("/content-safety/confirmations","/content-safety/confirmations/inspection")) {
            assertEquals(401,raw("POST",path,emptyMap<String,String>(),null).statusCode(),path)
            assertEquals(403,raw("POST",path,emptyMap<String,String>()).statusCode(),path)
        }
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
