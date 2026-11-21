package qanda.backend.bankpackage

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import qanda.backend.platform.http.invalid
import java.util.UUID

internal fun packageSource(json: ObjectMapper,row: JsonNode,sources: JsonNode): JsonNode? {
    val origin=row.get("provenance")?.takeUnless(JsonNode::isNull) ?: return null
    if(origin !is ObjectNode) invalid("/provenance")
    val provenance=origin.deepCopy()
    val refs=provenance.path("sourceRefs")
    if(provenance.path("origin").asText() !in setOf("authored","extracted") || !refs.isArray || refs.isEmpty) invalid("/provenance")
    val ai=provenance.path("ai")
    val fields=ai.path("fields")
    val allowed=setOf("stem","explanation","options","correctAnswer","correctValue","blanks","referenceAnswer","scoringPoints","passage")
    if(!fields.isArray || fields.map { it.asText() }.distinct().size!=fields.size() || fields.any { it.asText() !in allowed } ||
        !ai.path("note").isTextual || !fields.isEmpty && ai.path("note").asText().isBlank()) invalid("/provenance/ai")
    if (fields.any { it.asText() == "explanation" } && row.path("explanation").textValue().isNullOrBlank())
        invalid("/explanation", message="AI 补写的解析需要填写正文")
    val metadata=sourceReferences(json,refs,sources)
    provenance.set<JsonNode>("sourceRefs",metadata["sourceRefs"])
    return json.valueToTree(mapOf("provenance" to provenance,"sources" to metadata["sources"]))
}

internal fun sourceReferences(json: ObjectMapper,references: JsonNode,sources: JsonNode): ObjectNode {
    if(!references.isArray || references.isEmpty) invalid("/sourceRefs")
    val refs=references.deepCopy<JsonNode>()
    val available=sources.associateBy { it.path("id").asText() }
    if(!sources.isArray || available.size!=sources.size()) invalid("/sources")
    val used=sortedMapOf<String,JsonNode>()
    for(ref in refs) {
        val source=available[ref.path("sourceId").asText()] ?: invalid("/sourceRefs")
        if(ref !is ObjectNode || ref.path("location").asText().isBlank() || source.path("name").asText().isBlank() || source.path("kind").asText().isBlank()) invalid("/sourceRefs")
        val identity=json.writeValueAsBytes(listOf(source.path("name").asText(),source.path("kind").asText(),source.path("uri").asText()))
        val id=UUID.nameUUIDFromBytes(identity).toString()
        ref.put("sourceId",id)
        used[id]=source.deepCopy<ObjectNode>().put("id",id)
    }
    return json.valueToTree(mapOf("sourceRefs" to refs,"sources" to used.values))
}
