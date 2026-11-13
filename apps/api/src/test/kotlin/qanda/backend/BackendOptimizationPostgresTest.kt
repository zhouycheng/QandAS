package qanda.backend

import com.fasterxml.jackson.databind.JsonNode
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.apache.ibatis.builder.xml.XMLMapperBuilder
import org.apache.ibatis.scripting.defaults.DefaultParameterHandler
import org.apache.ibatis.session.SqlSessionFactory
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Assertions.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.context.annotation.Import
import org.springframework.mock.env.MockEnvironment
import qanda.backend.application.ProgressEnvelope
import qanda.backend.learning.*
import qanda.backend.platform.http.ApiException
import qanda.backend.platform.queries.StatsFilter
import qanda.backend.sync.api.*
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Timestamp
import java.time.*
import java.util.UUID
import java.util.concurrent.Executors

@Import(SqlObservation.Configuration::class)
class BackendOptimizationPostgresTest : PostgresFixture() {
    @Autowired lateinit var factory: SqlSessionFactory
    @Autowired lateinit var reads: LearningReadMapper
    @Autowired lateinit var learningReads: LearningReadService
    @Autowired lateinit var store: ProgressCommandStore
    @Autowired lateinit var capacity: SyncCapacity

    @BeforeAll fun observations() {
        factory.configuration.addInterceptor(SqlObservation.Mybatis())
        for(name in listOf("LearningReadContracts","LearningReadMapper","LearningMapper")) {
            val resource="optimization-baseline/$name.xml"
            javaClass.classLoader.getResourceAsStream(resource)!!.use {
                XMLMapperBuilder(it,factory.configuration,resource,factory.configuration.sqlFragments).parse()
            }
        }
    }

    @Test fun `terminal failures and their successors do not exhaust global admission`() {
        val owner=student();val session=createPractice(owner,fixture());val sid=id(session);val key=UUID.randomUUID()
        consumers.stop()
        try {
            call("POST","/practice/sessions/$sid/sync-commands",progressBody(session),owner.token,202,key)
            progressCommands.failure(key,ApiException(org.springframework.http.HttpStatus.BAD_REQUEST,"INVALID_ANSWER","作答无效"))
            jdbc.update("""INSERT INTO sync_command(id,session_id,user_id,actor_session_id,writer_token,client_sequence,payload_digest,digest_key_version,request_id,kind,payload_json,state,completed_at)
                SELECT gen_random_uuid(),session_id,user_id,actor_session_id,writer_token,n+1,payload_digest,digest_key_version,request_id,kind,payload_json,
                CASE WHEN n&lt;4100 THEN 'REJECTED' ELSE 'QUEUED' END,CASE WHEN n&lt;4100 THEN now() END
                FROM sync_command CROSS JOIN generate_series(1,4199) n WHERE id=?""".replace("&lt;","<"),key)
            capacity.refresh()
            val actor=sessionService.authenticate(owner.token)
            val independent=student();val other=createPractice(independent,fixture())
            call("POST","/practice/sessions/${id(other)}/sync-commands",progressBody(other),independent.token,202)
            call("POST","/practice/sessions/$sid/sync-commands",progressBody(session)+mapOf("clientSequence" to 4201),owner.token,409)
            progressCommands.consume(ProgressEnvelope(key))
            assertThrows(ApiException::class.java) { store.requireUnblocked(sid) }
            assertEquals("REJECTED",progressCommands.read(actor,sid,key).state)
            assertThrows(org.springframework.dao.DataIntegrityViolationException::class.java) {
                jdbc.update("UPDATE sync_command SET payload_json=NULL WHERE id=?",key)
            }
        } finally {
            jdbc.update("DELETE FROM sync_command WHERE session_id=?",sid)
            jdbc.update("UPDATE practice_sync_state SET accepted_sequence=0 WHERE session_id=?",sid)
            capacity.refresh();consumers.start()
        }
    }

