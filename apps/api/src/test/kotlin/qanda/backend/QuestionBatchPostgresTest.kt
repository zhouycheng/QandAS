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
        override fun intercept(invocation: Invocation): Any? {
            count.get()?.let { count.set(it+1) }
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
            }
        } finally { statements.count.remove() }
    }
}
