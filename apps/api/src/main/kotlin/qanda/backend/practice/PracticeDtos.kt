package qanda.backend.practice

import qanda.backend.content.QuestionView
import io.swagger.v3.oas.annotations.media.Schema
import java.time.Instant
import java.util.UUID

data class ScopeInput(val questionBankId: UUID,val chapterIds: List<UUID> = emptyList(),@field:Schema(minimum="1",maximum="1000") val count: Int=20,@field:Schema(allowableValues=["SEQUENTIAL","RANDOM"]) val order: String="SEQUENTIAL",@field:Schema(allowableValues=["NORMAL","WRONG","FAVORITE"]) val selectionKind: String="NORMAL",val questionIds: List<UUID> = emptyList(),@field:Schema(allowableValues=["all","repeat","recent","subjective","pending","practiced"]) val collectionChip: String="all")
data class ScopeView(val availableCount: Long,val contentVersion: Long,val selectedCount: Int,val selectedQuestionIds: List<UUID>)
data class CreatePracticeInput(val scope: ScopeInput,val expectedContentVersion: Long,val deviceId: UUID,@field:Schema(allowableValues=["AFTER_FINISH","IMMEDIATE"]) val feedback: String="AFTER_FINISH",@field:Schema(allowableValues=["order","practice","test","view"]) val mode: String?=null,@field:Schema(minimum="1",maximum="86400") val timeLimitSeconds: Int?=null)
data class TrialSnapshotInput(val scope: ScopeInput,val expectedContentVersion: Long,@field:Schema(allowableValues=["AFTER_FINISH","IMMEDIATE"]) val feedback: String="IMMEDIATE",@field:Schema(allowableValues=["order","practice","test","view"]) val mode: String?=null,@field:Schema(minimum="1",maximum="86400") val timeLimitSeconds: Int?=null)
data class TrialSnapshotView(val id: UUID,val questionBankId: UUID,val feedback: String,val configuration: PracticeConfiguration,val items: List<PracticeItemView>,val offlineGrading: List<OfflineGrading>,val createdAt: Instant)
data class AnswerInput(val optionKeys: List<String>?=null,val value: Boolean?=null,val text: String?=null,val blanks: List<String>?=null)
data class ItemProgress(val itemId: UUID,val answer: AnswerInput?=null,val confirmed: Boolean=false,val marked: Boolean=false)
data class ProgressInput(val expectedVersion: Long,val currentIndex: Int,val durationSeconds: Int,val writerToken: UUID,val clientSequence: Long,val items: List<ItemProgress> = emptyList())
data class FinishInput(val expectedVersion: Long,val durationSeconds: Int,val writerToken: UUID,val items: List<ItemProgress> = emptyList())
data class ExpectedVersionInput(val expectedVersion: Long,val writerToken: UUID)
data class SelfAssessmentInput(val expectedVersion: Long,@field:Schema(allowableValues=["CORRECT","WRONG"]) val assessment: String)
data class PracticeItemView(val itemId: UUID,val position: Int,val question: QuestionView,val answer: AnswerInput?,val confirmed: Boolean,val marked: Boolean,val outcome: String?,val selfAssessment: String?)
data class PracticeView(val id: UUID,val questionBankId: UUID,val status: String,val version: Long,val currentIndex: Int,val durationSeconds: Int,val feedback: String,val items: List<PracticeItemView>,val createdAt: Instant,val configuration: PracticeConfiguration,val offlineGrading: List<OfflineGrading>?,val writer: WriterView,val favoriteQuestionIds: List<UUID> = emptyList())
data class ObjectiveMetrics(val count: Int,val answered: Int,val correct: Int,val wrong: Int,val unanswered: Int,val accuracy: Double?,val score: Int?=null)
data class SelfMetrics(val count: Int,val answered: Int,val rated: Int,val correct: Int,val wrong: Int,val unrated: Int)
data class ResultView(val id: UUID,val sessionId: UUID,val version: Long,val totalCount: Int,val answeredCount: Int,val durationSeconds: Int,val objective: ObjectiveMetrics,val shortAnswer: SelfMetrics,val items: List<PracticeItemView>,val submittedAt: Instant)
data class PracticeSummary(val id: UUID,val questionBankId: UUID,val status: String,val version: Long,val durationSeconds: Int,val createdAt: Instant,val submittedAt: Instant?)

// Offline grading data stays separate from the question presentation DTO.
data class PracticeConfiguration(val chapterIds: List<UUID>,val count: Int,val order: String,val selectionKind: String,val feedback: String,val contentVersion: Long,val questionIds: List<UUID> = emptyList(),val collectionChip: String="all",@field:Schema(allowableValues=["order","practice","test","view"]) val mode: String?=null,@field:Schema(minimum="1",maximum="86400") val timeLimitSeconds: Int?=null)
data class OfflineGrading(val itemId: UUID,val correctAnswer: List<String>?,val correctValue: Boolean?,val referenceAnswer: String?,val explanation: String?,
    val blanks: List<qanda.backend.content.BlankInput>?=null,val blankMatch: qanda.backend.content.BlankMatch?=null,val scoringPoints: List<String>?=null)
data class WriterInput(val deviceId: UUID)
data class WriterReleaseInput(val deviceId: UUID,val writerToken: UUID,val expectedVersion: Long,val clientSequence: Long)
data class WriterView(@field:Schema(allowableValues=["ACTIVE","WAITING","RELEASED"]) val state: String,val deviceId: UUID?,val writerToken: UUID?,val pendingDeviceId: UUID?,val version: Long,val acknowledgedSequence: Long,val updatedAt: Instant)
data class ProgressAck(val id: UUID,val version: Long,val acknowledgedSequence: Long,val writer: WriterView)

internal fun objectiveMetrics(count: Int,correct: Int,wrong: Int): ObjectiveMetrics {
    val answered=correct+wrong
    return ObjectiveMetrics(count,answered,correct,wrong,count-answered,if(answered==0) null else correct.toDouble()/answered,
        if(count==0) null else kotlin.math.floor(correct*100.0/count+0.5).toInt())
}
