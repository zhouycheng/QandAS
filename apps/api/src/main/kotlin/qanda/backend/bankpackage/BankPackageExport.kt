package qanda.backend.bankpackage

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Isolation
import org.springframework.transaction.annotation.Transactional
import qanda.backend.content.*
import qanda.backend.platform.files.FileService
import qanda.backend.platform.http.PageSpec
import qanda.backend.platform.security.Actor
import java.io.OutputStream
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

@Service
class BankPackageExport(private val content: ContentService, private val files: FileService, private val jdbc: JdbcTemplate, private val json: ObjectMapper) {
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    fun write(actor: Actor, bankId: UUID, output: OutputStream) {
        val bank = content.bank(actor, bankId)
        val chapters = content.chapters(actor, bankId)
        val keys = mutableMapOf<UUID, String>()
        val origins = mutableMapOf<UUID, JsonNode>()
        val sources = json.createObjectNode()
        jdbc.query("SELECT id,portable_id,package_source FROM question WHERE bank_id=?", { rs ->
            val id = rs.getObject(1, UUID::class.java)
            keys[id] = rs.getString(2)
            rs.getString(3)?.let { raw ->
                val stored = json.readTree(raw)
                origins[id] = stored
            }
        }, bankId)
        val chapterKeys = chapters.associate { it.id to UUID.nameUUIDFromBytes(("chapter:" + it.id).toByteArray()).toString() }
        val images = linkedMapOf<UUID, String>()
        fun question(q: QuestionView): ObjectNode {
            val node = json.createObjectNode().put("id", keys.getValue(q.id)).put("type", q.type).put("stem", q.stem)
                .put("status", q.status).put("contentFormat", q.contentFormat).put("presentation", q.presentation).put("explanation", q.explanation.orEmpty())
            fun put(key: String, value: Any?) { if (value != null) node.set<JsonNode>(key, json.valueToTree(value)) }
            origins[q.id]?.let { origin ->
                put("provenance", origin.path("provenance"))
                origin.path("sources").forEach { sources.set<JsonNode>(it.path("id").asText(),it) }
            }
            put("chapterId", chapterKeys[q.chapterId]);put("codeLanguage", q.codeLanguage)
            put("assetIds", q.assetIds.map { id -> images.getOrPut(id) { UUID.nameUUIDFromBytes(("image:" + id).toByteArray()).toString() } })
            when (q.type) {
                "READING" -> { put("passage", q.passage);put("subQuestions", q.subQuestions.map { question(it).apply { remove("chapterId") } }) }
                "SINGLE_CHOICE", "MULTIPLE_CHOICE" -> { put("options", q.options);put("correctAnswer", q.correctAnswer) }
                "TRUE_FALSE" -> put("correctValue", q.correctValue)
                "FILL_BLANK" -> { put("blanks", q.blanks);put("blankMatch", q.blankMatch) }
                "SHORT_ANSWER" -> { put("referenceAnswer", q.referenceAnswer);put("scoringPoints", q.scoringPoints) }
            }
            InlineImages.mapFields(node) { value -> images[UUID.fromString(value)] ?: error("题目引用了缺失的图片") }
            return node
        }
        ZipOutputStream(output).use { zip ->
            zip.putNextEntry(ZipEntry("bank.json"))
            val generator = json.factory.createGenerator(zip).disable(com.fasterxml.jackson.core.JsonGenerator.Feature.AUTO_CLOSE_TARGET)
            generator.use { g ->
                g.writeStartObject();g.writeStringField("format", "qanda-question-bank");g.writeStringField("version", "1.0")
                g.writeObjectField("bank", mapOf("name" to bank.name, "description" to bank.description,"textbook" to bank.textbook,"status" to bank.status))
                g.writeObjectField("chapters", chapters.map { mapOf("id" to chapterKeys[it.id], "name" to it.name) })
                g.writeArrayFieldStart("questions")
                var page = 1
                do {
                    val rows = content.questions(actor, bankId, null, null, PageSpec(page++, 100)).items
                    rows.forEach { g.writeTree(question(it)) }
                } while (rows.size == 100)
                g.writeEndArray()
                val assets=images.map { (id,key) ->
                    val row=json.createObjectNode().put("id",key).put("path","assets/images/$key.png")
                    jdbc.queryForObject("SELECT package_source::text FROM file_asset WHERE id=?",String::class.java,id)?.let { text ->
                        val origin=json.readTree(text)
                        row.set<JsonNode>("sourceRefs",origin["sourceRefs"])
                        origin["sources"].forEach { sources.set<JsonNode>(it.path("id").asText(),it) }
                    }
                    row
                }
                g.writeObjectField("assets",assets)
                g.writeObjectField("sources", sources.toList())
                g.writeEndObject()
            }
            zip.closeEntry()
            images.forEach { (id, key) ->
                zip.putNextEntry(ZipEntry("assets/images/$key.png"))
                zip.write(files.read(actor, id));zip.closeEntry()
            }
        }
    }
}
