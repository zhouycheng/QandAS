package qanda.backend

import org.apache.ibatis.executor.statement.StatementHandler
import org.apache.ibatis.plugin.*
import org.apache.ibatis.session.SqlSessionFactory
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.transaction.support.TransactionTemplate
import qanda.backend.content.QuestionReader
import qanda.backend.content.api.RevisionReference
import java.sql.Connection
import java.util.UUID

class QuestionBatchPostgresTest : PostgresFixture() {
    @Autowired lateinit var reader: QuestionReader
    @Autowired lateinit var factory: SqlSessionFactory

    @Intercepts(Signature(type=StatementHandler::class,method="prepare",args=[Connection::class,Integer::class]))
    class Statements : Interceptor {
        val count=ThreadLocal<Int>()
        val httpCount=java.util.concurrent.atomic.AtomicInteger()
        override fun intercept(invocation: Invocation): Any? {
            count.get()?.let { count.set(it+1) }
            val request=(org.springframework.web.context.request.RequestContextHolder.getRequestAttributes() as? org.springframework.web.context.request.ServletRequestAttributes)?.request
            if(request?.getHeader("X-Perf-Measure")=="true") httpCount.incrementAndGet()
            return invocation.proceed()
        }
    }

    @Test fun `question batches keep pinned answers and constant SQL round trips`() {
        val f=fixture();val refs=(1..1000).map { RevisionReference(UUID.randomUUID(),UUID.randomUUID()) }
        TransactionTemplate(transactionManager).executeWithoutResult {
            refs.forEach { ref ->
                jdbc.update("INSERT INTO question(id,bank_id,status,current_revision_id) VALUES(?,?,'ACTIVE',?)",ref.questionId,f.bank,ref.revisionId)
                jdbc.update("INSERT INTO question_revision(id,question_id,revision_number,type,stem,created_by) VALUES(?,?,1,'SINGLE_CHOICE','批量题目',?)",ref.revisionId,ref.questionId,platformId)
                jdbc.update("INSERT INTO question_option(revision_id,option_key,content,is_correct,sort_order) VALUES(?,'A','甲',true,0),(?,'B','乙',false,1)",ref.revisionId,ref.revisionId)
            }
        }
        val statements=Statements();factory.configuration.addInterceptor(statements)
        try {
            var requestSql: Int?=null
            var finishSql: Int?=null
            listOf(20,100,1000).forEach { size ->
                val selected=refs.take(size)
                statements.count.set(0);val start=System.nanoTime()
                val single=selected.flatMap { reader.read(listOf(it),true) }
                val singleNanos=System.nanoTime()-start;val singleSql=statements.count.get()
                statements.count.set(0);val batchStart=System.nanoTime()
                val batch=reader.read(selected,true)
                val batchNanos=System.nanoTime()-batchStart;val batchSql=statements.count.get()
                statements.count.remove()
                assertEquals(single,batch);assertEquals(4,batchSql);assertEquals(size*4,singleSql)
                assertTrue(batch.all { it.correctAnswer==listOf("A") && it.options.size==2 })
                println("QUESTION_BATCH_EVIDENCE size=$size singleSql=$singleSql batchSql=$batchSql singleMs=${singleNanos/1000000} batchMs=${batchNanos/1000000}")
                val learner=student()
                val scope=mapOf("questionBankId" to f.bank,"questionIds" to selected.map { it.questionId },"count" to size,"order" to "SEQUENTIAL")
                val preview=call("POST","/practice/scope-preview",scope,learner.token)
                statements.httpCount.set(0)
                val httpStart=System.nanoTime()
                val deviceId=UUID.randomUUID()
                val created=raw("POST","/practice/sessions",mapOf("scope" to scope,"expectedContentVersion" to preview["contentVersion"].asLong(),"deviceId" to deviceId,"feedback" to "AFTER_FINISH"),learner.token,extraHeaders=mapOf("X-Perf-Measure" to "true"))
                assertEquals(200,created.statusCode(),created.body())
                val session=json.readTree(created.body())
                val snapshot=raw("GET","/practice/sessions/${id(session)}/snapshot?deviceId=$deviceId",token=learner.token,extraHeaders=mapOf("X-Perf-Measure" to "true","X-Practice-Writer" to session["writer"]["writerToken"].asText()))
                assertEquals(200,snapshot.statusCode(),snapshot.body())
                assertEquals(size,json.readTree(snapshot.body())["items"].size())
                if(requestSql==null) requestSql=statements.httpCount.get() else assertEquals(requestSql,statements.httpCount.get(),"Practice size must not add SQL round trips")
                println("PRACTICE_PAYLOAD_EVIDENCE size=$size requests=2 mybatisSql=${statements.httpCount.get()} createBytes=${created.body().toByteArray().size} snapshotBytes=${snapshot.body().toByteArray().size} elapsedMs=${(System.nanoTime()-httpStart)/1000000}")
                val sessionId=id(session)
                // Stage saved answers so the finish measurement excludes command delivery.
                TransactionTemplate(transactionManager).executeWithoutResult {
                    jdbc.update("INSERT INTO practice_item_choice(item_id,revision_id,option_key) SELECT id,revision_id,'A' FROM practice_item WHERE session_id=?",sessionId)
                    jdbc.update("UPDATE practice_item SET confirmed=true WHERE session_id=?",sessionId)
                }
                statements.httpCount.set(0)
                val finishStart=System.nanoTime()
                val key=UUID.randomUUID()
                val body=mapOf("expectedVersion" to session["version"].asLong(),"writerToken" to session["writer"]["writerToken"].asText(),"durationSeconds" to 0,"items" to emptyList<Any>(),"kind" to "FINISH","clientSequence" to 1,"currentIndex" to 0)
                call("POST","/practice/sessions/$sessionId/sync-commands",body,learner.token,202,key)
                consumers.stop()
                statements.count.set(0)
                progressCommands.consume(qanda.backend.application.ProgressEnvelope(key))
                val workSql=statements.count.get();statements.count.remove();consumers.start()
                val result=call("GET","/practice/sessions/$sessionId/result",token=learner.token)
                assertEquals(size,result["answeredCount"].asInt());assertEquals(size,result["objective"]["correct"].asInt())
                assertEquals(result,call("GET","/practice/sessions/$sessionId/result",token=learner.token))
                if(finishSql==null) finishSql=workSql else assertEquals(finishSql,workSql,"Grading saved answers must not add SQL round trips")
                println("PRACTICE_FINISH_EVIDENCE size=$size mybatisSql=${statements.httpCount.get()} elapsedMs=${(System.nanoTime()-finishStart)/1000000}")
            }
        } finally { statements.count.remove() }
    }
}
