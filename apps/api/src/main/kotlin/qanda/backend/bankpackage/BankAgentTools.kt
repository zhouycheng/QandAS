package qanda.backend.bankpackage

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.*
import qanda.backend.admin.*
import qanda.backend.identity.*
import qanda.backend.announcements.*
import qanda.backend.operations.*
import qanda.backend.catalog.*
import qanda.backend.content.*
import qanda.backend.identity.IdentityCrypto
import qanda.backend.platform.files.FileService
import qanda.backend.platform.http.*
import qanda.backend.platform.security.*
import java.util.UUID

@RestController
@io.swagger.v3.oas.annotations.Hidden
@RequestMapping("/bank-agent")
class BankAgentTools(private val grants: BankAgentGrants,private val content: ContentService,private val catalog: CatalogService,
                     private val admin: AdminService,private val tests: TestAccountService,private val announcements: AnnouncementService,private val operations: OperationsService,
                     private val access: ContentAccess,private val importer: BankPackageImport,private val exporter: BankPackageExport,
                     private val uploads: BankUploads,private val files: FileService,private val commands: Commands,
                     private val json: ObjectMapper,private val jdbc: JdbcTemplate,private val crypto: IdentityCrypto) {
    private fun write(grant: AgentGrant,bank: UUID) {
        if("banks:write" !in grant.scopes) forbidden()
        if(access.bank(grant.actor,bank,true).publicationStatus=="PUBLISHED" && "banks:publish" !in grant.scopes) forbidden()
    }

    @GetMapping("/identity")
    @Transactional
    fun identity(@RequestHeader("Authorization") header: String): Any {
        val grant=grants.authenticate(header)
        return mapOf("clientId" to grant.client,"scopes" to grant.scopes)
    }

    @PostMapping("/tools/{tool}")
    @Transactional
    fun run(@PathVariable tool: String,@RequestBody input: ObjectNode,@RequestHeader("Authorization") header: String,r: HttpServletRequest): JsonNode {
        val grant=grants.authenticate(header)
        val actor=grant.actor
        r.setAttribute("bankAgentActor",actor)
        r.setAttribute("bankAgentOperation","MCP:"+grant.id+":"+tool+":"+input.path("bankId").asText().take(36))
        fun id(key: String)=try { UUID.fromString(input.path(key).asText()) } catch(_: IllegalArgumentException) { invalid("/"+key) }
        val bank by lazy { id("bankId") }
        val page by lazy { PageSpec(input.path("page").asInt(1),input.path("pageSize").asInt(20)) }
        val keyword=input.get("keyword")?.asText()
        val body=input.path("input")
        fun mutate(action: ()->Any): JsonNode = commands.run(actor,id("idempotencyKey"),"MCP:"+grant.id+":"+tool+":"+input.path("bankId").asText(),input,JsonNode::class.java,r.requestId()) { json.valueToTree(action()) }
        val scope=when(tool) {
            "qanda_system_list_colleges","qanda_system_list_majors","qanda_system_list_subjects" -> "catalog:read"
            "qanda_system_save_college","qanda_system_save_major","qanda_system_save_subject" -> "catalog:write"
            "qanda_system_list_users","qanda_system_get_user" -> "users:read"
            "qanda_system_save_user_profile","qanda_system_set_user_status" -> "users:write"
            "qanda_system_list_test_accounts" -> "test_accounts:read"
            "qanda_system_create_test_account","qanda_system_disable_test_account" -> "test_accounts:write"
            "qanda_system_list_admins" -> "admins:read"
            "qanda_system_list_announcements" -> "announcements:read"
            "qanda_system_save_announcement" -> "announcements:write"
            "qanda_system_list_feedback","qanda_system_list_requests" -> "feedback:read"
            "qanda_system_handle_feedback","qanda_system_handle_request" -> "feedback:write"
            "qanda_system_get_dashboard" -> "operations:read"
            "qanda_system_get_security_policy" -> "security:read"
            "qanda_system_save_security_policy" -> "security:write"
            "qanda_system_list_audit" -> "audit:read"
            else -> "banks:read"
        }
        if(scope !in grant.scopes) forbidden()
        val target by lazy { input.get("id")?.let { id("id") } }
        val status=input.get("status")?.asText()
        val result: Any=when(tool) {
            "qanda_system_list_colleges" -> catalog.colleges(page,true,keyword,status)
            "qanda_system_list_majors" -> catalog.majors(target,page,true,keyword,status)
            "qanda_system_list_subjects" -> catalog.subjects(page,keyword,false)
            "qanda_system_save_college" -> mutate { catalog.college(target,json.treeToValue(body,CollegeInput::class.java)) }
            "qanda_system_save_major" -> mutate { catalog.major(target,json.treeToValue(body,MajorInput::class.java)) }
            "qanda_system_save_subject" -> mutate { catalog.subject(target,json.treeToValue(body,SubjectInput::class.java)) }
            "qanda_system_list_users" -> admin.listUsers(keyword,status,page)
            "qanda_system_get_user" -> admin.user(id("id"))
            "qanda_system_save_user_profile" -> mutate { admin.updateUserProfile(id("id"),json.treeToValue(body,AdminProfileInput::class.java)) }
            "qanda_system_set_user_status" -> mutate { admin.userStatus(id("id"),json.treeToValue(body,AccountStatusInput::class.java)) }
            "qanda_system_list_test_accounts" -> tests.list(keyword,status,page)
            "qanda_system_create_test_account" -> mutate { tests.create(json.treeToValue(body,TestAccountInput::class.java),actor.id) }
            "qanda_system_disable_test_account" -> mutate { tests.disable(id("id"),body.path("expectedVersion").asLong()) }
            "qanda_system_list_admins" -> admin.list(page)
            "qanda_system_list_announcements" -> announcements.announcements(actor,page)
            "qanda_system_save_announcement" -> mutate { announcements.saveAnnouncement(actor,target,json.treeToValue(body,AnnouncementInput::class.java)) }
            "qanda_system_list_feedback" -> operations.feedback(actor,status,page)
            "qanda_system_list_requests" -> operations.requests(actor,status,page)
            "qanda_system_handle_feedback" -> mutate { operations.handleFeedback(actor,id("id"),json.treeToValue(body,HandleInput::class.java)) }
            "qanda_system_handle_request" -> mutate { operations.handleRequest(id("id"),json.treeToValue(body,HandleInput::class.java)) }
            "qanda_system_get_dashboard" -> operations.dashboard()
            "qanda_system_get_security_policy" -> admin.policy()
            "qanda_system_save_security_policy" -> mutate { admin.policy(json.treeToValue(body,PolicyInput::class.java)) }
            "qanda_system_list_audit" -> admin.auditLogs(page,keyword,status)
            "qanda_list_courses" -> catalog.subjects(page,keyword,false)
            "qanda_list_banks" -> content.banks(actor,input.get("subjectId")?.let { id("subjectId") },keyword,page)
            "qanda_list_chapters" -> content.chapters(actor,bank)
            "qanda_list_questions" -> content.questions(actor,bank,input.get("chapterId")?.let { id("chapterId") },keyword,page)
            "qanda_get_question" -> portable(content.question(actor,id("questionId"),true))
            "qanda_get_bank" -> content.bank(actor,bank)
            "qanda_publication_checks" -> content.publicationChecks(actor,bank)
            "qanda_create_bank" -> {
                if("banks:write" !in grant.scopes) forbidden()
                mutate { content.saveBank(actor,null,json.treeToValue(body,BankInput::class.java)) }
            }
            "qanda_export_bank" -> { access.bank(actor,bank); transfer(grant,bank,"export") }
            else -> {
                write(grant,bank)
                when(tool) {
                    "qanda_create_question","qanda_update_question" -> mutate {
                        val wire=body.deepCopy<ObjectNode>()
                        val originals=listOf(body)+body.path("subQuestions").toList()
                        for(row in listOf(wire)+wire.path("subQuestions").map { it as ObjectNode }) row.remove(listOf("portableId","sources","provenance"))
                        val question=json.treeToValue(wire,QuestionInput::class.java)
                        if(question.questionBankId!=bank) invalid("/questionBankId")
                        val existing=if(tool=="qanda_update_question") id("questionId") else null
                        if(existing!=null && !input.path("confirmed").asBoolean()) invalid("/confirmed")
                        val prior=existing?.let { content.question(actor,it,true) }
                        val stableIds=prior?.let { (listOf(it)+it.subQuestions).map(QuestionView::id).toSet() }.orEmpty()
                        val saved=content.saveQuestion(actor,existing,question)
                        val view=content.question(actor,saved.id,true)
                        for((row,q) in originals.zip(listOf(view)+view.subQuestions)) {
                            val source=packageSource(json,row,row.get("sources") ?: body.path("sources"))
                            if(source!=null) jdbc.update("UPDATE question SET package_source=?::jsonb WHERE id=?",source.toString(),q.id)
                            row.get("portableId")?.let {
                                val portable=runCatching { UUID.fromString(it.asText()) }.getOrElse { invalid("/portableId") }
                                if(q.id !in stableIds) jdbc.update("UPDATE question SET portable_id=? WHERE id=?",portable,q.id)
                                else if(jdbc.queryForObject("SELECT portable_id FROM question WHERE id=?",UUID::class.java,q.id)!=portable) invalid("/portableId")
                            }
                        }
                        portable(view)
                    }
                    "qanda_save_chapter" -> mutate { content.saveChapter(actor,bank,input.get("chapterId")?.let { id("chapterId") },json.treeToValue(body,ChapterInput::class.java)) }
                    "qanda_reorder_chapters" -> mutate { content.reorder(actor,bank,json.treeToValue(body,ReorderInput::class.java)) }
                    "qanda_dissolve_chapter" -> mutate { content.dissolveChapter(actor,bank,id("chapterId"),json.treeToValue(body,DissolveChapterInput::class.java)) }
                    "qanda_delete_chapter" -> mutate { content.deleteChapter(actor,bank,id("chapterId"),input.path("expectedVersion").asLong()) }
                    "qanda_publish_bank" -> {
                        if("banks:publish" !in grant.scopes) forbidden()
                        mutate { content.publish(actor,bank,json.treeToValue(body,PublicationInput::class.java)) }
                    }
                    "qanda_upload_image" -> transfer(grant,bank,"image")
                    "qanda_upload_zip" -> transfer(grant,bank,"zip",uploads.start(actor,bank,input.path("sizeBytes").asLong()).uploadId)
                    "qanda_preview_import" -> importer.process(actor,bank,json.treeToValue(body,PackageRequest::class.java),false)
                    "qanda_commit_import" -> mutate { importer.process(actor,bank,json.treeToValue(body,PackageRequest::class.java),true) }
                    else -> missing()
                }
            }
        }
        return json.valueToTree(result)
    }

    private fun portable(view: QuestionView): ObjectNode {
        val result=json.valueToTree<ObjectNode>(view)
        for(row in listOf(result)+result.path("subQuestions").map { it as ObjectNode }) {
            jdbc.query("SELECT portable_id,package_source FROM question WHERE id=?", { rs ->
                row.put("portableId",rs.getString(1))
                rs.getString(2)?.let { row.setAll<ObjectNode>(json.readTree(it) as ObjectNode) }
                Unit
            },UUID.fromString(row.path("id").asText()))
        }
        return result
    }

    private fun transfer(grant: AgentGrant,bank: UUID,purpose: String,upload: UUID?=null): Any {
        val token=crypto.randomToken()
        jdbc.update("INSERT INTO bank_agent_transfer VALUES(?,?,?,?,?,now()+interval '10 minutes')",crypto.tokenDigest(token),grant.id,bank,purpose,upload)
        return mapOf("url" to grants.resource().removeSuffix("/mcp")+"/bank-agent/files/"+token,"uploadId" to upload,"chunkSize" to BankUploads.CHUNK)
    }

    @RequestMapping("/files/{token}",method=[RequestMethod.GET,RequestMethod.PUT])
    @Transactional(isolation=org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    fun file(@PathVariable token: String,@RequestParam(defaultValue="0") part: Int,r: HttpServletRequest,response: HttpServletResponse) {
        val row=jdbc.queryForList("SELECT * FROM bank_agent_transfer WHERE token_hash=? AND expires_at>now() FOR UPDATE",crypto.tokenDigest(token)).singleOrNull() ?: missing()
        val grant=grants.fromTransfer(row["grant_id"] as UUID)
        val bank=row["bank_id"] as UUID
        r.setAttribute("bankAgentActor",grant.actor)
        r.setAttribute("bankAgentOperation","MCP:"+grant.id+":"+row["purpose"]+":"+bank)
        response.setHeader("Cache-Control","no-store")
        when(row["purpose"]) {
            "export" -> {
                if(r.method!="GET") forbidden()
                response.contentType="application/zip"
                exporter.write(grant.actor,bank,response.outputStream)
            }
            else -> {
                if(r.method!="PUT") forbidden()
                write(grant,bank)
                val image=row["purpose"]=="image"
                val limit=if(image) 5*1024*1024 else BankUploads.CHUNK
                val data=r.inputStream.readNBytes(limit+1)
                if(data.size>limit) invalid("/file")
                if(image) {
                    val type=r.contentType.orEmpty()
                    val file=commands.run(grant.actor,UUID.nameUUIDFromBytes(crypto.tokenDigest(token)),"MCP:"+grant.id+":upload_image:"+bank,
                        listOf(type,java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(data))),
                        qanda.backend.platform.files.FileView::class.java,r.requestId()) { files.upload(grant.actor,bank,type,data) }
                    response.contentType="application/json"
                    json.writeValue(response.outputStream,file)
                } else {
                    uploads.put(grant.actor,bank,row["upload_id"] as UUID,part,data)
                    response.status=204
                }
            }
        }
    }
}
