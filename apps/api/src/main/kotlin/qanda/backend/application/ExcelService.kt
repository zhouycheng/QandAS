package qanda.backend.application

import qanda.backend.excel.*

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.catalog.*
import qanda.backend.content.*
import qanda.backend.identity.*
import qanda.backend.admin.AdminService
import qanda.backend.platform.http.*
import qanda.backend.platform.security.*
import qanda.backend.platform.files.*
import java.time.*
import java.util.UUID
import java.io.ByteArrayOutputStream
import java.util.zip.*

@Service
class ExcelService(private val jdbc: JdbcTemplate,private val json: ObjectMapper,private val catalog: CatalogService,private val content: ContentService,
    private val accounts: UserAccountMapper,private val profiles: UserProfileMapper,private val admin: AdminService,private val access: ContentAccess,private val files: FileService,private val commands: Commands) {
    private fun id(value: String)=UUID.nameUUIDFromBytes(("qanda-excel-1:"+value).toByteArray())
    private fun exists(table: String,value: UUID)=jdbc.queryForObject("SELECT count(*) FROM $table WHERE id=?",Int::class.java,value)!!>0
    private fun target(doc: JsonNode,options: ExcelOptions)=options.targets[doc.path("fileId").asText()] ?: ExcelTarget()
    private fun problem(file: String,sheet: String,row: Int,column: String,e: Exception)=ExcelIssue(file,sheet,row,column,if(e is ApiException) e.message else e.message ?: "内容无效")
    fun template(kind: String): ByteArray {
        val doc=json.createObjectNode().put("fileId",UUID.randomUUID().toString())
        doc.putArray("users");doc.putArray("questions");doc.putArray("chapters");doc.putObject("bank")
        return ExcelWorkbook.write(doc,kind)
    }
    fun documents(input: List<ExcelFile>,kind: String): List<Pair<ExcelFile,ObjectNode>> {
        val books=input.filter { it.name.endsWith(".xlsx",true) };require(books.size in 1..20) { "请选择 1–20 个 Excel 文件" }
        return books.map { it to ExcelWorkbook.read(it.bytes,kind) }.also { docs ->
            require(docs.map { it.second.path("fileId").asText() }.distinct().size==docs.size) { "文件编号重复" }
            require(json.writeValueAsBytes(docs.map { it.second }).size<=8*1024*1024) { "规范化内容最多 8 MiB，请拆分文件" }
        }
    }
    fun preview(actor: Actor,kind: String,input: List<ExcelFile>,options: ExcelOptions): ExcelPreview {
        val issues=mutableListOf<ExcelIssue>();val summaries=mutableListOf<Map<String,Any?>>()
        val docs=try { documents(input,kind) } catch(e: Exception) { val w=e as? WorkbookProblem;return ExcelPreview(false,0,emptyList(),listOf(problem(input.firstOrNull()?.name ?: "","${w?.sheet ?: "文件"}",w?.row ?: 1,w?.column ?: "",e))) }
        var count=0;val emails=mutableSetOf<String>();val codes=mutableSetOf<String>()
        docs.forEach { (file,doc) ->
            val initialCount=count
            val fileId=doc.path("fileId").asText();val rows=doc.path(if(kind=="users") "users" else "questions")
            if(rows.isEmpty) issues.add(ExcelIssue(file.name,if(kind=="users") "用户" else "题目",2,"","至少填写一条记录"))
            if(jdbc.queryForObject("SELECT count(*) FROM command_receipt WHERE operation=? AND command_id=?",Int::class.java,"EXCEL_FILE:$kind",id(fileId))!!>0) issues.add(ExcelIssue(file.name,"文件",1,"文件编号","该文件已导入"))
            if(kind=="users") {
                val ids=mutableSetOf<String>()
                rows.forEachIndexed { i,r -> try {
                    require(ids.add(r.path("id").asText())) { "记录编号重复" }
                    val u=user(doc,r)
                    require(emails.add(u.emailKey!!) && codes.add(u.accountCode)) { "文件内邮箱或账号重复" }
                    require(jdbc.queryForObject("SELECT count(*) FROM user_account WHERE id=? OR email_key=? OR account_code=?",Int::class.java,u.id,u.emailKey,u.accountCode)==0) { "邮箱、账号或记录已存在" }
                } catch(e: Exception) { issues.add(problem(file.name,"用户",i+2,"邮箱 / 账号 / 资料",e)) } }
                count+=rows.size()
            } else {
                val t=target(doc,options)
                try {
                    name(doc.path("bank").path("name").asText());text(doc.path("bank").path("description").asText(),2000)
                    val existingBank=t.bankId?.let { content.bank(actor,it) }
                    if(existingBank!=null) {
                        if(t.expectedContentVersion!=null) requireVersion(t.expectedContentVersion,existingBank.contentVersion)
                    } else {
                        val subject=resolveSubject(doc,t,false)
                        require(t.subjectId!=null || t.createSubject || subject!=null) { "请选择已有课程，或确认创建课程" }
                        if(subject!=null) require(jdbc.queryForObject("SELECT count(*) FROM question_bank WHERE subject_id=? AND name=?",Int::class.java,subject,doc.path("bank").path("name").asText())==0) { "该课程已有同名题库，请选择追加目标题库" }
                    }
                    val chapters=doc.path("chapters").map { it.path("id").asText() }
                    require(chapters.distinct().size==chapters.size && chapters.all { it.isNotBlank() }) { "章节编号为空或重复" }
                    doc.path("chapters").forEach { name(it.path("name").asText()) }
                    val available=t.bankId?.let { content.chapters(actor,it).map { c -> c.id }.toSet() } ?: emptySet()
                    require(t.chapterMap.keys.all { it in chapters } && t.chapterMap.values.all { it in available }) { "章节映射不属于目标题库" }
                    doc.path("assets").forEach { a -> val path=a.path("path").asText();val raw=input.singleOrNull { it.name==path } ?: error("缺少附件：$path");ImageNormalizer.normalize(raw.bytes,ImageLimits(media(path))) }
                    rows.forEachIndexed { i,q -> try {
                        require(!q.has("chapterId") || q.path("chapterId").asText() in chapters) { "章节引用不存在" }
                        val qi=question(doc,q,t.bankId ?: id(fileId),emptyMap(),emptyMap(),false)
                        content.validate(qi,false)
                        if(existingBank?.publicationStatus=="PUBLISHED") content.validatePublishedQuestion(qi)
                        q.path("systemId").asText().takeIf { it.isNotBlank() }?.let { require(!exists("question",UUID.fromString(it))) { "系统记录已存在" } }
                        if(t.bankId!=null) require(!exists("question",id("$fileId:${t.bankId}:${q.path("id").asText()}"))) { "题目记录已存在" }
                    } catch(e: Exception) { issues.add(problem(file.name,"题目",i+2,"题目内容",e)) } }
                } catch(e: Exception) { issues.add(problem(file.name,"题库信息",2,"课程 / 题库 / 关联",e)) }
                count+=rows.sumOf { if(it.path("type").asText()=="READING") it.path("subQuestions").size() else 1 }
            }
            val t=target(doc,options)
            val types=if(kind=="users") emptyMap() else rows.flatMap {
                if(it.path("type").asText()=="READING") it.path("subQuestions").toList() else listOf(it)
            }.groupingBy { it.path("type").asText() }.eachCount()
            val samples: List<Map<String,Any?>> = if(kind=="users") rows.take(20).mapNotNull { r -> runCatching {
                val u=user(doc,r)
                mapOf("accountCode" to u.accountCode,"email" to u.email,"nickname" to u.nickname,"status" to u.status,"registeredAt" to u.createdAt)
            }.getOrNull() } else emptyList()
            summaries.add(mapOf("name" to file.name,"fileId" to fileId,"count" to count-initialCount,"types" to types,"samples" to samples,
                "subject" to doc.path("subject").asText(),"bank" to doc.path("bank").path("name").asText(),
                "expectedContentVersion" to t.bankId?.let { content.bank(actor,it).contentVersion },"chapters" to doc.path("chapters")))
        }
        if(count>3000) issues.add(ExcelIssue("批次","文件",1,"数量","每批最多 3000 条用户或作答题"))
        return ExcelPreview(issues.isEmpty(),count,summaries,issues)
    }
    private fun user(doc: JsonNode,r: JsonNode): UserAccount {
        val local=r.path("id").asText();require(local.isNotBlank() && local.length<=80) { "记录编号必填，最多 80 字" }
        val address=email(r.path("email").asText());val account=r.path("accountCode").asText().ifBlank { "QA"+id(doc.path("fileId").asText()+":"+local).toString().replace("-","").take(10).uppercase() }
        require(account.matches(Regex("[A-Za-z0-9_-]{2,12}"))) { "账号格式不正确" }
        profile(r)
        return UserAccount().apply { id=id(doc.path("fileId").asText()+":"+local);email=address.display;emailKey=address.key;nickname=nickname(r.path("nickname").asText());accountCode=account
            status=r.path("status").asText().ifBlank { "ACTIVE" };require(status in setOf("ACTIVE","DISABLED")) { "状态须为 ACTIVE / DISABLED" }
            createdAt=r.path("registeredAt").asText().takeIf { it.isNotBlank() }?.let { Instant.parse(it) } ?: Instant.now();updatedAt=createdAt
        }
    }
    private fun profile(r: JsonNode): UserProfile {
        fun lookup(table: String,value: String,parent: UUID?=null): UUID? {
            if(value.isBlank()) return null
            val result=if(parent==null) jdbc.queryForList("SELECT id FROM $table WHERE name=? AND status='ACTIVE'",UUID::class.java,value) else jdbc.queryForList("SELECT id FROM major WHERE name=? AND college_id=? AND status='ACTIVE'",UUID::class.java,value,parent)
            require(result.size==1) { "学院或专业名称不存在、停用或不唯一" };return result.single()
        }
        val college=lookup("college",r.path("college").asText());val major=lookup("major",r.path("major").asText(),college)
        val grade=r.path("currentGrade").asText().takeIf { it.isNotBlank() }?.toInt()
        require(grade==null || grade in 1..5) { "年级须为 1–5" }
        return UserProfile().apply { collegeId=if(major==null) college else null;majorId=major;this.grade=grade;gradeAcademicYear=grade?.let { AcademicGrade.academicYear(LocalDate.now(ZoneId.of("Asia/Shanghai"))) } }
    }
    private fun resolveSubject(doc: JsonNode,t: ExcelTarget,create: Boolean): UUID? {
        if(t.subjectId!=null) return catalog.subject(t.subjectId,false).id
        val n=name(doc.path("subject").asText());val found=jdbc.queryForList("SELECT id FROM subject WHERE name=?",UUID::class.java,n).singleOrNull()
        return found ?: if(create && t.createSubject) catalog.subject(null,SubjectInput(n)).id else null
    }
    private fun question(doc: JsonNode,q: JsonNode,bank: UUID,chapters: Map<String,UUID>,assets: Map<String,UUID>,real: Boolean): QuestionInput {
        val node=q.deepCopy<ObjectNode>();listOf("id","systemId","provenance","parent").forEach { node.remove(it) }
        node.put("questionBankId",bank.toString())
        q.path("chapterId").asText().takeIf { it.isNotBlank() }?.let { node.put("chapterId",(chapters[it] ?: id(it)).toString()) }
        node.set<JsonNode>("assetIds",json.valueToTree(q.path("assetIds").map { assets[it.asText()] ?: id(it.asText()) }))
        if(real) node.set<JsonNode>("subQuestions",json.valueToTree(q.path("subQuestions").map { c ->
            val child=json.valueToTree<ObjectNode>(question(doc,c,bank,chapters,assets,false));child.remove(listOf("questionBankId","chapterId","status","expectedVersion","passage","subQuestions"));child.put("id",id("${doc.path("fileId").asText()}:$bank:${c.path("id").asText()}").toString());child
        })) else node.set<JsonNode>("subQuestions",json.valueToTree(q.path("subQuestions").map { c ->
            val child=json.valueToTree<ObjectNode>(question(doc,c,bank,chapters,assets,false));child.remove(listOf("questionBankId","chapterId","status","expectedVersion","passage","subQuestions"));child
        }))
        return json.treeToValue(node,QuestionInput::class.java)
    }
    @Transactional
    fun import(actor: Actor,kind: String,input: List<ExcelFile>,options: ExcelOptions,requestId: UUID): ExcelResult {
        jdbc.execute("SELECT pg_advisory_xact_lock(hashtextextended('qanda-excel-import',0))")
        val docs=documents(input,kind)
        val count=docs.sumOf { (_,d) -> if(kind=="users") d.path("users").size() else d.path("questions").sumOf { if(it.path("type").asText()=="READING") it.path("subQuestions").size() else 1 } }
        require(count in 1..3000) { "每批最多 3000 条用户或作答题" }
        // Existing receipts are checked inside the transaction so network retries return the original result.
        var total=0
        val initialBankVersions=mutableMapOf<UUID,Long>()
        docs.forEach { (file,doc) ->
            val fileId=doc.path("fileId").asText()
            val result=commands.run(actor,id(fileId),"EXCEL_FILE:$kind",mapOf("document" to doc,"target" to target(doc,options)),ExcelResult::class.java,requestId) {
                val t=target(doc,options)
                val checkedOptions=if(kind!="users" && t.bankId!=null) {
                    val bank=access.bank(actor,t.bankId,true)
                    val initialVersion=initialBankVersions.getOrPut(t.bankId) { bank.contentVersion }
                    requireVersion(t.expectedContentVersion ?: invalid("/expectedContentVersion"),initialVersion)
                    options.copy(targets=options.targets+(fileId to t.copy(expectedContentVersion=bank.contentVersion)))
                } else options
                val check=preview(actor,kind,input.filter { it===file || !it.name.endsWith(".xlsx",true) },checkedOptions)
                if(!check.valid) invalid("/files","EXCEL_IMPORT_CONFLICT",check.issues.joinToString("；") { "${it.sheet}!${it.row} ${it.message}" })
                if(kind=="users") {
                    doc.path("users").forEach { r -> val u=user(doc,r);accounts.insert(u);profiles.insert(profile(r).apply { userId=u.id }) }
                } else {
                    val subject=if(t.bankId==null) resolveSubject(doc,t,true) else null
                    val bank=t.bankId ?: content.saveBank(actor,null,BankInput(subject ?: invalid("/subjectId"),doc.path("bank").path("name").asText(),doc.path("bank").path("description").asText(),doc.path("bank").path("textbook").asText())).id
                    val chapters=mutableMapOf<String,UUID>();chapters.putAll(t.chapterMap)
                    var order=(content.chapters(actor,bank).maxOfOrNull { it.sortOrder } ?: -1)+1
                    doc.path("chapters").forEach { c -> val key=c.path("id").asText();if(key !in chapters) chapters[key]=content.saveChapter(actor,bank,null,ChapterInput(c.path("name").asText(),order++)).id }
                    val assets=mutableMapOf<String,UUID>()
                    doc.path("assets").forEach { a -> val key=a.path("id").asText();if(key !in assets) { val raw=input.single { it.name==a.path("path").asText() };assets[key]=files.upload(actor,bank,media(raw.name),raw.bytes).id } }
                    val qs=doc.path("questions").map { question(doc,it,bank,chapters,assets,true) }
                    content.import(actor,bank,ImportInput(content.bank(actor,bank).contentVersion,qs),doc.path("questions").map { id("$fileId:$bank:${it.path("id").asText()}") })
                }
                ExcelResult(check.count)
            }
            total+=result.count
        }
        return ExcelResult(total)
    }
    private fun media(path: String)=when(path.substringAfterLast('.').lowercase()) { "png" -> "image/png";"jpg","jpeg" -> "image/jpeg";"webp" -> "image/webp";else -> error("附件格式须为 PNG、JPEG、WebP") }
    @Transactional(readOnly=true)
    fun export(actor: Actor,kind: String,query: Map<String,String>): ExcelDownload {
        val output=mutableListOf<ExcelFile>()
        fun uuid(key: String)=query[key]?.takeIf { it.isNotBlank() }?.let(UUID::fromString)
        if(kind=="users") {
            var page=1;var part=1;val rows=mutableListOf<JsonNode>()
            while(true) {
                val result=admin.listUsers(query["keyword"],uuid("collegeId"),uuid("majorId"),query["status"],PageSpec(page++,100),query["grade"]?.toInt())
                result.items.forEach { u -> rows.add(json.createObjectNode().put("id",u.id.toString()).put("systemId",u.id.toString()).put("email",u.email ?: "").put("accountCode",u.accountCode).put("nickname",u.nickname).put("status",u.status).put("registeredAt",u.registeredAt.toString()).put("college",u.collegeName ?: "").put("major",u.majorName ?: "").put("currentGrade",u.currentGrade?.toString() ?: "")) }
                if(result.items.size<100) break
            }
            var chunk=mutableListOf<JsonNode>()
            fun flush() { if(chunk.isNotEmpty()) { val d=json.createObjectNode().put("fileId",UUID.randomUUID().toString());d.set<JsonNode>("users",json.valueToTree(chunk));output.add(ExcelFile("用户-${part++}.xlsx",ExcelWorkbook.write(d,kind)));chunk=mutableListOf() } }
            rows.forEach { r -> if(chunk.size==3000 || json.writeValueAsBytes(chunk+r).size>7*1024*1024) flush();chunk.add(r) };flush()
            if(output.isEmpty()) output.add(ExcelFile("用户.xlsx",template(kind)))
        } else {
            val banks=if(uuid("bankId")!=null) listOf(content.bank(actor,uuid("bankId")!!)) else {
                val all=mutableListOf<BankView>();var page=1
                while(true) { val result=content.banks(actor,uuid("subjectId"),query["keyword"],PageSpec(page++,100),publicationStatus=query["publicationStatus"]);all.addAll(result.items);if(result.items.size<100) break };all
            }
            banks.forEach { b ->
                val doc=json.createObjectNode().put("subject",b.subjectName ?: catalog.subject(b.subjectId,false).name)
                doc.set<JsonNode>("bank",json.valueToTree(mapOf("name" to b.name,"description" to b.description,"textbook" to b.textbook,"systemId" to b.id)))
                doc.set<JsonNode>("chapters",json.valueToTree(content.chapters(actor,b.id).map { mapOf("id" to it.id,"name" to it.name) }))
                val qs=mutableListOf<JsonNode>();var page=1
                fun portable(q: QuestionView): ObjectNode {
                    val n=json.valueToTree<ObjectNode>(q);n.put("systemId",q.id.toString());n.remove(listOf("questionBankId","version","revisionId","revision","subjectId","subjectName","questionBankName","blankCount","material"));n.set<JsonNode>("subQuestions",json.valueToTree(q.subQuestions.map { portable(it).apply { remove("chapterId") } }));n.fields().asSequence().filter { it.value.isNull }.map { it.key }.toList().forEach { n.remove(it) };return n
                }
                while(true) { val result=content.questions(actor,b.id,null,null,PageSpec(page++,100));qs.addAll(result.items.map(::portable));if(result.items.size<100) break }
                val assetIds=mutableSetOf<UUID>();fun collect(q: JsonNode) { q.path("assetIds").forEach { assetIds.add(UUID.fromString(it.asText())) };q.path("subQuestions").forEach(::collect) };qs.forEach(::collect)
                doc.set<JsonNode>("assets",json.valueToTree(assetIds.map { mapOf("id" to it,"path" to "assets/$it.png") }))
                assetIds.forEach { output.add(ExcelFile("assets/$it.png",files.read(actor,it))) }
                var chunk=mutableListOf<JsonNode>();var count=0;var part=1
                fun flush() { if(chunk.isNotEmpty() || (qs.isEmpty() && part==1)) { doc.put("fileId",UUID.randomUUID().toString());doc.set<JsonNode>("questions",json.valueToTree(chunk));output.add(ExcelFile("题库-${b.id}-${part++}.xlsx",ExcelWorkbook.write(doc,kind)));chunk=mutableListOf();count=0 } }
                qs.forEach { q -> val c=if(q.path("type").asText()=="READING") q.path("subQuestions").size() else 1;if(count+c>3000 || json.writeValueAsBytes(chunk+q).size>7*1024*1024) flush();chunk.add(q);count+=c };flush()
            }
            if(output.isEmpty()) output.add(ExcelFile("题库.xlsx",template(kind)))
        }
        return download(output)
    }
    private fun download(output: List<ExcelFile>): ExcelDownload {
        if(output.size==1 && output[0].name.endsWith(".xlsx")) return ExcelDownload(output[0].name,output[0].bytes,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        val bytes=ByteArrayOutputStream();ZipOutputStream(bytes).use { zip -> output.distinctBy { it.name }.forEach { zip.putNextEntry(ZipEntry(it.name));zip.write(it.bytes);zip.closeEntry() } }
        return ExcelDownload("QandA-Excel导出.zip",bytes.toByteArray(),"application/zip")
    }
}
