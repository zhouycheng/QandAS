package qanda.backend.content

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.stereotype.Service
import qanda.backend.content.api.RevisionReference
import qanda.backend.platform.http.missing
import java.util.UUID

@Service
class QuestionReader(private val questions: QuestionMapper, private val revisions: QuestionRevisionMapper,
                     private val sql: ContentQueries, private val json: ObjectMapper) {
    fun read(refs: List<RevisionReference>, answers: Boolean): List<QuestionView> {
        if (refs.isEmpty()) return emptyList()
        val questionRows = questions.selectByIds(refs.map { it.questionId }.distinct()).associateBy { it.id }.toMutableMap()
        val parents = questionRows.values.mapNotNull { it.readingParentId }.distinct()
        if (parents.isNotEmpty()) questions.selectByIds(parents).forEach { questionRows[it.id] = it }
        val revisionRows = mutableMapOf<UUID, QuestionRevision>()
        val metadata = mutableMapOf<UUID, QuestionContentData>()
        var needed = refs.flatMap { ref -> listOfNotNull(ref.revisionId ?: questionRows[ref.questionId]?.currentRevisionId,
            ref.materialRevisionId ?: questionRows[questionRows[ref.questionId]?.readingParentId]?.currentRevisionId) }.distinct()
        while (needed.isNotEmpty()) {
            val loaded = revisions.selectByIds(needed)
            if (loaded.size != needed.size) missing()
            loaded.forEach { row -> revisionRows[row.id!!] = row; metadata[row.id!!] = json.readValue(row.contentData, QuestionContentData::class.java) }
            val children = loaded.flatMap { metadata.getValue(it.id!!).children }
            val ids = children.map { it.id }.filter { it !in questionRows }.distinct()
            if (ids.isNotEmpty()) questions.selectByIds(ids).forEach { questionRows[it.id] = it }
            needed = children.map { it.revisionId }.filter { it !in revisionRows }.distinct()
        }
        val ids = revisionRows.keys.toList()
        val options = sql.batchOptions(ids).groupBy { it.revisionId }
        val attachments = sql.batchAttachments(ids).groupBy { it.revisionId }
        fun assets(id: UUID) = attachments[id].orEmpty().map { it.fileId!! }
        fun view(ref: RevisionReference): QuestionView {
            val q = questionRows[ref.questionId] ?: missing()
            val r = revisionRows[ref.revisionId ?: q.currentRevisionId] ?: missing()
            if (r.questionId != q.id) missing()
            val extra = metadata.getValue(r.id!!)
            val choices = options[r.id].orEmpty()
            val materialId = ref.materialRevisionId ?: questionRows[q.readingParentId]?.currentRevisionId
            val material = materialId?.let { id ->
                val parent = revisionRows[id] ?: missing()
                val data = metadata.getValue(id)
                ReadingMaterialView(parent.questionId!!, id, data.passage.orEmpty(), assets(id), data.contentFormat)
            }
            return QuestionView(q.id!!, q.bankId!!, q.chapterId, q.status, q.version, r.id!!, r.revisionNumber, r.type, r.stem,
                choices.map { OptionInput(it.optionKey, it.content) }, choices.filter { it.isCorrect }.map { it.optionKey }.takeIf { answers },
                r.correctValue.takeIf { answers }, r.referenceAnswer.takeIf { answers }, r.explanation.takeIf { answers }, assets(r.id!!),
                blankCount = extra.blanks.size, blanks = extra.blanks.takeIf { answers }, blankMatch = extra.blankMatch.takeIf { answers && r.type == "FILL_BLANK" },
                scoringPoints = extra.scoringPoints.takeIf { answers }, passage = extra.passage,
                subQuestions = extra.children.map { view(RevisionReference(it.id, it.revisionId, r.id)) }, material = material,
                contentFormat = extra.contentFormat, presentation = extra.presentation, codeLanguage = extra.codeLanguage)
        }
        return refs.map(::view)
    }
}
