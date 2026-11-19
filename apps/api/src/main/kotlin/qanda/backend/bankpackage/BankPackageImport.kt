package qanda.backend.bankpackage

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.content.*
import qanda.backend.platform.files.*
import qanda.backend.platform.http.*
import qanda.backend.platform.security.Actor
import java.security.MessageDigest
import java.util.HexFormat
import java.util.UUID

data class PackageRequest(val uploadId: UUID, val chapterMap: Map<String,UUID> = emptyMap(), val digest: String? = null,
                          val expectedContentVersion: Long? = null, val confirmUpdates: Boolean = false)
data class PackageChange(val portableId: UUID, val action: String, val fields: List<String>,val differences: Map<String,List<JsonNode?>>)
data class PackageResult(val digest: String, val contentVersion: Long, val changes: List<PackageChange>, val newChapters: List<String>)
private data class StoredQuestion(val id: UUID,val parent: UUID?,val source: JsonNode?,val type: String,val retired: Boolean)

@Service
class BankPackageImport(private val json: ObjectMapper,private val content: ContentService,private val access: ContentAccess,
                        private val files: FileService,private val uploads: BankUploads,private val jdbc: JdbcTemplate) {
    private val inputFields = QuestionInput::class.java.declaredFields.map { it.name }.toSet()
    private fun uuid(node: JsonNode): UUID = try { UUID.fromString(node.asText()).also { if (it.toString()!=node.asText()) invalid("/questions/id") } }
        catch (_: IllegalArgumentException) { invalid("/questions/id", message="题目需要稳定的 UUID") }

    @Transactional
    fun process(actor: Actor, bank: UUID, request: PackageRequest, commit: Boolean): PackageResult {
        val target = access.bank(actor,bank,commit)
        if (commit) requireVersion(request.expectedContentVersion ?: invalid("/expectedContentVersion"),target.contentVersion)
        return uploads.withArchive(actor,bank,request.uploadId) { path,digest ->
            if (commit && request.digest!=digest) conflict("PACKAGE_CHANGED","题包已变化，请重新预览")
            val previewHash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(listOf(digest,target.contentVersion,request.chapterMap.toSortedMap()))))
            if(commit && jdbc.queryForObject("SELECT preview_hash FROM bank_package_upload WHERE id=? FOR UPDATE",String::class.java,request.uploadId)!=previewHash)
                conflict("PREVIEW_CHANGED","题包或章节映射已变化，请重新预览")
            BankArchive(path,json).use { archive ->
                val doc=archive.read()
                val existingChapters=content.chapters(actor,bank)
                val chapters=mutableMapOf<String,UUID>()
                val newChapters=mutableListOf<String>()
                doc["chapters"].forEach { chapter ->
                    val key=chapter.path("id").asText()
                    val label=name(chapter.path("name").asText(),60)
                    if (key.isBlank() || key in chapters) invalid("/chapters/id")
                    val matches=existingChapters.filter { it.name==label }
                    val explicit=request.chapterMap[key]
                    chapters[key]=when {
                        explicit!=null -> existingChapters.singleOrNull { it.id==explicit }?.id ?: invalid("/chapterMap")
                        matches.size==1 -> matches.single().id
                        matches.size>1 -> invalid("/chapters/$key",message="章节「$label」有多个匹配项，请选择章节 [chapter:$key]")
                        else -> {
                            newChapters.add(label)
                            if(commit) content.saveChapter(actor,bank,null,ChapterInput(label,(existingChapters.maxOfOrNull { it.sortOrder } ?: -1)+newChapters.size)).id
                            else UUID.randomUUID()
                        }
                    }
                }
                if (!chapters.keys.containsAll(request.chapterMap.keys)) invalid("/chapterMap")
                val images=mutableMapOf<String,UUID>()
                doc["assets"].forEach { image ->
                    val key=image.path("id").asText()
                    val (type,raw)=archive.image(key)
                    val normalized=ImageNormalizer.normalize(raw,ImageLimits(type))
                    val hash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(normalized.bytes))
                    val origin=image.get("sourceRefs")?.let { sourceReferences(json,it,doc.path("sources")).toString() }
                    val candidates=jdbc.queryForList("SELECT id FROM file_asset WHERE bank_id=? AND sha256=? AND package_source IS NOT DISTINCT FROM ?::jsonb ORDER BY id",UUID::class.java,bank,hash,origin)
                    images[key]=candidates.firstOrNull { UUID.nameUUIDFromBytes(("image:"+it).toByteArray()).toString()==key }
                        ?: candidates.firstOrNull { it !in images.values }
                        ?: if(commit) files.upload(actor,bank,type,raw).id.also { id ->
                            if(origin!=null) jdbc.update("UPDATE file_asset SET package_source=?::jsonb WHERE id=?",origin,id)
                        } else UUID.randomUUID()
                }
                val existing=mutableMapOf<UUID,StoredQuestion>()
                jdbc.query("SELECT q.portable_id,q.id,coalesce(q.reading_parent_id,q.retired_from_group),q.package_source,r.type,q.retired_from_group IS NOT NULL FROM question q JOIN question_revision r ON r.id=q.current_revision_id WHERE q.bank_id=?", { rs ->
                    existing[rs.getObject(1,UUID::class.java)]=StoredQuestion(rs.getObject(2,UUID::class.java),rs.getObject(3,UUID::class.java),rs.getString(4)?.let(json::readTree),rs.getString(5),rs.getBoolean(6))
                },bank)
                val seen=mutableSetOf<UUID>()
                val changes=mutableListOf<PackageChange>()
                doc["questions"].forEach { raw ->
                    val key=uuid(raw.path("id"))
                    val stored=existing[key]
                    val bindings=mutableMapOf<UUID,UUID>()
                    fun mapped(row: JsonNode,child: Boolean): ObjectNode {
                        if(!row.isObject) invalid("/questions")
                        val portable=uuid(row.path("id"))
                        if (!seen.add(portable)) invalid("/questions/$portable", message="题目编号重复")
                        val old=existing[portable]
                        if (old!=null && (if(child) stored==null || old.parent!=stored.id else old.parent!=null)) invalid("/questions/$portable",message="阅读题归属冲突")
                        if (old?.retired==true) invalid("/questions/$portable",message="该小题已归入历史修订")
                        if (old!=null && old.type!=row.path("type").asText()) invalid("/questions/$portable",message="已有题目题型发生冲突")
                        val node=row.deepCopy<ObjectNode>()
                        node.remove(listOf("id","provenance"))
                        if (node.fieldNames().asSequence().any { it !in inputFields || it in setOf("questionBankId","expectedVersion") }) invalid("/questions/$portable",message="题目字段无效")
                        val assetIds=row.path("assetIds").map { images[it.asText()] ?: invalid("/questions/$portable/assetIds") }.toMutableSet()
                        InlineImages.mapFields(node) { key ->
                            val id=images[key] ?: invalid("/questions/$portable",message="正文引用了缺失的图片 $key")
                            assetIds.add(id)
                            id.toString()
                        }
                        node.set<JsonNode>("assetIds",json.valueToTree(assetIds.sortedBy(UUID::toString)))
                        if (child) {
                            if (node.has("chapterId") || node.has("subQuestions")) invalid("/questions/$portable")
                            node.remove("status")
                            val id=old?.id ?: UUID.randomUUID()
                            bindings[portable]=id
                            node.put("id",id.toString())
                        } else {
                            node.put("questionBankId",bank.toString())
                            if (row.hasNonNull("chapterId")) node.put("chapterId",(chapters[row["chapterId"].asText()] ?: invalid("/chapterId")).toString())
                            if (row.has("subQuestions")) node.set<JsonNode>("subQuestions",json.valueToTree(row["subQuestions"].map { mapped(it,true) }))
                        }
                        return node
                    }
                    val input=try { json.treeToValue(mapped(raw,false),QuestionInput::class.java) }
                        catch(_: com.fasterxml.jackson.core.JsonProcessingException) { invalid("/questions/$key",message="题目字段缺失或类型无效") }
                    content.validate(input,commit,archive=true)
                    if(target.publicationStatus=="PUBLISHED") content.validatePublishedQuestion(input)
                    val previous=stored?.let { content.question(actor,it.id,true) }
                    if(previous!=null && (!bindings.values.containsAll(previous.subQuestions.map { it.id })))
                        invalid("/questions/$key",message="题型或已有阅读小题发生冲突")
                    val before=previous?.let { asInput(it) }
                    val differences=if(before==null) mutableMapOf() else {
                        val old=json.valueToTree<ObjectNode>(before)
                        json.valueToTree<ObjectNode>(input).fields().asSequence().filter { (k,v)->old[k]!=v }
                            .associate { (k,v)-> k to listOf<JsonNode?>(old[k],v) }.toMutableMap()
                    }
                    val rows=listOf(raw)+raw.path("subQuestions").toList()
                    fun source(row: JsonNode) = packageSource(json,row,doc.path("sources"))
                    val sources=rows.associate { uuid(it["id"]) to source(it) }
                    if(before!=null && sources.any { (id,origin) -> origin!=existing[id]?.source }) {
                        differences["provenance"]=listOf(json.valueToTree(rows.map { existing[uuid(it["id"])]?.source }),json.valueToTree(rows.map(::source)))
                    }
                    val action=when { previous==null -> "CREATE";differences.isEmpty() -> "SKIP";else -> "UPDATE" }
                    changes.add(PackageChange(key,action,differences.keys.toList(),differences))
                    if(commit && action!="SKIP") {
                        if(action=="UPDATE" && !request.confirmUpdates) invalid("/confirmUpdates",message="请先确认已有题目的修改")
                        val saved=content.saveQuestion(actor,stored?.id,input.copy(expectedVersion=previous?.version),archive=true)
                        bindings[key]=saved.id
                        rows.forEach { row ->
                            val portable=uuid(row["id"])
                            jdbc.update("UPDATE question SET portable_id=?,package_source=?::jsonb WHERE id=? AND bank_id=?",portable,sources[portable]?.toString(),bindings.getValue(portable),bank)
                        }
                    }
                }
                if(commit && target.publicationStatus=="PUBLISHED" && content.publicationChecks(actor,bank).any { !it.passed })
                    invalid("/publication",message="导入后题库无法通过发布检查")
                if(!commit) jdbc.update("UPDATE bank_package_upload SET preview_hash=? WHERE id=?",previewHash,request.uploadId)
                PackageResult(digest,if(commit) content.bank(actor,bank).contentVersion else target.contentVersion,changes,newChapters)
            }
        }
    }

    private fun asInput(q: QuestionView): QuestionInput {
        fun child(c: QuestionView)=ReadingChildInput(c.id,c.type,c.stem,c.options,c.correctAnswer.orEmpty(),c.correctValue,c.referenceAnswer,c.explanation.orEmpty(),c.assetIds,c.blanks.orEmpty(),c.blankMatch ?: BlankMatch(),c.scoringPoints.orEmpty(),c.contentFormat,c.presentation,c.codeLanguage)
        return QuestionInput(q.questionBankId,q.type,q.stem,q.chapterId,q.options,q.correctAnswer.orEmpty(),q.correctValue,q.referenceAnswer,q.explanation.orEmpty(),q.assetIds,q.status,
            blanks=q.blanks.orEmpty(),blankMatch=q.blankMatch ?: BlankMatch(),scoringPoints=q.scoringPoints.orEmpty(),passage=q.passage,subQuestions=q.subQuestions.map(::child),contentFormat=q.contentFormat,presentation=q.presentation,codeLanguage=q.codeLanguage)
    }
}
