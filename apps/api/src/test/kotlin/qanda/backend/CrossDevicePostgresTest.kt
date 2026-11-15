package qanda.backend

import com.fasterxml.jackson.databind.node.ObjectNode
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.springframework.dao.DataIntegrityViolationException
import qanda.backend.application.ProgressEnvelope
import java.util.UUID
import java.util.concurrent.Executors

class CrossDevicePostgresTest : PostgresFixture() {
    @Test fun `preferences belong to account and child writes are atomic versioned and idempotent`() {
        val owner=student();val other=student()
        val initial=call("GET","/me/preferences",token=owner.token)
        val p=initial["preferences"].deepCopy<ObjectNode>()
        p.put("fontSize","large");p.put("layoutMode","custom");p.put("practiceStemPercent",60)
        p.putArray("examCountdowns").add(json.readTree("""{"id":"exam-a","examName":"期末考试","examDate":"2026-12-20"}"""))
        p.withArray("practicePresets").add(json.readTree("""{"id":"second","name":"专项练习","mode":"test","feedback":"AFTER_FINISH","order":"random","count":"ALL","duration":35}"""))
        p.put("defaultPracticePresetId","second")
        val input=mapOf("expectedVersion" to 1,"preferences" to p);val key=UUID.randomUUID()
        val saved=call("PUT","/me/preferences",input,owner.token,key=key)
        assertEquals(2,saved["version"].asInt());assertEquals(p,saved["preferences"])
        assertEquals(saved,call("PUT","/me/preferences",input,owner.token,key=key))
        assertEquals(saved,call("GET","/me/preferences",token=owner.token))
        assertEquals("normal",call("GET","/me/preferences",token=other.token)["preferences"]["fontSize"].asText())
        call("PUT","/me/preferences",input,owner.token,409)
        val invalid=p.deepCopy();invalid.putArray("moduleOrder").add("stem").add("stem").add("info").add("tools")
        call("PUT","/me/preferences",mapOf("expectedVersion" to 2,"preferences" to invalid),owner.token,422)
        assertEquals(saved,call("GET","/me/preferences",token=owner.token))
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM user_practice_preset WHERE user_id=? AND is_default",Int::class.java,owner.id))
        assertThrows(DataIntegrityViolationException::class.java) { jdbc.update("INSERT INTO user_exam_countdown VALUES(?,'orphan','考试','2026-12-20',0)",UUID.randomUUID()) }
        p.putArray("examCountdowns");p.withArray("practicePresets").remove(1);p.put("defaultPracticePresetId","daily")
        call("PUT","/me/preferences",mapOf("expectedVersion" to 2,"preferences" to p),owner.token)
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM user_exam_countdown WHERE user_id=?",Int::class.java,owner.id))
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE user_id=? OR email_key=?",owner.id,owner.email)
        val challenge=call("POST","/me/email-challenges",mapOf("purpose" to "DELETE_ACCOUNT"),owner.token)
        val proof=call("POST","/me/deletion-confirmations",mapOf("challengeId" to id(challenge),"code" to code(id(challenge))),owner.token)["proof"].asText()
        call("DELETE","/me",mapOf("proof" to proof,"confirmed" to true),null)
        for(table in listOf("user_settings","user_exam_countdown","user_practice_preset")) assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM $table WHERE user_id=?",Int::class.java,owner.id))
    }

