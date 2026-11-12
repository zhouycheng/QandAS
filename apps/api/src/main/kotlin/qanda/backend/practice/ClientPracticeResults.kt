package qanda.backend.practice

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.stereotype.Service
import qanda.backend.platform.http.invalid
import java.time.Clock
import java.util.UUID

@Service
class ClientPracticeResults(private val sql: PracticeQueries,private val json: ObjectMapper,private val clock: Clock) {
    fun apply(items: List<PracticeItem>,input: ProgressInput,feedback: String,shapes: Map<UUID?,PracticeShape>) {
        if(input.items.size>items.size || input.items.map { it.itemId }.distinct().size!=input.items.size) invalid("/clientResult")
        if(input.kind=="FINISH" && input.items.size!=items.size) invalid("/items","FINAL_ANSWERS_REQUIRED","请上传完整的本地练习结果")
        val byId=items.associateBy { it.id }
        val confirmedChoices=items.filter { feedback=="IMMEDIATE" && it.confirmed && shapes.getValue(it.id).type in setOf("SINGLE_CHOICE","MULTIPLE_CHOICE") }.map { it.id!! }
        val previousChoices=if(confirmedChoices.isEmpty()) emptyMap() else sql.batchChoices(confirmedChoices).groupBy { it.itemId }
        val changed=mutableListOf<PracticeItem>()
        val choices=mutableListOf<PracticeChoiceRow>()
        input.items.forEach { change ->
            val item=byId[change.itemId] ?: invalid("/items/itemId")
            if(change.revisionId!=item.revisionId || change.materialRevisionId!=item.materialRevisionId) invalid("/items/revisionId","REVISION_MISMATCH","题目与答案版本不一致，请重新读取本次练习")
            val shape=shapes.getValue(item.id)
            AnswerValidation.validate(shape.type,json.readValue(shape.optionKeys,Array<String>::class.java).toList(),shape.blankCount,change.answer)
            val previous=when {
                item.answerText!=null -> AnswerInput(text=item.answerText)
                item.answerBoolean!=null -> AnswerInput(value=item.answerBoolean)
                item.answerBlanks!=null -> AnswerInput(blanks=json.readValue(item.answerBlanks,Array<String>::class.java).toList())
                previousChoices[item.id].orEmpty().isNotEmpty() -> AnswerInput(optionKeys=previousChoices[item.id].orEmpty().map { it.optionKey }.sorted())
                else -> null
            }
            if(feedback=="IMMEDIATE" && shape.type!="SHORT_ANSWER" && item.confirmed && (change.answer?.let { it.copy(optionKeys=it.optionKeys?.sorted()) }!=previous || !change.confirmed))
                qanda.backend.platform.http.conflict("ANSWER_CONFIRMED","已确认的答案不能修改")
            val answered=AnswerValidation.hasInput(change.answer)
            if(change.confirmed && !answered) invalid("/items/confirmed")
            val outcome=change.outcome
            if(outcome !in setOf(null,"CORRECT","WRONG","UNANSWERED","SELF_RATED")) invalid("/items/outcome")
            if(input.kind=="FINISH" && (change.confirmed!=answered || outcome==null || (outcome=="UNANSWERED")!=!answered)) invalid("/items/outcome")
            if(change.confirmed && outcome==null) invalid("/items/outcome")
            if(outcome in setOf("CORRECT","WRONG","SELF_RATED") && (!answered || !change.confirmed)) invalid("/items/outcome")
            if(outcome!=null && outcome!="UNANSWERED" && (outcome=="SELF_RATED")!=(shape.type=="SHORT_ANSWER")) invalid("/items/outcome")
            if(change.selfAssessment!=null && (outcome!="SELF_RATED" || change.selfAssessment !in setOf("CORRECT","WRONG"))) invalid("/items/selfAssessment")
            item.answerText=change.answer?.text;item.answerBoolean=change.answer?.value;item.answerBlanks=change.answer?.blanks?.let { json.writeValueAsString(it) }
            item.confirmed=change.confirmed;item.marked=change.marked;item.outcome=outcome;item.selfAssessment=change.selfAssessment
            changed.add(item)
            change.answer?.optionKeys.orEmpty().sorted().forEach { key -> choices.add(PracticeChoiceRow().apply { itemId=item.id;revisionId=item.revisionId;optionKey=key }) }
        }
        if(changed.isNotEmpty()) {
            sql.updateAnswers(changed);sql.clearBatchChoices(changed.map { it.id!! })
            choices.chunked(20000).forEach { sql.insertChoices(it) }
        }
    }
    fun result(id: UUID,items: List<PracticeItem>,input: ProgressInput,shapes: Map<UUID?,PracticeShape>): PracticeResult {
        val value=input.clientResult ?: invalid("/clientResult")
        val objective=items.filter { shapes.getValue(it.id).type!="SHORT_ANSWER" }
        val short=items-objective.toSet()
        val metrics=objectiveMetrics(objective.size,objective.count { it.outcome=="CORRECT" },objective.count { it.outcome=="WRONG" })
        val self=SelfMetrics(short.size,short.count { it.outcome=="SELF_RATED" },short.count { it.selfAssessment!=null },short.count { it.selfAssessment=="CORRECT" },short.count { it.selfAssessment=="WRONG" },short.count { it.selfAssessment==null })
        if(value.totalCount!=items.size || value.answeredCount!=items.count { it.outcome!="UNANSWERED" } || value.objective!=metrics || value.shortAnswer!=self) invalid("/clientResult","RESULT_STRUCTURE_MISMATCH","练习结果不完整，请保留本机记录后重试")
        // Check arithmetic consistency only; accepted client judgments are never compared with an answer key.
        return PracticeResult().apply {
            this.id=UUID.randomUUID();sessionId=id;resultSource="CLIENT"
            totalCount=value.totalCount;answeredCount=value.answeredCount;objectiveCount=metrics.count;correctCount=metrics.correct;wrongCount=metrics.wrong;unansweredCount=metrics.unanswered
            shortAnswerCount=self.count;durationSeconds=input.durationSeconds;createdAt=clock.instant()
        }
    }
}
