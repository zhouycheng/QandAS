package qanda.backend.content

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import java.util.UUID

object InlineImages {
    private val tokens = Regex("""(?s)(`+).*?\1|\\.|!\[([^\]\n]*)\]\(asset:([A-Za-z0-9_.-]+)\)""")

    fun rewrite(text: String, replace: (String,String) -> String): String = tokens.replace(text) { token ->
        token.groups[3]?.let { replace(token.groupValues[2],it.value) } ?: token.value
    }

    fun mapFields(node: ObjectNode, resolve: (String) -> String) {
        if (node.path("contentFormat").asText()!="MARKDOWN") return
        fun mapped(text: String) = rewrite(text) { alt,id -> "![$alt](asset:${resolve(id)})" }
        for (key in listOf("stem","passage","explanation","referenceAnswer"))
            if (node.path(key).isTextual) node.put(key,mapped(node[key].asText()))
        node.path("options").forEach { if(it is ObjectNode && it.path("content").isTextual) it.put("content",mapped(it["content"].asText())) }
        node.get("scoringPoints")?.takeIf { it.isArray }?.let { array ->
            node.putArray("scoringPoints").also { out -> array.forEach { out.add(mapped(it.asText())) } }
        }
    }

    fun student(q: QuestionView, rich: Boolean, attached: List<UUID>, solution: List<String>): QuestionView {
        if (q.contentFormat!="MARKDOWN") return q
        val available=attached.associateBy(UUID::toString)
        val visible=linkedSetOf<UUID>()
        val hidden=mutableSetOf<UUID>()
        fun project(text: String, ids: MutableSet<UUID>) = rewrite(text) { alt,id ->
            available[id]?.let { ids.add(it) }
            if(!rich && id in available) qanda.backend.platform.http.CompatibilityUsage.mark("inline-fallback")
            if(rich && id in available) "![$alt](asset:$id)" else alt
        }
        solution.forEach { project(it,hidden) }
        val stem=project(q.stem,visible)
        val passage=q.passage?.let { project(it,visible) }
        val options=q.options.map { it.copy(content=project(it.content,visible)) }
        return q.copy(stem=stem, passage=passage,options=options,
            assetIds=(if(rich) emptyList() else visible.toList()) + attached.filter { it !in hidden && it !in visible } +
                (if(!rich && q.explanation!=null) hidden.filter { it !in visible } else emptyList()),
            explanation=q.explanation?.let { project(it,hidden) },referenceAnswer=q.referenceAnswer?.let { project(it,hidden) },
            scoringPoints=q.scoringPoints?.map { project(it,hidden) })
    }
}
