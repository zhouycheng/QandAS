package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import java.util.UUID

class ClientResultsPostgresTest : PostgresFixture() {
    @Test fun `client results preserve local judgments and pinned revisions without regrading`() {
        val owner=student();val f=fixture()
        val bank=call("GET","/question-banks/${f.bank}",token=owner.token)
        val session=call("POST","/practice/sessions",mapOf("scope" to mapOf("questionBankId" to f.bank,"count" to 4,"order" to "SEQUENTIAL"),"expectedContentVersion" to bank["contentVersion"].asLong(),"deviceId" to UUID.randomUUID()),owner.token)
        val path="/practice/sessions/${id(session)}/sync-commands"
        val changes=answers(session).mapIndexed { index, answer ->
            val item=session["items"][index]
            answer+mapOf("revisionId" to item["question"]["revisionId"].asText(),"materialRevisionId" to null,"outcome" to if(item["question"]["type"].asText()=="SHORT_ANSWER") "SELF_RATED" else "WRONG")
        }
        val result=mapOf("totalCount" to 4,"answeredCount" to 4,
            "objective" to mapOf("count" to 3,"answered" to 3,"correct" to 0,"wrong" to 3,"unanswered" to 0,"accuracy" to 0.0,"score" to 0),
            "shortAnswer" to mapOf("count" to 1,"answered" to 1,"rated" to 0,"correct" to 0,"wrong" to 0,"unrated" to 1))
        val submittedAt=java.time.Instant.now().minusSeconds(86400).truncatedTo(java.time.temporal.ChronoUnit.MILLIS)
        val input=progressBody(session)+mapOf("kind" to "FINISH","items" to changes,"clientResult" to result,"submittedAt" to submittedAt.toString())
        val key=UUID.randomUUID()
        val accepted=call("POST",path,input,owner.token,202,key)
        eventually { call("GET","$path/$key",token=owner.token)["state"].asText()=="COMMITTED" }
        val receipt=call("GET","$path/$key",token=owner.token)
        assertFalse(receipt.has("result"));assertFalse(receipt["resultId"].isNull)
        val saved=call("GET","/practice/sessions/${id(session)}/result",token=owner.token)
        assertEquals("CLIENT",saved["resultSource"].asText())
        assertEquals(submittedAt,java.time.Instant.parse(saved["submittedAt"].asText()))
        assertEquals(0,saved["objective"]["correct"].asInt());assertEquals(3,saved["objective"]["wrong"].asInt())
        assertEquals(receipt,call("POST",path,input,owner.token,202,key))
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM practice_result WHERE session_id=?",Int::class.java,id(session)))
        val overview=call("GET","/me/learning-overview?pendingSessionIds=${id(session)}",token=owner.token)
        assertEquals(id(session).toString(),overview["includedSessionIds"][0].asText())
        val short=saved["items"].first { it["outcome"].asText()=="SELF_RATED" }
        val localQuery=mapOf("pendingSessionIds" to listOf(id(session)),"pendingAssessmentItemIds" to listOf(short["itemId"].asText()))
        val beforeRating=call("POST","/me/learning-overview",localQuery,owner.token)
        assertTrue(beforeRating["assessmentFacts"][0]["selfAssessment"].isNull)
        call("PUT","/practice/sessions/${id(session)}/items/${short["itemId"].asText()}/self-assessment",mapOf("expectedVersion" to saved["version"].asLong(),"assessment" to "WRONG"),owner.token)
        val rated=call("POST","/me/statistics",localQuery+mapOf("period" to "ALL"),owner.token)
        assertEquals("WRONG",rated["assessmentFacts"][0]["selfAssessment"].asText());assertEquals(1,rated["selfRatedWrongCount"].asInt())
        val day=submittedAt.atZone(java.time.ZoneId.of("Asia/Shanghai")).toLocalDate()
        val days=call("POST","/me/statistics/days",mapOf("startDate" to day.toString(),"endDateExclusive" to day.plusDays(2).toString(),"pendingSessionIds" to listOf(id(session))),owner.token)
        assertEquals(1,days[0]["practiceCount"].asInt());assertEquals(id(session).toString(),days[0]["includedSessionIds"][0].asText());assertEquals(0,days[1]["practiceCount"].asInt())
        val refs=session["items"].map { item -> mapOf("questionId" to item["question"]["id"].asText(),"revisionId" to item["question"]["revisionId"].asText()) }
        val same=call("POST","/content/revision-status",mapOf("items" to refs),owner.token)
        assertTrue(same.all { !it["changed"].asBoolean() && it["available"].asBoolean() })
        call("POST","/content/revision-status",mapOf("items" to emptyList<Any>()),owner.token,422)
        call("POST","/content/revision-status",mapOf("items" to (1..101).map { mapOf("questionId" to UUID.randomUUID(),"revisionId" to UUID.randomUUID()) }),owner.token,422)
        val q=f.questions.first();val current=call("GET","/admin/questions/$q")
        call("PUT","/admin/questions/$q",question(f.bank,current["type"].asText())+mapOf("expectedVersion" to current["version"].asLong(),"stem" to "新版题目"))
        val changed=call("POST","/content/revision-status",mapOf("items" to refs),owner.token)
        assertTrue(changed.first { it["questionId"].asText()==q.toString() }["changed"].asBoolean())
        val unchanged=call("GET","/practice/sessions/${id(session)}/result",token=owner.token)
        assertEquals(saved["objective"],unchanged["objective"]);assertEquals(saved["items"][0]["question"]["revisionId"],unchanged["items"][0]["question"]["revisionId"])
        assertEquals(accepted["commandId"],receipt["commandId"])
    }

    @Test fun `client result revision and arithmetic failures roll back answers atomically`() {
        val owner=student();val session=createPractice(owner,fixture())
        val path="/practice/sessions/${id(session)}/sync-commands"
        val input=progressBody(session)+mapOf("items" to answers(session).map { it+mapOf("revisionId" to UUID.randomUUID(),"outcome" to "WRONG") })
        val key=UUID.randomUUID();call("POST",path,input,owner.token,202,key)
        eventually { call("GET","$path/$key",token=owner.token)["state"].asText()=="REJECTED" }
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM practice_item WHERE session_id=? AND confirmed",Int::class.java,id(session)))
        val other=createPractice(owner,fixture())
        val wrongSummary=mapOf("totalCount" to 0,"answeredCount" to 0,
            "objective" to mapOf("count" to 0,"answered" to 0,"correct" to 0,"wrong" to 0,"unanswered" to 0,"accuracy" to null,"score" to null),
            "shortAnswer" to mapOf("count" to 0,"answered" to 0,"rated" to 0,"correct" to 0,"wrong" to 0,"unrated" to 0))
        val finish=progressBody(other)+mapOf("kind" to "FINISH","items" to answers(other),"clientResult" to wrongSummary)
        val otherKey=UUID.randomUUID();val otherPath="/practice/sessions/${id(other)}/sync-commands"
        call("POST",otherPath,finish,owner.token,202,otherKey)
        eventually { call("GET","$otherPath/$otherKey",token=owner.token)["state"].asText()=="REJECTED" }
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM practice_item WHERE session_id=? AND confirmed",Int::class.java,id(other)))
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM practice_result WHERE session_id=?",Int::class.java,id(other)))
    }
}
