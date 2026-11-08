package qanda.backend.practice

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.content.QuestionView
import qanda.backend.content.api.ContentLibrary
import qanda.backend.content.api.BankReference
import qanda.backend.content.api.RevisionReference
import qanda.backend.platform.http.*
import qanda.backend.platform.security.TransactionLocks
import qanda.backend.platform.security.Actor
import qanda.backend.platform.events.ActivityEvents
import qanda.backend.sync.api.WriteOwnership
import qanda.backend.sync.api.WriteState
import java.time.Clock
import java.time.Duration
import java.util.UUID

@Service
@Transactional
class PracticeService(private val rows: PracticeSessionMapper,private val results: PracticeResultMapper,
                      private val content: ContentLibrary,
                      private val sql: PracticeQueries,private val system: TransactionLocks,private val clock: Clock,private val json: ObjectMapper,
                      private val ownership: WriteOwnership,private val activity: ActivityEvents) {
    private fun validateScope(actor: Actor?,scope: ScopeInput): List<BankReference> {
        if(scope.count !in 1..1000 || scope.order !in setOf("SEQUENTIAL","RANDOM") || scope.selectionKind !in setOf("NORMAL","WRONG","FAVORITE")) invalid("/scope")
        if(actor==null && scope.selectionKind!="NORMAL") forbidden()
        val chips=when(scope.selectionKind) { "WRONG" -> setOf("all","repeat","recent","subjective");"FAVORITE" -> setOf("all","pending","practiced");else -> setOf("all") }
        if(scope.collectionChip !in chips) invalid("/scope/collectionChip")
        val ids=scope.questionBankIds.ifEmpty { listOf(scope.questionBankId) }
        if(ids.size>100 || ids.distinct().size!=ids.size || scope.questionBankId !in ids) invalid("/scope/questionBankIds")
        val banks=ids.map { content.bank(actor,it) }
        if(banks.map { it.subjectId }.distinct().size!=1) invalid("/scope/questionBankIds","QUESTION_SCOPE_MISMATCH","请选择同一科目下的题库")
        if(scope.chapterIds.size>100 || scope.chapterIds.distinct().size!=scope.chapterIds.size) invalid("/scope/chapterIds")
        scope.chapterIds.forEach { if(banks.none { bank -> content.chapterBelongs(it,bank.id) }) invalid("/scope/chapterIds") }
        if(scope.questionIds.size>1000 || scope.questionIds.distinct().size!=scope.questionIds.size) invalid("/scope/questionIds")
        if(scope.questionIds.isNotEmpty() && sql.eligibleCount(actor?.id,scope)!=scope.questionIds.size.toLong()) invalid("/scope/questionIds","QUESTION_SCOPE_MISMATCH","所选题目不属于当前可练习范围")
        if(scope.selectionKind=="NORMAL" && scope.questionIds.isNotEmpty()) {
            val parents=content.questions(scope.questionIds).mapNotNull { it.readingParentId }.distinct()
            if(content.readingChildrenFor(parents).any { it.status=="ACTIVE" && it.id !in scope.questionIds }) invalid("/scope/questionIds","READING_GROUP_INCOMPLETE","普通练习请按完整阅读题组选择")
        }
        return banks
    }
    fun preview(actor: Actor?,scope: ScopeInput): ScopeView {
        val banks=validateScope(actor,scope);val selected=sql.eligible(actor?.id,scope)
        return ScopeView(sql.eligibleCount(actor?.id,scope),banks.first { it.id==scope.questionBankId }.contentVersion,selected.size,selected.map { it.id!! },banks.associate { it.id to it.contentVersion })
    }
    private fun lockScope(actor: Actor?,scope: ScopeInput,expected: Long,versions: Map<UUID,Long>): List<BankReference> {
        val banks=validateScope(actor,scope)
        if((banks.size>1 || versions.isNotEmpty()) && versions.keys!=banks.map { it.id }.toSet()) invalid("/expectedContentVersions")
        val locked=banks.sortedBy { it.id }.map { content.lockBank(it.id) }
        locked.forEach { bank ->
            content.bank(actor,bank.id)
            requireVersion(versions[bank.id] ?: expected,bank.contentVersion)
        }
        validateScope(actor,scope)
        return locked
    }
    private fun grading(id: UUID,q: QuestionView)=OfflineGrading(id,q.correctAnswer,q.correctValue,q.referenceAnswer,q.explanation,q.blanks,q.blankMatch,q.scoringPoints)
    private fun display(q: QuestionView)=q.copy(correctAnswer=null,correctValue=null,referenceAnswer=null,explanation=null,blanks=null,blankMatch=null,scoringPoints=null)
    private fun validateConfiguration(mode: String?,timeLimitSeconds: Int?) {
        if(mode!=null && mode !in setOf("order","practice","test","view")) invalid("/mode")
        if(timeLimitSeconds!=null && (timeLimitSeconds !in 1..86400 || mode=="view")) invalid("/timeLimitSeconds")
    }
    fun trialSnapshot(input: TrialSnapshotInput): TrialSnapshotView {
        validateConfiguration(input.mode,input.timeLimitSeconds)
        val banks=lockScope(null,input.scope,input.expectedContentVersion,input.expectedContentVersions)
        val bank=banks.first { it.id==input.scope.questionBankId }
        if(input.feedback !in setOf("IMMEDIATE","AFTER_FINISH")) invalid("/feedback")
        val selected=sql.eligible(null,input.scope)
        if(selected.isEmpty()) invalid("/scope/count","INSUFFICIENT_QUESTIONS","请增加题量以容纳完整题组")
        val grading=mutableListOf<OfflineGrading>()
        val full=content.revisions(selected.map { RevisionReference(it.id!!,it.currentRevisionId) },true)
        val items=selected.mapIndexed { position,q ->
            val id=UUID.randomUUID();val answer=full[position]
            grading.add(grading(id,answer))
            PracticeItemView(id,position,if(input.mode=="view") answer else display(answer),null,false,false,null,null)
        }
        return TrialSnapshotView(UUID.randomUUID(),bank.id!!,input.feedback,
            PracticeConfiguration(input.scope.chapterIds,items.size,input.scope.order,"NORMAL",input.feedback,bank.contentVersion,selected.map { it.id!! },mode=input.mode,timeLimitSeconds=input.timeLimitSeconds,questionBankIds=banks.map { it.id },contentVersions=banks.associate { it.id to it.contentVersion }),items,grading,clock.instant())
    }
    fun create(actor: Actor,input: CreatePracticeInput): PracticeView {
        validateConfiguration(input.mode,input.timeLimitSeconds)
        system.lock("practice:${actor.id}:${input.scope.questionBankId}")
        // Lock every selected bank in stable order before pinning question revisions.
        val banks=lockScope(actor,input.scope,input.expectedContentVersion,input.expectedContentVersions)
        val bank=banks.first { it.id==input.scope.questionBankId }
        if(input.feedback !in setOf("IMMEDIATE","AFTER_FINISH")) invalid("/feedback")
        val chosen=sql.eligible(actor.id,input.scope)
        if(chosen.isEmpty()) invalid("/scope/count","INSUFFICIENT_QUESTIONS","请增加题量以容纳完整题组")
        val session=PracticeSession().apply { id=UUID.randomUUID();userId=actor.id;bankId=bank.id;selectionKind=input.scope.selectionKind;questionOrder=input.scope.order;feedback=input.feedback;createdAt=clock.instant();updatedAt=createdAt }
        session.configurationSnapshot=json.writeValueAsString(PracticeConfiguration(input.scope.chapterIds,chosen.size,input.scope.order,input.scope.selectionKind,input.feedback,bank.contentVersion,chosen.map { it.id!! },input.scope.collectionChip,input.mode,input.timeLimitSeconds,banks.map { it.id },banks.associate { it.id to it.contentVersion }))
        session.writerDeviceId=input.deviceId;session.writerToken=UUID.randomUUID()
        rows.insert(session)
        ownership.create(session.id!!,writeState(session))
        val pinned=content.revisions(chosen.map { RevisionReference(it.id!!,it.currentRevisionId) },true)
        val issued=chosen.mapIndexed { i,q -> PracticeItem().apply { id=UUID.randomUUID();sessionId=session.id;questionId=q.id;revisionId=q.currentRevisionId;materialRevisionId=pinned[i].material?.revisionId;position=i } }
        sql.insertItems(issued)
        activity.record(actor.id)
        return view(session,input.deviceId,true,issued,pinned)
    }
    private fun owned(userId: UUID,id: UUID,lock: Boolean=false): PracticeSession {
        val row=(if(lock) sql.lockSession(id) else rows.selectById(id)) ?: missing();if(row.userId!=userId) missing()
        val state=ownership.read(id)
        row.writerDeviceId=state.deviceId;row.writerToken=state.token;row.acknowledgedSequence=state.acknowledgedSequence
        return row
    }
    private fun writeState(row: PracticeSession)=WriteState(row.writerDeviceId,row.writerToken,row.acknowledgedSequence)
    fun admitProgress(actor: Actor,id: UUID,input: ProgressInput) {
        val row=owned(actor.id,id,true);writer(row,input.writerToken);requireVersion(input.expectedVersion,row.version)
        if(row.status!="IN_PROGRESS") conflict("SESSION_CLOSED","练习已结束")
        if(input.clientSequence<=row.acknowledgedSequence) invalid("/clientSequence")
        if(input.items.size>1000 || input.items.map { it.itemId }.distinct().size!=input.items.size) invalid("/items")
        ownership.requireDrained(id)
    }
    private fun answer(item: PracticeItem,choices: List<String>): AnswerInput? {
        return when { choices.isNotEmpty() -> AnswerInput(optionKeys=choices);item.answerBoolean!=null -> AnswerInput(value=item.answerBoolean);item.answerText!=null -> AnswerInput(text=item.answerText);item.answerBlanks!=null -> AnswerInput(blanks=json.readValue(item.answerBlanks,Array<String>::class.java).toList());else -> null }
    }
    private fun views(session: PracticeSession,items: List<PracticeItem> = sql.items(session.id!!),
                      full: List<QuestionView> = content.revisions(items.map { RevisionReference(it.questionId!!,it.revisionId,it.materialRevisionId) },true)): List<PracticeItemView> {
        val configuration=json.readValue(session.configurationSnapshot,PracticeConfiguration::class.java)
        val choices=if(items.isEmpty()) emptyMap() else sql.batchChoices(items.map { it.id!! }).groupBy { it.itemId }
        return items.zip(full).map { (item,revision) ->
            val reveal=session.status=="SUBMITTED" || configuration.mode=="view" || session.feedback=="IMMEDIATE" && item.confirmed && revision.type!="SHORT_ANSWER"
            PracticeItemView(item.id!!,item.position,if(reveal) revision else display(revision),answer(item,choices[item.id].orEmpty().map { it.optionKey }),item.confirmed,item.marked,item.outcome.takeIf { reveal },item.selfAssessment.takeIf { reveal })
        }
    }
    private fun writerView(row: PracticeSession,deviceId: UUID?): WriterView = WriterView(
        row.writerDeviceId,row.writerToken.takeIf { deviceId!=null && row.writerDeviceId==deviceId },row.version,row.acknowledgedSequence)
    private fun view(row: PracticeSession,deviceId: UUID?=null,offline: Boolean=false,issued: List<PracticeItem> = sql.items(row.id!!),
                     full: List<QuestionView> = content.revisions(issued.map { RevisionReference(it.questionId!!,it.revisionId,it.materialRevisionId) },true)): PracticeView {
        val grading=if(offline) issued.zip(full).map { (item,q) -> grading(item.id!!,q) } else null
        val items=views(row,issued,full)
        return PracticeView(row.id!!,row.bankId!!,row.status,row.version,row.currentIndex,row.durationSeconds,row.feedback,items,row.createdAt,
            json.readValue(row.configurationSnapshot,PracticeConfiguration::class.java),grading,writerView(row,deviceId),content.favorites(row.userId!!,items.map { it.question.id }))
    }
    fun read(userId: UUID,id: UUID): PracticeView = view(owned(userId,id))
    private fun writer(row: PracticeSession,token: UUID) {
        if(row.writerToken!=token) conflict("WRITER_REVOKED","请在创建练习的设备继续作答")
    }
    fun snapshot(actor: Actor,id: UUID,deviceId: UUID,token: UUID): PracticeView {
        val row=owned(actor.id,id);writer(row,token)
        if(row.writerDeviceId!=deviceId) conflict("WRITER_REQUIRED","请在创建练习的设备继续作答")
        return view(row,deviceId,true)
    }
    private fun saveProgress(actor: Actor,id: UUID,input: ProgressInput): PracticeSession {
        val row=owned(actor.id,id,true);writer(row,input.writerToken);requireVersion(input.expectedVersion,row.version)
        if(row.status!="IN_PROGRESS") conflict("SESSION_CLOSED","练习已结束")
        if(input.clientSequence<=row.acknowledgedSequence) invalid("/clientSequence")
        val items=sql.items(id)
        if(input.currentIndex !in items.indices) invalid("/currentIndex")
        duration(row,input.durationSeconds)
        applyAnswers(row,items,input.items)
        row.currentIndex=input.currentIndex;row.durationSeconds=input.durationSeconds;row.version++;row.updatedAt=clock.instant()
        row.acknowledgedSequence=input.clientSequence
        rows.updateById(row);ownership.save(id,writeState(row));activity.record(actor.id)
        return row
    }
    fun progressAck(actor: Actor,id: UUID,input: ProgressInput): ProgressAck {
        val row=saveProgress(actor,id,input)
        return ProgressAck(id,row.version,row.acknowledgedSequence,writerView(row,row.writerDeviceId))
    }
    private fun duration(row: PracticeSession,value: Int) {
        if(value<row.durationSeconds || value.toLong()>Duration.between(row.createdAt,clock.instant()).seconds.coerceAtLeast(0)+5) invalid("/durationSeconds")
    }
    private fun applyAnswers(row: PracticeSession,items: List<PracticeItem>,changes: List<ItemProgress>) {
        if(changes.size>items.size || changes.map { it.itemId }.distinct().size!=changes.size) invalid("/items")
        val byId=items.associateBy { it.id }
        val full=content.revisions(changes.map { change -> val item=byId[change.itemId] ?: invalid("/items/itemId");RevisionReference(item.questionId!!,item.revisionId,item.materialRevisionId) },true).associateBy { it.id }
        val choices=if(changes.isEmpty()) emptyMap() else sql.batchChoices(changes.map { it.itemId }).groupBy { it.itemId }
        changes.forEach { change ->
            val item=byId[change.itemId] ?: invalid("/items/itemId")
            val normalized=change.answer?.let { it.copy(optionKeys=it.optionKeys?.sorted()) }
            val question=full.getValue(item.questionId!!)
            Grading.validate(question,normalized)
            val previous=answer(item,choices[item.id].orEmpty().map { it.optionKey })
            if(row.feedback=="IMMEDIATE" && question.type!="SHORT_ANSWER" && item.confirmed && (normalized!=previous || !change.confirmed)) conflict("ANSWER_CONFIRMED","已确认的答案不能修改")
            if(change.confirmed && !Grading.hasInput(normalized)) invalid("/items/confirmed")
            if(normalized==previous && change.confirmed==item.confirmed && change.marked==item.marked) return@forEach
            item.answerText=normalized?.text;item.answerBoolean=normalized?.value;item.answerBlanks=normalized?.blanks?.let { json.writeValueAsString(it) };item.confirmed=change.confirmed;item.marked=change.marked
            item.outcome=if(row.feedback=="IMMEDIATE" && question.type!="SHORT_ANSWER" && change.confirmed) Grading.outcome(question,normalized) else null
            sql.clearChoices(item.id!!);normalized?.optionKeys?.forEach { sql.addChoice(item.id!!,item.revisionId!!,it) };sql.updateAnswer(item)
        }
    }
    fun finish(actor: Actor,id: UUID,input: FinishInput): ResultView {
        val row=owned(actor.id,id,true)
        if(row.status=="SUBMITTED") return result(actor.id,id)
        if(json.readValue(row.configurationSnapshot,PracticeConfiguration::class.java).mode=="view") conflict("STUDY_NOT_SCORED","背题通过结束浏览完成")
        ownership.requireDrained(id)
        writer(row,input.writerToken);requireVersion(input.expectedVersion,row.version);if(row.status!="IN_PROGRESS") conflict("SESSION_CLOSED","练习已结束")
        duration(row,input.durationSeconds);val items=sql.items(id);applyAnswers(row,items,input.items)
        val finalItems=sql.items(id)
        val full=content.revisions(finalItems.map { RevisionReference(it.questionId!!,it.revisionId,it.materialRevisionId) },true).associateBy { it.id }
        val choices=sql.batchChoices(finalItems.map { it.id!! }).groupBy { it.itemId }
        finalItems.forEach { item ->
            val question=full.getValue(item.questionId!!)
            val submitted=answer(item,choices[item.id].orEmpty().map { it.optionKey })?.takeIf { Grading.hasInput(it) }
            item.confirmed=submitted!=null
            item.outcome=Grading.outcome(question,submitted);sql.updateAnswer(item)
        }
        val short=finalItems.filter { full.getValue(it.questionId!!).type=="SHORT_ANSWER" }
        val objective=finalItems-short.toSet()
        val result=PracticeResult().apply { this.id=UUID.randomUUID();sessionId=id;totalCount=finalItems.size;objectiveCount=objective.size;shortAnswerCount=short.size
            correctCount=objective.count { it.outcome=="CORRECT" };wrongCount=objective.count { it.outcome=="WRONG" };unansweredCount=objectiveCount-correctCount-wrongCount
            answeredCount=finalItems.count { it.outcome!="UNANSWERED" };durationSeconds=input.durationSeconds;createdAt=clock.instant() }
        results.insert(result);row.status="SUBMITTED";row.submittedAt=clock.instant();row.updatedAt=row.submittedAt!!;row.durationSeconds=input.durationSeconds;row.autoAddWrongBook=input.autoAddWrongBook;row.version++;rows.updateById(row)
        activity.record(actor.id);return result(actor.id,id)
    }
    fun result(userId: UUID,id: UUID): ResultView {
        val session=owned(userId,id);if(session.status!="SUBMITTED") conflict("RESULT_NOT_READY","练习尚未交卷")
        val result=sql.result(id) ?: missing();val items=views(session);val short=items.filter { it.question.type=="SHORT_ANSWER" }
        val rated=short.count { it.selfAssessment!=null };val answered=short.count { it.outcome=="SELF_RATED" };
        return ResultView(result.id!!,id,session.version,result.totalCount,result.answeredCount,result.durationSeconds,
            objectiveMetrics(result.objectiveCount,result.correctCount,result.wrongCount),
            SelfMetrics(short.size,answered,rated,short.count { it.selfAssessment=="CORRECT" },short.count { it.selfAssessment=="WRONG" },short.size-rated),items,session.submittedAt!!)
    }
    fun assess(actor: Actor,id: UUID,itemId: UUID,input: SelfAssessmentInput): ResultView {
        val row=owned(actor.id,id,true);requireVersion(input.expectedVersion,row.version)
        if(row.status!="SUBMITTED" || input.assessment !in setOf("CORRECT","WRONG")) invalid("/assessment")
        val item=sql.items(id).firstOrNull { it.id==itemId } ?: missing()
        if(item.outcome!="SELF_RATED") invalid("/assessment","SELF_ASSESSMENT_UNAVAILABLE","只有已作答的简答题可以自评")
        item.selfAssessment=input.assessment;sql.updateAnswer(item);row.version++;row.updatedAt=clock.instant();rows.updateById(row);return result(actor.id,id)
    }
    fun cancel(actor: Actor,id: UUID,input: ExpectedVersionInput): MutationResult {
        val row=owned(actor.id,id,true);writer(row,input.writerToken);requireVersion(input.expectedVersion,row.version);if(row.status!="IN_PROGRESS") conflict("SESSION_CLOSED","练习已结束")
        ownership.requireDrained(id)
        row.status="CANCELLED";row.version++;row.updatedAt=clock.instant();rows.updateById(row);return MutationResult(id,row.version)
    }
    fun history(userId: UUID,p: PageSpec,deviceId: UUID?): Page<PracticeSummary> = Page(sql.history(userId,deviceId,p.offset,p.pageSize).map { PracticeSummary(it.id!!,it.bankId!!,it.status,it.version,it.durationSeconds,it.createdAt,it.submittedAt,it.writerDeviceId) },sql.historyCount(userId,deviceId),p.page,p.pageSize)
}