    @Test fun `sparse saves read changed items and receipts exclude large payloads`() {
        val f=fixture();val owner=student()
        jdbc.update("""WITH added AS (
            INSERT INTO question(id,bank_id,status,current_revision_id)
            SELECT gen_random_uuid(),?,'ACTIVE',gen_random_uuid() FROM generate_series(1,1000) RETURNING *
        ), revisions AS (
            INSERT INTO question_revision(id,question_id,revision_number,type,stem,created_by)
            SELECT current_revision_id,id,1,'SINGLE_CHOICE','增量保存题',? FROM added RETURNING id
        ) INSERT INTO question_option(revision_id,option_key,content,is_correct,sort_order)
          SELECT id,'A','甲',true,0 FROM revisions""",f.bank,platformId)
        consumers.stop()
        try {
            for(size in listOf(20,100,1000)) {
                val bank=call("GET","/question-banks/${f.bank}",token=owner.token)
                val session=call("POST","/practice/sessions",mapOf("scope" to mapOf("questionBankId" to f.bank,"count" to size,"order" to "SEQUENTIAL"),
                    "expectedContentVersion" to bank["contentVersion"].asLong(),"deviceId" to UUID.randomUUID(),"feedback" to "IMMEDIATE"),owner.token)
                val sid=id(session);val path="/practice/sessions/$sid/sync-commands"
                var version=1L;var sequence=0L
                for(changed in listOf(0,1,3)) {
                    sequence++
                    val body=progressBody(session)+mapOf("items" to answers(session).take(changed),"expectedVersion" to version,"clientSequence" to sequence,"currentIndex" to size-1)
                    val key=UUID.randomUUID();call("POST",path,body,owner.token,202,key)
                    val (_,sample)=SqlObservation.measure { progressCommands.consume(ProgressEnvelope(key)) }
                    val itemQueries=sample.queries.filter { it.sql.startsWith("SELECT * FROM practice_item WHERE") }
                    val shapeQueries=sample.queries.filter { it.sql.startsWith("SELECT i.id item_id,r.type") }
                    assertEquals(if(changed==0) 0 else changed,itemQueries.sumOf { it.rows })
                    assertEquals(if(changed==0) 0 else changed,shapeQueries.sumOf { it.rows })
                    assertEquals("COMMITTED",jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,key))
                    version++
                    println("SPARSE_SAVE_EVIDENCE size=$size changed=$changed jdbcSql=${sample.queries.size} mybatisSql=${sample.mybatis} itemRows=${itemQueries.sumOf { it.rows }} shapeRows=${shapeQueries.sumOf { it.rows }}")
                }
                val finishKey=UUID.randomUUID()
                call("POST",path,progressBody(session)+mapOf("kind" to "FINISH","expectedVersion" to version,"clientSequence" to sequence+1),owner.token,202,finishKey)
                val (_,finishSql)=SqlObservation.measure { progressCommands.consume(ProgressEnvelope(finishKey)) }
                assertEquals("COMMITTED",jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,finishKey))
                assertEquals(1,finishSql.queries.count { it.sql.startsWith("SELECT i.id item_id,r.type") })
                val actor=sessionService.authenticate(owner.token)
                val (_,receiptSql)=SqlObservation.measure { progressCommands.read(actor,sid,finishKey) }
                assertTrue(receiptSql.queries.none { it.sql.contains("payload_json") || it.sql.contains("c.*") })
                println("CLIENT_FINISH_EVIDENCE size=$size jdbcSql=${finishSql.queries.size} mybatisSql=${finishSql.mybatis} receiptJdbcSql=${receiptSql.queries.size}")
                val foreign=createPractice(student(),f)
                val invalidSession=createPractice(owner,f)
                val invalidPath="/practice/sessions/${id(invalidSession)}/sync-commands"
                val foreignItem=answers(foreign).first()+mapOf("revisionId" to foreign["items"][0]["question"]["revisionId"].asText(),"materialRevisionId" to foreign["items"][0]["question"]["material"]?.get("revisionId")?.asText())
                val invalid=progressBody(invalidSession)+mapOf("items" to listOf(foreignItem))
                val badKey=UUID.randomUUID();call("POST",invalidPath,invalid,owner.token,202,badKey)
                val invalidItem=assertThrows(ApiException::class.java) { progressCommands.consume(ProgressEnvelope(badKey)) }
                assertEquals("VALIDATION_FAILED",invalidItem.code)
                progressCommands.failure(badKey,invalidItem)
            }
        } finally { consumers.start() }
    }

    @Test fun `compaction preserves idempotency and skips active work at thirty day boundary`() {
        val owner=student();val f=fixture();val session=createPractice(owner,f);val sid=id(session);val path="/practice/sessions/$sid/sync-commands"
        val key=UUID.randomUUID();val body=progressBody(session)
        call("POST",path,body,owner.token,202,key)
        eventually { jdbc.queryForObject("SELECT state FROM sync_command WHERE id=?",String::class.java,key)=="COMMITTED" }
        val actor=sessionService.authenticate(owner.token);val before=progressCommands.read(actor,sid,key)
        val now=Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MICROS);val cutoff=now.minus(Duration.ofDays(30))
        jdbc.update("UPDATE sync_command SET completed_at=? WHERE id=?",Timestamp.from(cutoff.minusSeconds(1)),key)
        val meters=SimpleMeterRegistry()
        val cleaner=SyncPayloadRetention(jdbc,MockEnvironment().withProperty("qanda.backend.worker-enabled","true"),Clock.fixed(now,ZoneOffset.UTC),transactionManager,meters)
        consumers.stop()
        try {
            assertEquals(1L,cleaner.compact())
            assertNull(jdbc.queryForObject("SELECT payload_json FROM sync_command WHERE id=?",String::class.java,key))
            assertEquals(0,jdbc.queryForObject("SELECT payload_bytes FROM sync_command WHERE id=?",Int::class.java,key))
            assertEquals(before,progressCommands.read(actor,sid,key))
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM monitoring_sync_completion WHERE completed_at=?",Int::class.java,Timestamp.from(cutoff.minusSeconds(1))))
            assertEquals(json.readTree(json.writeValueAsString(before)),call("POST",path,body,owner.token,202,key))
            call("POST",path,body+mapOf("currentIndex" to 1),owner.token,409,key)
            progressCommands.consume(ProgressEnvelope(key))
            val (_,receiptSql)=SqlObservation.measure { progressCommands.read(actor,sid,key) }
            assertTrue(receiptSql.queries.none { it.sql.contains("payload_json") || it.sql.contains("c.*") })
            // A completed body is redundant; current answers remain in business tables.
            assertEquals(4,jdbc.queryForObject("SELECT count(*) FROM practice_item WHERE session_id=? AND confirmed",Int::class.java,sid))
            val secondKey=UUID.randomUUID()
            call("POST",path,body+mapOf("expectedVersion" to 2,"clientSequence" to 2),owner.token,202,secondKey)
            progressCommands.consume(ProgressEnvelope(secondKey))
            jdbc.update("UPDATE sync_command SET completed_at=? WHERE id=?",Timestamp.from(cutoff),secondKey)
            assertEquals(0L,cleaner.compact())
            assertNotNull(store.payload(secondKey))
            jdbc.update("""WITH receipts AS (
                INSERT INTO command_receipt(id,scope,operation,command_id,actor_user_id,payload_digest,digest_key_version,response_json)
                SELECT gen_random_uuid(),scope,'RETENTION_TEST',gen_random_uuid(),actor_user_id,payload_digest,digest_key_version,response_json
                FROM command_receipt CROSS JOIN generate_series(1,501) WHERE id=(SELECT receipt_id FROM sync_command WHERE id=?) RETURNING *
            ) INSERT INTO sync_command(id,session_id,user_id,actor_session_id,writer_token,client_sequence,payload_digest,digest_key_version,request_id,kind,payload_json,state,receipt_id,completed_at)
              SELECT r.command_id,c.session_id,c.user_id,c.actor_session_id,c.writer_token,row_number() OVER()+2,c.payload_digest,c.digest_key_version,c.request_id,c.kind,c.payload_json,'COMMITTED',r.id,?
              FROM receipts r CROSS JOIN sync_command c WHERE c.id=?""",secondKey,Timestamp.from(cutoff.minusSeconds(1)),secondKey)
            jdbc.execute("CREATE FUNCTION optimization_fail_compaction() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''injected cleanup interruption''; END'")
            jdbc.execute("CREATE TRIGGER optimization_fail_compaction BEFORE UPDATE OF payload_json ON sync_command FOR EACH ROW EXECUTE FUNCTION optimization_fail_compaction()")
            try {
                assertThrows(org.springframework.dao.DataAccessException::class.java) { cleaner.compact() }
                assertEquals(501,jdbc.queryForObject("SELECT count(*) FROM sync_command WHERE session_id=? AND client_sequence>2 AND payload_json IS NOT NULL",Int::class.java,sid))
            } finally {
                jdbc.execute("DROP TRIGGER optimization_fail_compaction ON sync_command")
                jdbc.execute("DROP FUNCTION optimization_fail_compaction()")
            }
            val pool=Executors.newFixedThreadPool(2)
            try {
                val a=pool.submit<Long> { cleaner.compact() };val b=pool.submit<Long> { cleaner.compact() }
                val counts=listOf(a.get(),b.get());assertEquals(501L,counts.sum());assertTrue(counts.all { it<=500 })
            } finally { pool.shutdownNow() }
            assertEquals(0L,cleaner.compact())
            assertEquals(502.0,meters.get("qanda.sync.payload.compacted").counter().count())
            assertEquals(1.0,meters.get("qanda.sync.payload.failures").counter().count())
            jdbc.update("""INSERT INTO sync_command(id,session_id,user_id,actor_session_id,writer_token,client_sequence,payload_digest,digest_key_version,request_id,kind,payload_json,state,completed_at)
                SELECT gen_random_uuid(),session_id,user_id,actor_session_id,writer_token,10000+n,payload_digest,digest_key_version,request_id,kind,payload_json,states.value,
                  CASE WHEN states.value='REJECTED' THEN CAST(? AS timestamptz) END
                FROM sync_command CROSS JOIN (VALUES (1,'QUEUED'),(2,'RETRYING'),(3,'REJECTED'),(4,'DEAD_LETTER')) states(n,value) WHERE id=?""",Timestamp.from(cutoff.minusSeconds(1)),secondKey)
            jdbc.update("UPDATE sync_command SET completed_at=? WHERE id=?",Timestamp.from(cutoff.minusSeconds(1)),secondKey)
            jdbc.dataSource!!.connection.use { locked ->
                locked.autoCommit=false
                try {
                    locked.prepareStatement("SELECT id FROM sync_command WHERE id=? FOR UPDATE").use { query -> query.setObject(1,secondKey);query.executeQuery().close() }
                    assertEquals(0L,cleaner.compact())
                } finally { locked.rollback() }
            }
            assertEquals(1L,cleaner.compact())
            assertEquals(4,jdbc.queryForObject("SELECT count(*) FROM sync_command WHERE session_id=? AND client_sequence>=10000 AND payload_json IS NOT NULL",Int::class.java,sid))
        } finally {
            jdbc.update("DELETE FROM sync_command WHERE session_id=? AND client_sequence>=10000",sid)
            consumers.start()
        }
    }

    private fun <T> baseline(statement: String,params: Map<String,Any?>): T = factory.openSession().use { it.selectOne("baseline.learning.$statement",params) }

    private fun plan(statement: String,params: Map<String,Any?>): JsonNode {
        val mapped=factory.configuration.getMappedStatement(statement);val bound=mapped.getBoundSql(params)
        return jdbc.dataSource!!.connection.use { connection ->
            connection.prepareStatement("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+bound.sql).use { query ->
                DefaultParameterHandler(mapped,params,bound).setParameters(query)
                query.executeQuery().use { rows -> rows.next();json.readTree(rows.getString(1)) }
            }
        }
    }

    @Test fun `real time statistics match original queries across growing histories`() {
        val setup=org.springframework.jdbc.core.JdbcTemplate(jdbc.dataSource!!).apply { queryTimeout=60 }
        val f=fixture();val learner=student();val seed=createPractice(learner,f);val sid=id(seed)
        val since=Instant.now().minus(Duration.ofDays(7));val all=StatsFilter(Instant.parse("1900-01-01T00:00:00Z"),Instant.parse("2201-01-01T00:00:00Z"),learner.id)
        for(size in listOf(1000,10000,100000)) {
            val existing=jdbc.queryForObject("SELECT count(*) FROM practice_item i JOIN practice_session s ON s.id=i.session_id WHERE s.user_id=? AND s.status='SUBMITTED'",Int::class.java,learner.id)!!
            setup.update("""WITH sessions AS (
                INSERT INTO practice_session(id,user_id,bank_id,selection_kind,question_order,feedback,status,configuration_snapshot,submitted_at,auto_add_wrong_book)
                SELECT gen_random_uuid(),user_id,bank_id,selection_kind,question_order,feedback,'SUBMITTED',configuration_snapshot,now()-interval '1 hour'-((n%10)*interval '1 day'),n%3<>0
                FROM practice_session CROSS JOIN generate_series(1,?) n WHERE id=? RETURNING id
            ) INSERT INTO practice_item(id,session_id,question_id,revision_id,material_revision_id,position,confirmed,outcome,self_assessment)
              SELECT gen_random_uuid(),s.id,i.question_id,i.revision_id,i.material_revision_id,i.position,true,
                CASE WHEN r.type='SHORT_ANSWER' THEN 'SELF_RATED' WHEN i.position%2=0 THEN 'WRONG' ELSE 'CORRECT' END,
                CASE WHEN r.type='SHORT_ANSWER' THEN CASE WHEN s.id> ? THEN 'CORRECT' ELSE 'WRONG' END END
              FROM sessions s CROSS JOIN practice_item i JOIN question_revision r ON r.id=i.revision_id WHERE i.session_id=?""",(size-existing)/4,sid,UUID.fromString("80000000-0000-0000-0000-000000000000"),sid)
            setup.update("""INSERT INTO practice_result(id,session_id,total_count,objective_count,answered_count,correct_count,wrong_count,unanswered_count,short_answer_count,duration_seconds)
                SELECT gen_random_uuid(),s.id,count(*),count(*) FILTER(WHERE i.outcome<>'SELF_RATED'),count(*),count(*) FILTER(WHERE i.outcome='CORRECT'),count(*) FILTER(WHERE i.outcome='WRONG'),0,count(*) FILTER(WHERE i.outcome='SELF_RATED'),10
                FROM practice_session s JOIN practice_item i ON i.session_id=s.id WHERE s.user_id=? AND s.status='SUBMITTED' AND NOT EXISTS(SELECT 1 FROM practice_result r WHERE r.session_id=s.id) GROUP BY s.id""",learner.id)
            setup.update("INSERT INTO user_favorite(user_id,question_id) SELECT ?,id FROM question WHERE bank_id=? ON CONFLICT DO NOTHING",learner.id,f.bank)
            setup.execute("ANALYZE practice_session");jdbc.execute("ANALYZE practice_item");jdbc.execute("ANALYZE practice_result")
            val params=mapOf<String,Any?>("userId" to learner.id)
            val old: OverviewRow=baseline("LearningReadMapper.overview",params)
            assertEquals(json.valueToTree<JsonNode>(old),json.valueToTree<JsonNode>(reads.overview(learner.id)))
            val statsParams=mapOf<String,Any?>("f" to all)
            val oldStats: StatsRow=baseline("LearningMapper.stats",statsParams);val current=learningMapper.stats(all)
            val oldSelf: Map<String,Number> = baseline("LearningMapper.selfStats",statsParams)
            oldStats.distinctCount=baseline("LearningMapper.distinctCount",statsParams)
            oldStats.selfRatedCount=oldSelf.getValue("rated").toLong();oldStats.selfCorrectCount=oldSelf.getValue("correct").toLong();oldStats.selfWrongCount=oldSelf.getValue("wrong").toLong()
            assertEquals(json.valueToTree<JsonNode>(oldStats),json.valueToTree<JsonNode>(current))
            for(kind in listOf("WRONG","FAVORITE")) {
                val filter=CollectionFilter(kind,since=since)
                val p=params+mapOf("f" to filter)
                val totals: CollectionSummaryRow=baseline("LearningReadMapper.collectionTotals",p)
                val facets: List<CollectionFacet> = factory.openSession().use { it.selectList("baseline.learning.LearningReadMapper.collectionFacets",p) }
                val result=learningReads.summary(learner.id,kind)
                assertEquals(totals.total,result.total);assertEquals(totals.repeatCount,result.repeatCount)
                assertEquals(totals.recentCount,result.recentCount);assertEquals(totals.practicedCount,result.practicedCount)
                assertEquals(totals.total-totals.practicedCount,result.pendingCount)
                assertEquals(totals.rightCount,result.rightCount);assertEquals(totals.wrongCount,result.wrongCount)
                assertEquals(json.valueToTree<JsonNode>(facets),json.valueToTree<JsonNode>(result.facets))
                if(kind=="WRONG") {
                    val subjective=p+mapOf("f" to filter.copy(chip="subjective"))
                    assertEquals(baseline<Long>("LearningReadMapper.collectionCount",subjective),result.subjectiveCount)
                    val subjectiveFacets: List<CollectionFacet> = factory.openSession().use { it.selectList("baseline.learning.LearningReadMapper.collectionFacets",subjective) }
                    assertEquals(json.valueToTree<JsonNode>(subjectiveFacets),json.valueToTree<JsonNode>(result.subjectiveFacets))
                }
            }
            val pending=params+mapOf("ids" to listOf(f.questions.first()))
            val oldFacts: List<PendingQuestionFact> = factory.openSession().use { it.selectList("baseline.learning.LearningReadMapper.pendingFacts",pending) }
            assertEquals(json.valueToTree<JsonNode>(oldFacts),json.valueToTree<JsonNode>(reads.pendingFacts(learner.id,listOf(f.questions.first()))))
            val plans=mapOf(
                "overviewBefore" to plan("baseline.learning.LearningReadMapper.overview",params),
                "overviewAfter" to plan("qanda.backend.learning.LearningReadMapper.overview",params),
                "statisticsBeforeResults" to plan("baseline.learning.LearningMapper.stats",statsParams),
                "statisticsBeforeSelf" to plan("baseline.learning.LearningMapper.selfStats",statsParams),
                "statisticsBeforeDistinct" to plan("baseline.learning.LearningMapper.distinctCount",statsParams),
                "statisticsAfter" to plan("qanda.backend.learning.LearningMapper.stats",statsParams))
            val output=Path.of(".backend-runtime/sync-query-optimization");Files.createDirectories(output)
            Files.writeString(output.resolve("statistics-$size.json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(mapOf("answers" to size,"plans" to plans,"overview" to old,"statistics" to current)))
            println("STATISTICS_QUERY_EVIDENCE answers=$size "+plans.entries.joinToString(" ") { "${it.key}Ms=${it.value[0]["Execution Time"]}" })
        }
        jdbc.update("UPDATE question SET status='INACTIVE' WHERE id=?",f.questions.first())
        assertEquals(json.valueToTree<JsonNode>(baseline<OverviewRow>("LearningReadMapper.overview",mapOf("userId" to learner.id))),json.valueToTree<JsonNode>(reads.overview(learner.id)))
    }
}
