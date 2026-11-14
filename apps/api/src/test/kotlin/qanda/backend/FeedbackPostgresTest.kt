package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.time.Instant
import java.util.UUID

class FeedbackPostgresTest : PostgresFixture() {
    @Test fun `feedback replies are acknowledged by observed version across sessions`() {
        val user=student();val f=fixture()
        val question=call("GET","/questions/${f.questions.first()}",token=user.token)
        for((resource,countField) in listOf("question-feedback" to "questionUnreadCount","course-requests" to "courseRequestUnreadCount")) {
            val input=if(resource=="question-feedback") mapOf("questionId" to question["id"].asText(),"revisionId" to question["revisionId"].asText(),"category" to "ANSWER","body" to "请检查答案")
                else mapOf("courseName" to "新课程","body" to "希望增加题库")
            val id=id(call("POST","/me/$resource",input,user.token))
            fun entry()=call("GET","/me/$resource",token=user.token)["items"].first { it["id"].asText()==id.toString() }
            fun summary()=call("GET","/me/feedback-summary",token=user.token)[countField].asInt()
            fun handle(version: Long,status: String,response: String)=call("PUT","/admin/$resource/$id",mapOf("expectedVersion" to version,"status" to status,"response" to response))
            fun read(version: Long,key: UUID=UUID.randomUUID())=call("PUT","/me/$resource/read",mapOf("items" to listOf(mapOf("id" to id,"version" to version))),user.token,key=key)
            assertFalse(entry()["unread"].asBoolean());assertEquals(0,summary())
            handle(1,"IN_PROGRESS","正在核查")
            val replied=entry();assertTrue(replied["unread"].asBoolean());assertEquals(1,summary())
            assertEquals(2,handle(2,"IN_PROGRESS","正在核查")["version"].asInt())
            assertEquals(replied["updatedAt"],entry()["updatedAt"])
            assertEquals(1,read(2)["acknowledgedCount"].asInt())
            assertFalse(entry()["unread"].asBoolean());assertEquals(0,summary())
            assertEquals(replied["updatedAt"],entry()["updatedAt"]);assertEquals(2,entry()["version"].asInt())

            jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",user.email)
            val challenge=call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to user.email),null,201)
            val secondToken=call("POST","/auth/email-code-sessions",mapOf("challengeId" to id(challenge),"code" to code(id(challenge)),"deviceId" to UUID.randomUUID()),null)["accessToken"].asText()
            assertEquals(0,call("GET","/me/feedback-summary",token=secondToken)[countField].asInt())
            handle(2,"IN_PROGRESS","已更新回复")
            read(2);assertTrue(entry()["unread"].asBoolean());assertEquals(1,summary())
            read(3);assertEquals(0,summary())
            handle(3,"RESOLVED","已更新回复");assertTrue(entry()["unread"].asBoolean())
            val key=UUID.randomUUID();assertEquals(read(4,key),read(4,key))
            call("PUT","/me/$resource/read",mapOf("items" to listOf(mapOf("id" to id,"version" to 3))),user.token,409,key)
            read(2);assertFalse(entry()["unread"].asBoolean())
            handle(4,"IN_PROGRESS"," \t\n\u00a0");assertFalse(entry()["unread"].asBoolean());assertEquals(0,summary())
            assertEquals("",entry()["response"].asText())
            call("PUT","/admin/$resource/$id",mapOf("expectedVersion" to 5,"status" to "RESOLVED","response" to " \n"),status=422)
            call("PUT","/me/$resource/read",mapOf("items" to listOf(mapOf("id" to id,"version" to 6))),user.token,422)
            call("PUT","/me/$resource/read",mapOf("items" to listOf(mapOf("id" to id,"version" to 0))),user.token,422)
        }
    }

    @Test fun `read batches enforce ownership size and transaction boundaries`() {
        val user=student();val other=student()
        fun request(token: String)=id(call("POST","/me/course-requests",mapOf("courseName" to "课程","body" to "缺少题库"),token))
        val own=request(user.token);val foreign=request(other.token)
        val first=mapOf("id" to own,"version" to 1)
        call("GET","/me/feedback-summary",token=null,status=401)
        call("GET","/me/feedback-summary",status=403)
        call("PUT","/me/course-requests/read",mapOf("items" to emptyList<Any>()),user.token,422)
        call("PUT","/me/course-requests/read",mapOf("items" to listOf(first,first)),user.token,422)
        call("PUT","/me/course-requests/read",mapOf("items" to (1..21).map { mapOf("id" to UUID.randomUUID(),"version" to 1) }),user.token,422)
        call("PUT","/me/course-requests/read",mapOf("items" to listOf(first,mapOf("id" to foreign,"version" to 1))),user.token,404)
        assertEquals(0L,jdbc.queryForObject("SELECT read_version FROM course_request WHERE id=?",Long::class.java,own)!!)
        call("PUT","/me/course-requests/read",mapOf("items" to listOf(first,mapOf("id" to UUID.randomUUID(),"version" to 1))),user.token,404)
        assertEquals(0L,jdbc.queryForObject("SELECT read_version FROM course_request WHERE id=?",Long::class.java,own)!!)
    }

    @Test fun `updated replies lead student pages and reading preserves pagination`() {
        val user=student();val ids=(0..24).map { UUID.randomUUID() };val now=Instant.now()
        ids.forEachIndexed { index,id ->
            val at=java.sql.Timestamp.from(now.minusSeconds(index+60L))
            jdbc.update("INSERT INTO course_request(id,user_id,course_name,body,response,version,created_at,updated_at) VALUES(?,?,'课程','需求','回复',2,?,?)",id,user.id,at,at)
        }
        jdbc.update("UPDATE course_request SET updated_at=? WHERE id=?",java.sql.Timestamp.from(now),ids.last())
        val page=call("GET","/me/course-requests",token=user.token)
        assertEquals(ids.last().toString(),page["items"].first()["id"].asText());assertEquals(25,page["total"].asInt())
        assertEquals(25,call("GET","/me/feedback-summary",token=user.token)["courseRequestUnreadCount"].asInt())
        val items=page["items"].map { mapOf("id" to it["id"].asText(),"version" to it["version"].asLong()) }
        call("PUT","/me/course-requests/read",mapOf("items" to items),user.token)
        val reloaded=call("GET","/me/course-requests",token=user.token)
        assertEquals(page["items"].map { it["id"] },reloaded["items"].map { it["id"] })
        assertTrue(reloaded["items"].all { !it["unread"].asBoolean() })
        assertEquals(5,call("GET","/me/feedback-summary",token=user.token)["courseRequestUnreadCount"].asInt())
        assertTrue(call("GET","/me/course-requests?page=2",token=user.token)["items"].all { it["unread"].asBoolean() })
    }
}
