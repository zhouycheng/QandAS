package qanda.backend

import io.micrometer.core.instrument.MeterRegistry
import org.apache.ibatis.session.SqlSessionFactory
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeEach
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.GenericContainer
import qanda.backend.content.*
import qanda.backend.content.api.RevisionReference
import java.util.UUID
import java.util.concurrent.TimeUnit

@org.springframework.test.context.TestPropertySource(properties=["qanda.backend.content-cache.enabled=true"])
@org.springframework.test.annotation.DirtiesContext(classMode=org.springframework.test.annotation.DirtiesContext.ClassMode.AFTER_CLASS)
class ContentRedisPostgresTest: PostgresFixture() {
    companion object {
        val namespace="qanda-test-content:"+UUID.randomUUID().toString()
        val redis=GenericContainer<Nothing>("redis:8.10.3-alpine").apply {
            withExposedPorts(6379);withCommand("redis-server","--requirepass","isolated-cache-password","--save","","--appendonly","no")
        }
        @JvmStatic @DynamicPropertySource fun cacheProperties(r: DynamicPropertyRegistry) {
            redis.start()
            r.add("spring.data.redis.host") { redis.host };r.add("spring.data.redis.port") { redis.getMappedPort(6379) }
            r.add("spring.data.redis.password") { "isolated-cache-password" }
            r.add("qanda.backend.content-cache.namespace") { namespace }
        }
    }
    @Autowired lateinit var cache: ContentCache
    @BeforeEach fun waitForHealthyCache() {
        // A cold connection may trip the short production timeout and its recovery window.
        eventually {
            cache.put("readiness",mapOf("ready" to CachedBankCounts(1,1)))
            cache.read("readiness",listOf("ready"),CachedBankCounts::class.java)["ready"]==CachedBankCounts(1,1)
        }
    }
    @Autowired lateinit var cacheRedis: StringRedisTemplate
    @Autowired lateinit var reader: QuestionReader
    @Autowired lateinit var factory: SqlSessionFactory
    @Autowired lateinit var content: ContentService
    @Autowired lateinit var banks: QuestionBankMapper
    @Autowired lateinit var queries: ContentQueries
    @Autowired lateinit var meters: MeterRegistry

    @Test fun `warm revisions preserve answers and current visibility with one batched question read`() {
        val f=fixture();val learner=student()
        val refs=f.questions.map { RevisionReference(it,jdbc.queryForObject("SELECT current_revision_id FROM question WHERE id=?",UUID::class.java,it)) }
        val first=reader.read(refs,true)
        val statements=QuestionBatchPostgresTest.Statements();factory.configuration.addInterceptor(statements)
        try {
            statements.count.set(0);val warm=reader.read(refs,true)
            assertEquals(first,warm);assertEquals(1,statements.count.get())
        } finally { statements.count.remove() }
        assertTrue(reader.read(refs,false).all { it.correctAnswer==null && it.correctValue==null && it.referenceAnswer==null && it.explanation==null })
        val practice=createPractice(learner,f)
        val finished=finish("/practice/sessions/${id(practice)}/finish",mapOf("expectedVersion" to practice["version"].asLong(),
            "writerToken" to practice["writer"]["writerToken"].asText(),"durationSeconds" to 0,"items" to answers(practice)),learner.token)
        assertEquals(4,finished["answeredCount"].asInt());assertEquals(0,finished["objective"]["wrong"].asInt())
        assertEquals(finished,call("GET","/practice/sessions/${id(practice)}/result",token=learner.token))
        val bank=call("GET","/admin/question-banks/${f.bank}")
        call("PUT","/admin/question-banks/${f.bank}/publication",mapOf("expectedVersion" to bank["version"].asLong(),"status" to "UNPUBLISHED"))
        raw("GET","/questions/${f.questions.first()}",token=learner.token).also { assertEquals(404,it.statusCode(),it.body()) }
    }

    @Test fun `cached counts expire by content version while individual progress remains live`() {
        val f=fixture();val learner=student();val path="/question-banks?subjectId=${f.subject}&includeProgress=true"
        fun current()=call("GET",path,token=learner.token)["items"].first { it["id"].asText()==f.bank.toString() }
        val before=current();assertEquals(4,before["questionCount"].asInt())
        val key="$namespace:bank-counts:${f.bank}:${before["contentVersion"].asLong()}"
        assertNotNull(cacheRedis.opsForValue().get(key));assertTrue((cacheRedis.getExpire(key,TimeUnit.SECONDS) ?: 0L) in 1L..4200L)
        val session=createPractice(learner,f)
        val acknowledgement=progress("/practice/sessions/${id(session)}/sync-commands",progressBody(session),learner.token)
        finish("/practice/sessions/${id(session)}/finish",mapOf("expectedVersion" to acknowledgement["version"].asLong(),
            "writerToken" to session["writer"]["writerToken"].asText(),"durationSeconds" to 0,"items" to answers(session)),learner.token)
        eventually { current()["progress"]["answeredCount"].asInt()>0 }
        val question=call("GET","/admin/questions/${f.questions.first()}")
        call("DELETE","/admin/questions/${f.questions.first()}?expectedVersion=${question["version"].asLong()}")
        val after=current();assertEquals(3,after["questionCount"].asInt());assertTrue(after["contentVersion"].asLong()>before["contentVersion"].asLong())
    }

