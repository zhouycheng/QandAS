package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.dao.DataAccessException
import org.springframework.transaction.support.TransactionTemplate
import qanda.backend.content.api.ContentLibrary
import qanda.backend.content.ReadingChildInput
import java.io.ByteArrayInputStream
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream

class ThroughputPostgresTest : PostgresFixture() {
    @Autowired lateinit var content: ContentLibrary

    @Test fun `student credential changes invalidate the next authenticated request`() {
        val learner=student()
        call("GET","/me",token=learner.token)
        jdbc.update("UPDATE user_account SET credential_version=credential_version+1 WHERE id=?",learner.id)
        call("GET","/me",token=learner.token,status=401)
    }

    @Test fun `active question reads preserve inactive parent and standalone rules`() {
        val f=fixture()
        val parent=id(call("POST","/admin/questions",question(f.bank,"READING") + mapOf(
            "passage" to "阅读材料", "subQuestions" to listOf(
                ReadingChildInput(type="TRUE_FALSE",stem="第一小题",correctValue=true,explanation="判断依据"),
                ReadingChildInput(type="TRUE_FALSE",stem="第二小题",correctValue=false,explanation="判断依据")))))
        val children=call("GET","/admin/questions/$parent")["subQuestions"].map { UUID.fromString(it["id"].asText()) }
        jdbc.update("UPDATE question SET status='INACTIVE' WHERE id IN (?,?)",f.questions.first(),parent)
        val expected=f.questions.drop(1).toSet()
        val actual=jdbc.query("SELECT id FROM active_question WHERE bank_id=?",{ row,_ -> row.getObject(1,UUID::class.java) },f.bank).toSet()
        assertEquals(expected,actual)
        (f.questions+parent+children).forEach { question ->
            assertEquals(question in expected,jdbc.queryForObject("SELECT question_active(?)",Boolean::class.java,question))
        }
        val learner=student()
        val preview=call("POST","/practice/scope-preview",mapOf("questionBankId" to f.bank,"count" to 100,"order" to "SEQUENTIAL"),learner.token)
        assertEquals(3,preview["availableCount"].asInt())
        val bank=call("GET","/admin/question-banks/${f.bank}")
        assertEquals(6,bank["questionCount"].asInt());assertEquals(3,bank["activeQuestionCount"].asInt())
    }

    @Test fun `practice snapshots share their bank lock while content writers wait`() {
        val f=fixture();val locked=CountDownLatch(2);val release=CountDownLatch(1)
        val pool=Executors.newFixedThreadPool(2)
        val tasks=(1..2).map { pool.submit {
            TransactionTemplate(transactionManager).executeWithoutResult {
                content.lockBank(f.bank);locked.countDown();check(release.await(10,TimeUnit.SECONDS))
            }
        } }
        try {
            assertTrue(locked.await(5,TimeUnit.SECONDS),"Independent practice readers must acquire shared locks together")
            val failure=assertThrows(DataAccessException::class.java) {
                TransactionTemplate(transactionManager).executeWithoutResult {
                    jdbc.execute("SET LOCAL lock_timeout='250ms'")
                    jdbc.update("UPDATE question_bank SET content_version=content_version+1 WHERE id=?",f.bank)
                }
            }
            assertEquals("55P03",(failure.mostSpecificCause as java.sql.SQLException).sqlState)
        } finally {
            release.countDown()
            try { tasks.forEach { it.get(10,TimeUnit.SECONDS) } } finally { pool.shutdownNow() }
        }
        assertEquals(1,jdbc.update("UPDATE question_bank SET content_version=content_version+1 WHERE id=?",f.bank))
    }

    @Test fun `negotiated gzip reduces large JSON responses without changing their content`() {
        val f=fixture();jdbc.update("UPDATE question_bank SET description=? WHERE id=?","压缩验证".repeat(500),f.bank)
        val learner=student();val uri=URI("http://127.0.0.1:$port/api/v1/question-banks?subjectId=${f.subject}")
        fun request(encoding: String)=http.send(HttpRequest.newBuilder(uri).header("Authorization","Bearer ${learner.token}")
            .header("Accept-Encoding",encoding).GET().build(),HttpResponse.BodyHandlers.ofByteArray())
        val plain=request("identity");val gzip=request("gzip")
        assertEquals(200,plain.statusCode());assertEquals(200,gzip.statusCode())
        assertEquals("gzip",gzip.headers().firstValue("Content-Encoding").orElse(""))
        val decoded=GZIPInputStream(ByteArrayInputStream(gzip.body())).use { it.readAllBytes() }
        assertEquals(json.readTree(plain.body()),json.readTree(decoded))
        assertTrue(gzip.body().size<plain.body().size/2,"Compressible JSON should use less than half the transfer bytes")
    }
}