    @Test fun `online release and exclusive claim retain revisions answers timing and sequence through finish`() {
        val owner=student();val session=createPractice(owner,fixture());val sid=id(session)
        val otherDevice=UUID.randomUUID();val root="/practice/sessions/$sid"
        val recent=call("GET","/me/recent-learning?deviceId=$otherDevice",token=owner.token)
        assertTrue(recent["items"].any { it["id"].asText()==sid.toString() })
        call("POST","$root/claim-writer",mapOf("expectedVersion" to 1,"deviceId" to otherDevice),owner.token,409)
        val saved=progress("$root/sync-commands",progressBody(session)+mapOf("durationSeconds" to 3,"currentIndex" to 2),owner.token)
        val release=mapOf("expectedVersion" to saved["version"].asLong(),"writerToken" to saved["writer"]["writerToken"].asText())
        val releaseKey=UUID.randomUUID();val released=call("POST","$root/release-writer",release,owner.token,key=releaseKey)
        assertEquals(released,call("POST","$root/release-writer",release,owner.token,key=releaseKey))
        assertTrue(call("GET",root,token=owner.token)["writer"]["deviceId"].isNull)
        call("POST","$root/claim-writer",mapOf("expectedVersion" to released["version"].asLong(),"deviceId" to otherDevice),student().token,404)
        val pool=Executors.newFixedThreadPool(2)
        val attempts=listOf(UUID.randomUUID(),UUID.randomUUID()).map { device -> Triple(device,UUID.randomUUID(),mapOf("expectedVersion" to released["version"].asLong(),"deviceId" to device)) }
        val responses=try { attempts.map { (_,key,body) -> pool.submit<java.net.http.HttpResponse<String>> { raw("POST","$root/claim-writer",body,owner.token,key) } }.map { it.get() } } finally { pool.shutdownNow() }
        assertEquals(1,responses.count { it.statusCode()==200 });assertEquals(1,responses.count { it.statusCode()==409 })
        val winner=responses.indexOfFirst { it.statusCode()==200 };val claimed=json.readTree(responses[winner].body())
        assertEquals(claimed,call("POST","$root/claim-writer",attempts[winner].third,owner.token,key=attempts[winner].second))
        assertNotEquals(session["writer"]["writerToken"],claimed["writer"]["writerToken"])
        assertEquals(1,claimed["writer"]["acknowledgedSequence"].asInt());assertEquals(3,claimed["durationSeconds"].asInt());assertEquals(2,claimed["currentIndex"].asInt())
        assertEquals(session["configuration"],claimed["configuration"])
        assertEquals(session["items"].map { it["question"]["revisionId"] },claimed["items"].map { it["question"]["revisionId"] })
        assertTrue(claimed["items"].all { it["confirmed"].asBoolean() && it["marked"].asBoolean() && !it["answer"].isNull })
        call("POST","$root/sync-commands",progressBody(session)+mapOf("clientSequence" to 2),owner.token,409)
        val finish=progress("$root/sync-commands",progressBody(claimed)+mapOf("clientSequence" to 2,"kind" to "FINISH","durationSeconds" to 4),owner.token)
        assertEquals(2,finish["acknowledgedSequence"].asInt())
        assertEquals("SUBMITTED",call("GET","/me/recent-learning?deviceId=$otherDevice",token=owner.token)["items"].first { it["id"].asText()==sid.toString() }["status"].asText())
        assertEquals(4,call("GET","$root/result",token=owner.token)["durationSeconds"].asInt())
    }

    @Test fun `release refuses pending rejected and finish commands`() {
        val owner=student();val session=createPractice(owner,fixture());val sid=id(session);val root="/practice/sessions/$sid"
        consumers.stop()
        try {
            val key=UUID.randomUUID();call("POST","$root/sync-commands",progressBody(session),owner.token,202,key)
            val input=mapOf("expectedVersion" to 1,"writerToken" to session["writer"]["writerToken"].asText())
            call("POST","$root/release-writer",input,owner.token,409)
            progressCommands.failure(key,qanda.backend.platform.http.ApiException(org.springframework.http.HttpStatus.BAD_REQUEST,"INVALID_ANSWER","作答无效"))
            call("POST","$root/release-writer",input,owner.token,409)
            assertNotNull(jdbc.queryForObject("SELECT writer_token FROM practice_sync_state WHERE session_id=?",UUID::class.java,sid))
            val finishing=createPractice(owner,fixture());val finishRoot="/practice/sessions/${id(finishing)}"
            call("POST","$finishRoot/sync-commands",progressBody(finishing)+mapOf("kind" to "FINISH"),owner.token,202)
            call("POST","$finishRoot/release-writer",mapOf("expectedVersion" to 1,"writerToken" to finishing["writer"]["writerToken"].asText()),owner.token,409)
        } finally { consumers.start() }
    }
}