    @Test fun `rolled back counts cannot poison a later use of the same version`() {
        val f=fixture();val old=banks.selectById(f.bank).contentVersion
        val key="$namespace:bank-counts:${f.bank}:${old+1}"
        TransactionTemplate(transactionManager).executeWithoutResult { status ->
            jdbc.update("UPDATE question SET status='INACTIVE' WHERE id=?",f.questions.first());queries.bumpBank(f.bank)
            assertEquals(3L,content.bankView(banks.selectById(f.bank),false).questionCount)
            assertNull(cacheRedis.opsForValue().get(key));status.setRollbackOnly()
        }
        assertNull(cacheRedis.opsForValue().get(key))
        TransactionTemplate(transactionManager).executeWithoutResult {
            queries.bumpBank(f.bank);assertEquals(4L,content.bankView(banks.selectById(f.bank),false).questionCount)
        }
        assertEquals(4,json.readTree(cacheRedis.opsForValue().get(key))["questionCount"].asInt())
    }

    @Test fun `cache timeout falls back to PostgreSQL and recovers`() {
        val f=fixture();val learner=student();call("GET","/question-banks/${f.bank}",token=learner.token)
        val failures=meters.get("qanda.content.cache.failures").counter().count()
        val paused=redis.execInContainer("sh","-c","REDISCLI_AUTH=isolated-cache-password redis-cli CLIENT PAUSE 1500 ALL")
        assertEquals(0,paused.exitCode)
        assertEquals(4,call("GET","/question-banks/${f.bank}",token=learner.token)["questionCount"].asInt())
        assertTrue(meters.get("qanda.content.cache.failures").counter().count()>failures)
        val hits=meters.get("qanda.content.cache.requests").tags("cache","bank-counts","result","hit").counter().count()
        eventually(8) { call("GET","/question-banks/${f.bank}",token=learner.token)["questionCount"].asInt()==4 && meters.get("qanda.content.cache.requests").tags("cache","bank-counts","result","hit").counter().count()>hits }
    }
    @Autowired lateinit var practiceService: qanda.backend.practice.PracticeService
    @Autowired lateinit var sessions: qanda.backend.identity.Sessions
    @Test fun `candidate cache preserves random selection invalidation and transaction rollback`() {
        val f=fixture();val learner=student();val actor=sessions.authenticate(learner.token)
        val scope=qanda.backend.practice.ScopeInput(f.bank,count=2,order="RANDOM")
        val first=practiceService.preview(actor,scope)
        val version=first.contentVersion
        assertNotNull(cacheRedis.opsForValue().get("$namespace:practice-groups:${f.bank}:$version"))
        val sets=(1..16).map { practiceService.preview(actor,scope).selectedQuestionIds }.toSet()
        assertTrue(sets.size>1,"Random practice must not share a cached final selection")
        val key="$namespace:practice-groups:${f.bank}:${version+1}"
        TransactionTemplate(transactionManager).executeWithoutResult { status ->
            jdbc.update("UPDATE question SET status='INACTIVE' WHERE id=?",f.questions.first());queries.bumpBank(f.bank)
            assertEquals(3,practiceService.preview(actor,scope).availableCount.toInt())
            assertNull(cacheRedis.opsForValue().get(key));status.setRollbackOnly()
        }
        TransactionTemplate(transactionManager).executeWithoutResult { queries.bumpBank(f.bank) }
        assertEquals(4,practiceService.preview(actor,scope).availableCount.toInt())
        val q=call("GET","/admin/questions/${f.questions.first()}")
        call("DELETE","/admin/questions/${f.questions.first()}?expectedVersion=${q["version"].asLong()}")
        assertEquals(3,practiceService.preview(actor,scope).availableCount.toInt())
    }
    @Test fun `Redis data loss cannot remove accepted answers or final results`() {
        val learner=student();val f=fixture();val session=createPractice(learner,f);val id=id(session);val key=UUID.randomUUID()
        consumers.stop()
        try {
            call("POST","/practice/sessions/$id/sync-commands",progressBody(session)+mapOf("kind" to "FINISH"),learner.token,202,key)
            cacheRedis.keys("$namespace:*").takeIf { it.isNotEmpty() }?.let { cacheRedis.delete(it) }
            progressCommands.consume(qanda.backend.application.ProgressEnvelope(key))
            val result=call("GET","/practice/sessions/$id/result",token=learner.token)
            assertEquals(4,result["answeredCount"].asInt());assertEquals(0,result["objective"]["wrong"].asInt())
        } finally { consumers.start() }
    }

}
