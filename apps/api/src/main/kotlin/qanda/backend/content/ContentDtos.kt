package qanda.backend.content

import io.swagger.v3.oas.annotations.media.Schema
import java.time.Instant
import java.util.UUID
import qanda.backend.platform.queries.BankProgressView
import jakarta.validation.constraints.Size

data class CategoryInput(val collegeId: UUID?=null,val majorId: UUID?=null,val grade: Int?=null)
data class BankInput(val subjectId: UUID,val name: String,val description: String="",val textbook: String="",@field:Schema(allowableValues=["ACTIVE","INACTIVE"]) val status: String="ACTIVE",
                     val categories: List<CategoryInput> = emptyList(),@field:Schema(description="省略时保留维护者") val maintainerIds: List<UUID>?=null,val expectedVersion: Long?=null)
data class BankView(val id: UUID,val subjectId: UUID,val name: String,val description: String,val textbook: String,val status: String,val publicationStatus: String,
                    val categories: List<CategoryInput>,val maintainerIds: List<UUID>,val version: Long,val contentVersion: Long,val questionCount: Long,val activeQuestionCount: Long,val updatedAt: Instant,val subjectName: String?=null,val progress: BankProgressView?=null)
data class ChapterInput(val name: String,val sortOrder: Int,val expectedVersion: Long?=null)
data class ChapterView(val id: UUID,val questionBankId: UUID,val name: String,val sortOrder: Int,val version: Long,val questionCount: Long=0,val progress: BankProgressView?=null)
data class PublicationCheck(val label: String,val passed: Boolean,val detail: String)
data class ReorderInput(val expectedContentVersion: Long,val ids: List<UUID>)
data class PublicationInput(val expectedVersion: Long,@field:Schema(allowableValues=["DRAFT","PUBLISHED","UNPUBLISHED","ARCHIVED"]) val status: String)
data class OptionInput(val key: String,val content: String)
data class BlankInput(val answers: List<String>)
data class BlankMatch(val ignoreCase: Boolean=true,val trimWhitespace: Boolean=true)
data class ReadingChildRef(val id: UUID,val revisionId: UUID)
data class QuestionContentData(val blanks: List<BlankInput> = emptyList(),val blankMatch: BlankMatch=BlankMatch(),val scoringPoints: List<String> = emptyList(),val passage: String?=null,val children: List<ReadingChildRef> = emptyList(),@field:Schema(allowableValues=["PLAIN_TEXT","MARKDOWN"]) val contentFormat: String="PLAIN_TEXT",@field:Schema(allowableValues=["STANDARD","CONCEPT","CODE_ANALYSIS","CODE_WRITING"]) val presentation: String="STANDARD",val codeLanguage: String?=null)
data class ReadingMaterialView(val id: UUID,val revisionId: UUID,val passage: String,val assetIds: List<UUID>,@field:Schema(allowableValues=["PLAIN_TEXT","MARKDOWN"]) val contentFormat: String="PLAIN_TEXT")
data class QuestionInput(val questionBankId: UUID,@field:Schema(allowableValues=["SINGLE_CHOICE","MULTIPLE_CHOICE","TRUE_FALSE","FILL_BLANK","SHORT_ANSWER","READING"]) val type: String,val stem: String,val chapterId: UUID?=null,val options: List<OptionInput> = emptyList(),
                         val correctAnswer: List<String> = emptyList(),val correctValue: Boolean?=null,val referenceAnswer: String?=null,val explanation: String="",
                         val assetIds: List<UUID> = emptyList(),@field:Schema(allowableValues=["ACTIVE","INACTIVE"]) val status: String="ACTIVE",val expectedVersion: Long?=null,
                         val blanks: List<BlankInput> = emptyList(),val blankMatch: BlankMatch=BlankMatch(),val scoringPoints: List<String> = emptyList(),val passage: String?=null,val subQuestions: List<ReadingChildInput> = emptyList(),@field:Schema(allowableValues=["PLAIN_TEXT","MARKDOWN"]) val contentFormat: String="PLAIN_TEXT",@field:Schema(allowableValues=["STANDARD","CONCEPT","CODE_ANALYSIS"]) val presentation: String="STANDARD",val codeLanguage: String?=null)
data class ReadingChildInput(val id: UUID?=null,val type: String,val stem: String,val options: List<OptionInput> = emptyList(),val correctAnswer: List<String> = emptyList(),val correctValue: Boolean?=null,
    val referenceAnswer: String?=null,val explanation: String="",val assetIds: List<UUID> = emptyList(),val blanks: List<BlankInput> = emptyList(),val blankMatch: BlankMatch=BlankMatch(),val scoringPoints: List<String> = emptyList(),@field:Schema(allowableValues=["PLAIN_TEXT","MARKDOWN"]) val contentFormat: String="PLAIN_TEXT",@field:Schema(allowableValues=["STANDARD","CONCEPT","CODE_ANALYSIS"]) val presentation: String="STANDARD",val codeLanguage: String?=null) {
    fun question(parent: QuestionInput)=QuestionInput(parent.questionBankId,type,stem,parent.chapterId,options,correctAnswer,correctValue,referenceAnswer,explanation,assetIds,parent.status,
        blanks=blanks,blankMatch=blankMatch,scoringPoints=scoringPoints,contentFormat=contentFormat,presentation=presentation,codeLanguage=codeLanguage)
}
data class QuestionView(val id: UUID,val questionBankId: UUID,val chapterId: UUID?,val status: String,val version: Long,val revisionId: UUID,val revision: Int,
                        @field:Schema(allowableValues=["SINGLE_CHOICE","MULTIPLE_CHOICE","TRUE_FALSE","FILL_BLANK","SHORT_ANSWER","READING"]) val type: String,val stem: String,val options: List<OptionInput>,val correctAnswer: List<String>?,val correctValue: Boolean?,val referenceAnswer: String?,
                        val explanation: String?,val assetIds: List<UUID>,val subjectId: UUID?=null,val subjectName: String?=null,val questionBankName: String?=null,
                        val blankCount: Int=0,val blanks: List<BlankInput>?=null,val blankMatch: BlankMatch?=null,val scoringPoints: List<String>?=null,
                        val passage: String?=null,val subQuestions: List<QuestionView> = emptyList(),val material: ReadingMaterialView?=null,@field:Schema(allowableValues=["PLAIN_TEXT","MARKDOWN"]) val contentFormat: String="PLAIN_TEXT",@field:Schema(allowableValues=["STANDARD","CONCEPT","CODE_ANALYSIS","CODE_WRITING"]) val presentation: String="STANDARD",val codeLanguage: String?=null)
data class ImportInput(val expectedContentVersion: Long,@field:Size(min=1,max=3000) val questions: List<QuestionInput>)
data class ImportView(val questionIds: List<UUID>,val contentVersion: Long)
data class PreviewIssue(val index: Int,val code: String,val message: String)
data class ImportPreview(val valid: Boolean,val questionCount: Int,val issues: List<PreviewIssue>)
