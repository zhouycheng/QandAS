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
    if(fields.any { it.asText()=="explanation" } && row.path("type").asText()!="READING") {
        val titles=listOf("结论","核心知识点","解题过程","记忆方法","易错题型")
        val found=mutableListOf<String>()
        var fence=""
        var hasBody=true
        for(raw in row.path("explanation").asText().lineSequence()) {
            val line=raw.trim()
            val marker=Regex("^(`{3,}|~{3,})").find(line)?.value
            if(marker!=null) {
                if(fence.isEmpty()) fence=marker else if(marker.startsWith(fence)) fence=""
                continue
            }
            val title=if(row.path("contentFormat").asText()=="MARKDOWN") Regex("^#{1,6}\\s+(.+)$").matchEntire(line)?.groupValues?.get(1) else line.trimEnd('：',':')
            if(fence.isEmpty() && title in titles) {
                if(!hasBody) invalid("/explanation",message="教学解析标题下需要填写内容")
                found.add(title!!);hasBody=false
            } else if(line.isNotBlank()) hasBody=true
        }
        if(found!=titles || !hasBody) invalid("/explanation",message="教学解析需要五个有内容且顺序正确的标题")
    }
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
