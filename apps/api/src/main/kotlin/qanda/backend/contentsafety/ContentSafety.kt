package qanda.backend.contentsafety

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import org.springframework.core.env.Environment
import org.springframework.http.HttpStatus
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import qanda.backend.identity.*
import qanda.backend.identity.api.WechatCodeExchange
import qanda.backend.catalog.*
import qanda.backend.content.*
import qanda.backend.operations.*
import qanda.backend.announcements.AnnouncementInput
import qanda.backend.platform.files.*
import qanda.backend.platform.http.*
import qanda.backend.platform.http.conflict
import qanda.backend.platform.http.invalid
import qanda.backend.platform.security.Actor
import java.sql.Timestamp
import java.time.Clock
import java.time.Instant
import java.util.Base64
import java.util.UUID

data class SafetyContextView(val id: UUID,val expiresAt: Instant)
data class SafetyInput(val operation: String="",val payload: JsonNode,val contextId: UUID?=null,val method: String?=null,val path: String?=null,val contentType: String?=null)
data class SafetyView(val id: UUID,val state: String,val expiresAt: Instant,val confirmationToken: String?=null,val errorCode: String?=null)
data class SafetyInvitation(val title: String,val preview: List<String>,val expiresAt: Instant)

@Service
class ContentSafety(private val jdbc: JdbcTemplate,private val json: ObjectMapper,private val sessions: Sessions,
    private val crypto: IdentityCrypto,private val wechat: WechatCodeExchange,private val checks: WechatContentChecks,
    private val files: FileService,private val environment: Environment,private val clock: Clock,manager: PlatformTransactionManager): qanda.backend.platform.security.ContentMutationGuard {
    private val tx=TransactionTemplate(manager)
    private val log=org.slf4j.LoggerFactory.getLogger(javaClass)
    private val textFields=setOf("nickname","name","subject","title","summary","description","textbook","stem","explanation","content","referenceAnswer","answers","scoringPoints","passage","body","response","courseName")
    fun required(operation: String,input: Any): Boolean = type(operation)!=null &&
        (operation.substringBefore(':')!="PUBLISH_BANK" || json.valueToTree<JsonNode>(input).path("status").asText()=="PUBLISHED")
    private fun type(operation: String): Class<*>?=when(operation.substringBefore(':')) {
        "UPDATE_PROFILE" -> ProfileInput::class.java
        "UPDATE_USER_PROFILE" -> AdminProfileInput::class.java
        "CREATE_COLLEGE","UPDATE_COLLEGE" -> CollegeInput::class.java
        "CREATE_MAJOR","UPDATE_MAJOR" -> MajorInput::class.java
        "CREATE_SUBJECT","UPDATE_SUBJECT" -> SubjectInput::class.java
        "CREATE_BANK","UPDATE_BANK" -> BankInput::class.java
        "CREATE_CHAPTER","UPDATE_CHAPTER" -> ChapterInput::class.java
        "CREATE_QUESTION","UPDATE_QUESTION" -> QuestionInput::class.java
        "IMPORT_QUESTIONS" -> ImportInput::class.java
        "PUBLISH_BANK" -> PublicationInput::class.java
        "CREATE_ANNOUNCEMENT","UPDATE_ANNOUNCEMENT" -> AnnouncementInput::class.java
        "SUBMIT_FEEDBACK" -> FeedbackInput::class.java
        "REQUEST_COURSE" -> CourseRequestInput::class.java
        "HANDLE_FEEDBACK","HANDLE_REQUEST" -> HandleInput::class.java
        "COMMUNITY_GROUP" -> CommunityGroupInput::class.java
        "EXCEL_IMPORT" -> JsonNode::class.java
        else -> null
    }
    fun context(actor: Actor,code: String): SafetyContextView {
        val identity=wechat.exchange(code)
        val id=UUID.randomUUID();val expires=clock.instant().plusSeconds(300)
        tx.executeWithoutResult {
            sessions.checkInTransaction(actor)
            jdbc.update("INSERT INTO content_safety_context(id,actor_id,session_id,actor_kind,app_id,open_id,expires_at) VALUES(?,?,?,?,?,?,?)",
                id,actor.id,actor.sessionId,actor.kind,identity.appId,identity.openId,Timestamp.from(expires))
        }
        return SafetyContextView(id,expires)
    }
    private fun canonical(value: JsonNode): JsonNode = when {
        value.isObject -> json.createObjectNode().also { result -> value.fieldNames().asSequence().sorted().forEach { result.set<JsonNode>(it,canonical(value[it])) } }
        value.isArray -> json.createArrayNode().also { result -> value.forEach { result.add(canonical(it)) } }
        else -> value
    }
    private fun material(actor: Actor,operation: String,payload: JsonNode): ObjectNode {
        val dto=type(operation) ?: invalid("/operation")
        val input=try { json.valueToTree<JsonNode>(json.treeToValue(payload,dto)) } catch(_: Exception) { invalid("/payload") }
        val result=json.createObjectNode().set<JsonNode>("input",input) as ObjectNode
        if(operation.startsWith("PUBLISH_BANK:")) {
            if(actor.kind!="ADMIN") forbidden()
            val bank=runCatching { UUID.fromString(operation.substringAfter(':')) }.getOrElse { invalid("/operation") }
            val metadata=jdbc.queryForList("SELECT name,description,textbook,version,content_version FROM question_bank WHERE id=?",bank).singleOrNull() ?: missing()
            val questions=jdbc.queryForList("SELECT q.id::text,q.version,r.stem,r.explanation,r.reference_answer AS \"referenceAnswer\",r.content_data FROM question q JOIN question_revision r ON r.id=q.current_revision_id WHERE q.bank_id=? AND question_active(q.id) ORDER BY q.id",bank)
                .map { row -> row.toMutableMap().apply { this["contentData"]=json.readTree(remove("content_data") as String) } }
            val options=jdbc.queryForList("SELECT o.content FROM question_option o JOIN question q ON q.current_revision_id=o.revision_id WHERE q.bank_id=? AND question_active(q.id) ORDER BY q.id,o.sort_order",bank)
            val assets=jdbc.queryForList("SELECT DISTINCT a.file_id FROM question_attachment a JOIN question q ON q.current_revision_id=a.revision_id WHERE q.bank_id=? AND question_active(q.id) ORDER BY a.file_id",UUID::class.java,bank)
            result.set<JsonNode>("snapshot",json.valueToTree(mapOf("bank" to metadata,"questions" to questions,"options" to options,"assetIds" to assets)))
        }
        return canonical(result) as ObjectNode
    }
    private fun digest(value: JsonNode)=crypto.tokenDigest(json.writeValueAsString(canonical(value)))
    fun prepare(actor: Actor,input: SafetyInput): SafetyView {
        if(input.method!=null || input.path!=null) return prepare(actor,input.copy(operation=ContentMutations.operation(input.method ?: "",input.path ?: "",input.contentType) ?: invalid("/path"),method=null,path=null))
        if(input.operation.startsWith("EXCEL_IMPORT:")) forbidden()
        return create(actor,input,emptyList())
    }
    fun prepareImport(actor: Actor,kind: String,payload: JsonNode,images: List<ByteArray>): SafetyView {
        if(actor.kind!="ADMIN" || kind !in setOf("users","banks")) forbidden()
        return create(actor,SafetyInput("EXCEL_IMPORT:$kind",payload),images)
    }
    private fun create(actor: Actor,input: SafetyInput,images: List<ByteArray>): SafetyView {
        if(input.operation.length>200 || !required(input.operation,input.payload)) invalid("/operation")
        if(actor.kind=="USER" && input.operation !in setOf("UPDATE_PROFILE","SUBMIT_FEEDBACK","REQUEST_COURSE")) forbidden()
        val value=material(actor,input.operation,input.payload)
        fun validateMedia(node: JsonNode,field: String="") {
            when {
                node.isObject -> node.fields().forEachRemaining { validateMedia(it.value,it.key) }
                node.isArray -> node.forEach { validateMedia(it,field) }
                node.isTextual && field=="avatar" -> profileAvatar(node.asText())
                node.isTextual && field=="image" -> {
                    val uri=node.asText()
                    val bytes=try { Base64.getDecoder().decode(uri.substringAfter(',')) } catch(_: Exception) { invalid("/payload/image") }
                    ImageNormalizer.normalize(bytes,ImageLimits(uri.substringBefore(';').substringAfter("data:")))
                }
            }
        }
        validateMedia(value)
        if(json.writeValueAsBytes(value).size>8*1024*1024) invalid("/payload")
        val id=UUID.randomUUID();val confirmation=if(actor.kind=="ADMIN") crypto.randomToken() else null
        val expires=clock.instant().plusSeconds(1800)
        tx.executeWithoutResult {
            sessions.checkInTransaction(actor)
            if(actor.kind=="USER") checkContext(actor,input.contextId ?: invalid("/contextId"))
            jdbc.update("INSERT INTO content_safety_request(id,actor_id,session_id,actor_kind,operation,payload_json,payload_digest,context_id,confirmation_digest,state,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                id,actor.id,actor.sessionId,actor.kind,input.operation,json.writeValueAsString(value),digest(value),input.contextId,
                confirmation?.let(crypto::tokenDigest),if(confirmation==null) "CHECKING" else "WAITING_CONFIRMATION",Timestamp.from(expires))
            images.forEach { bytes ->
                jdbc.update("INSERT INTO content_safety_media(id,request_id,data,media_type,sha256,fetch_digest,fetch_expires_at,state) VALUES(?,?,?,'image/png',?,?,now(),'PENDING')",
                    UUID.randomUUID(),id,bytes,java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes)),crypto.tokenDigest(crypto.randomToken()))
            }
        }
        return view(actor,id).copy(confirmationToken=confirmation)
    }
    private fun checkContext(actor: Actor,id: UUID): Map<String,Any> {
        val row=jdbc.queryForList("SELECT * FROM content_safety_context WHERE id=? AND actor_id=? AND session_id=? AND actor_kind=? AND expires_at>now()",id,actor.id,actor.sessionId,actor.kind).singleOrNull() ?: conflict("CONTENT_CONTEXT_EXPIRED","请重新获取微信内容检查凭证")
        return row
    }
    private fun renewWorker(id: UUID,workerToken: UUID) {
        if(jdbc.update("UPDATE content_safety_request SET worker_heartbeat_at=now() WHERE id=? AND state='RUNNING' AND worker_token=?",id,workerToken)!=1)
            throw ApiException(HttpStatus.CONFLICT,"CONTENT_CHECK_INTERRUPTED","内容检查任务已转交处理")
    }
    fun confirm(id: UUID,token: String,code: String): SafetyView {
        if(!token.matches(Regex("[A-Za-z0-9_-]{43}"))) invalid("/token")
        val row=jdbc.queryForList("SELECT * FROM content_safety_request WHERE id=?",id).singleOrNull() ?: missing()
        if(row["actor_kind"]!="ADMIN" || row["state"]!="WAITING_CONFIRMATION" || !(row["expires_at"] as Timestamp).toInstant().isAfter(clock.instant()) ||
            !crypto.matches(crypto.tokenDigest(token),row["confirmation_digest"] as ByteArray)) conflict("CONTENT_CONFIRMATION_INVALID","确认请求已失效")
        val actor=Actor(row["actor_id"] as UUID,row["session_id"] as UUID,"ADMIN","MINI_PROGRAM", "SUPER_ADMIN")
        val context=context(actor,code)
        val changed=jdbc.update("UPDATE content_safety_request SET context_id=?,confirmation_digest=NULL,state='CHECKING' WHERE id=? AND state='WAITING_CONFIRMATION'",context.id,id)
        if(changed!=1) conflict("CONTENT_CONFIRMATION_INVALID","确认请求已使用")
        return view(actor,id)
    }
    fun invitation(id: UUID,token: String): SafetyInvitation {
        if(!token.matches(Regex("[A-Za-z0-9_-]{43}"))) invalid("/token")
        val row=jdbc.queryForList("SELECT * FROM content_safety_request WHERE id=? AND actor_kind='ADMIN' AND state='WAITING_CONFIRMATION' AND expires_at>now()",id).singleOrNull() ?: missing()
        if(!crypto.matches(crypto.tokenDigest(token),row["confirmation_digest"] as ByteArray)) missing()
        tx.executeWithoutResult { sessions.checkInTransaction(Actor(row["actor_id"] as UUID,row["session_id"] as UUID,"ADMIN","MINI_PROGRAM","SUPER_ADMIN")) }
        val preview=mutableListOf<String>()
        fun visit(node: JsonNode,field: String="") {
            if(preview.size>=20) return
            when {
                node.isObject -> node.fields().forEachRemaining { visit(it.value,it.key) }
                node.isArray -> node.forEach { visit(it,field) }
                node.isTextual && field in textFields && node.asText().isNotBlank() -> preview+=node.asText().take(1000)
            }
        }
        visit(json.readTree(row["payload_json"] as String))
        return SafetyInvitation("确认本次内容检查",preview,(row["expires_at"] as Timestamp).toInstant())
    }
    private fun inspect(id: UUID,actor: Actor,contextId: UUID,workerToken: UUID) {
        try {
            renewWorker(id,workerToken)
            val context=checkContext(actor,contextId)
            val row=jdbc.queryForMap("SELECT * FROM content_safety_request WHERE id=?",id)
            val value=json.readTree(row["payload_json"] as String)
            val scene=if(row["operation"]=="UPDATE_PROFILE") 1 else 2
            fun visit(node: JsonNode,field: String="") {
                when {
                    node.isObject -> node.fields().forEachRemaining { visit(it.value,it.key) }
                    node.isArray -> node.forEach { visit(it,field) }
                    node.isTextual && field in textFields -> {
                        val text=node.asText();var offset=0
                        while(offset<text.length) {
                            if(!(row["expires_at"] as Timestamp).toInstant().isAfter(clock.instant())) conflict("CONTENT_CONTEXT_EXPIRED","检查已超时，请重试")
                            val end=text.offsetByCodePoints(offset,minOf(500,text.codePointCount(offset,text.length)))
                            renewWorker(id,workerToken)
                            checks.text(context["open_id"] as String,text.substring(offset,end),scene);offset=end
                        }
                    }
                }
            }
            visit(value)
            val images=mutableListOf<Pair<ByteArray,String>>()
            val storedMedia=jdbc.queryForList("SELECT id,data,media_type,sha256,trace_id FROM content_safety_media WHERE request_id=?",id)
            val knownHashes=storedMedia.map { it["sha256"] as String }.toMutableSet()
            val pendingMedia=storedMedia.filter { it["trace_id"]==null }.toMutableList()
            fun media(node: JsonNode,field: String="") {
                if(node.isObject) node.fields().forEachRemaining { media(it.value,it.key) }
                else if(node.isArray && field=="assetIds" && !(row["operation"] as String).startsWith("EXCEL_IMPORT:")) node.forEach { images+=files.read(actor,UUID.fromString(it.asText())) to "image/png" }
                else if(node.isArray) node.forEach { media(it,field) }
                else if(node.isTextual && field in setOf("avatar","image")) {
                    val uri=node.asText();if(field=="avatar") profileAvatar(uri)
                    val contentType=uri.substringBefore(';').substringAfter("data:")
                    val bytes=try { Base64.getDecoder().decode(uri.substringAfter(",")) } catch(_: Exception) { invalid("/payload/$field") }
                    val image=ImageNormalizer.normalize(bytes,ImageLimits(contentType));images+=image.bytes to "image/png"
                }
            }
            media(value)
            if((row["operation"] as String).startsWith("UPLOAD_IMAGE:")) {
                val bytes=value["input"].binaryValue()
                val normalized=ImageNormalizer.normalize(bytes,ImageLimits((row["operation"] as String).substringAfterLast(':')))
                images+=normalized.bytes to "image/png"
            }
            images.distinctBy { java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(it.first)) }.forEach { (bytes,contentType) ->
                val hash=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes))
                if(knownHashes.add(hash)) {
                    val mediaId=UUID.randomUUID();val fetch=crypto.randomToken()
                    jdbc.update("INSERT INTO content_safety_media(id,request_id,data,media_type,sha256,fetch_digest,fetch_expires_at,state) VALUES(?,?,?,?,?,?,?,'PENDING')",
                        mediaId,id,bytes,contentType,hash,crypto.tokenDigest(fetch),Timestamp.from(clock.instant().plusSeconds(600)))
                    pendingMedia+=mapOf("id" to mediaId,"data" to bytes,"media_type" to contentType,"sha256" to hash)
                }
            }
            if(pendingMedia.isNotEmpty()) {
                val base=environment.getProperty("BACKEND_CONTENT_SAFETY_PUBLIC_BASE_URL")?.trimEnd('/') ?: throw ApiException(HttpStatus.SERVICE_UNAVAILABLE,"CONTENT_SAFETY_UNAVAILABLE","内容检查地址尚未配置")
                val uri=runCatching { java.net.URI(base) }.getOrElse { invalid("/mediaUrl") }
                if(uri.scheme!="https" || uri.host==null || uri.userInfo!=null || uri.query!=null || uri.fragment!=null) invalid("/mediaUrl")
                pendingMedia.forEach { item ->
                    val mediaId=item["id"] as UUID;val fetch=crypto.randomToken()
                    renewWorker(id,workerToken)
                    jdbc.update("UPDATE content_safety_media SET fetch_digest=?,fetch_expires_at=? WHERE id=? AND trace_id IS NULL",
                        crypto.tokenDigest(fetch),Timestamp.from(clock.instant().plusSeconds(600)),mediaId)
                    val trace=checks.media(context["open_id"] as String,base+"/api/v1/content-safety/media/$mediaId?token=$fetch",scene)
                    renewWorker(id,workerToken)
                    if(jdbc.update("UPDATE content_safety_media SET trace_id=? WHERE id=? AND trace_id IS NULL",trace.traceId,mediaId)!=1)
                        conflict("CONTENT_CHECK_INTERRUPTED","内容检查任务已转交处理")
                }
            }
            tx.executeWithoutResult {
                sessions.checkInTransaction(actor)
                if(jdbc.update("UPDATE content_safety_request SET state='PENDING',worker_token=NULL,worker_heartbeat_at=NULL WHERE id=? AND state='RUNNING' AND worker_token=? AND expires_at>now()",id,workerToken)==1) settle(id)
            }
        } catch(error: Exception) {
            log.warn("Content check failed: request={}, exception={}, code={}, location={}",id,error.javaClass.simpleName,(error as? ApiException)?.code,error.stackTrace.firstOrNull())
            jdbc.update("UPDATE content_safety_request SET state='REJECTED',error_code=?,worker_token=NULL,worker_heartbeat_at=NULL WHERE id=? AND state='RUNNING' AND worker_token=?",(error as? ApiException)?.code ?: "CONTENT_SAFETY_UNAVAILABLE",id,workerToken)
            if(error is ApiException) throw error
            throw ApiException(HttpStatus.SERVICE_UNAVAILABLE,"CONTENT_SAFETY_UNAVAILABLE","内容检查暂时不可用，请稍后重试")
        }
    }
    private fun settle(id: UUID) {
        jdbc.update("UPDATE content_safety_media m SET state=CASE WHEN c.suggest='pass' THEN 'PASSED' ELSE 'REJECTED' END FROM content_safety_callback c WHERE m.trace_id=c.trace_id AND m.request_id=? AND m.state='PENDING'",id)
        jdbc.update("UPDATE content_safety_request r SET state=CASE WHEN EXISTS(SELECT 1 FROM content_safety_media m WHERE m.request_id=r.id AND m.state='REJECTED') THEN 'REJECTED' WHEN NOT EXISTS(SELECT 1 FROM content_safety_media m WHERE m.request_id=r.id AND m.state='PENDING') THEN 'PASSED' ELSE 'PENDING' END WHERE r.id=? AND r.state='PENDING' AND r.expires_at>now()",id)
    }
    fun callback(trace: String,suggest: String) {
        if(trace.length !in 1..128) invalid("/trace_id")
        tx.executeWithoutResult {
            jdbc.update("INSERT INTO content_safety_callback(trace_id,suggest) VALUES(?,?) ON CONFLICT(trace_id) DO UPDATE SET suggest=CASE WHEN content_safety_callback.suggest=excluded.suggest THEN excluded.suggest ELSE 'risky' END",trace,if(suggest=="pass") "pass" else "risky")
            jdbc.queryForList("SELECT request_id FROM content_safety_media WHERE trace_id=?",UUID::class.java,trace).forEach(::settle)
        }
    }
    fun view(actor: Actor,id: UUID): SafetyView {
        val row=jdbc.queryForList("SELECT * FROM content_safety_request WHERE id=? AND actor_id=? AND session_id=? AND actor_kind=?",id,actor.id,actor.sessionId,actor.kind).singleOrNull() ?: missing()
        val expires=(row["expires_at"] as Timestamp).toInstant()
        return SafetyView(id,if(expires.isAfter(clock.instant())) row["state"] as String else "EXPIRED",expires,errorCode=row["error_code"] as? String)
    }
    override fun consume(actor: Actor,operation: String,input: Any,id: UUID?) {
        if(!required(operation,input)) return
        if(id==null) conflict("CONTENT_CHECK_REQUIRED","请先完成内容检查")
        if(operation.startsWith("PUBLISH_BANK:") || operation.startsWith("IMPORT_QUESTIONS:")) {
            // Serialize the checked snapshot with every revision change before recomputing its digest.
            jdbc.queryForList("SELECT id FROM question_bank WHERE id=? FOR UPDATE",UUID.fromString(operation.substringAfter(':')))
        }
        val row=jdbc.queryForList("SELECT * FROM content_safety_request WHERE id=? FOR UPDATE",id).singleOrNull() ?: conflict("CONTENT_CHECK_REQUIRED","请重新检查内容")
        if(row["actor_id"]!=actor.id || row["session_id"]!=actor.sessionId || row["actor_kind"]!=actor.kind || row["operation"]!=operation || row["state"]!="PASSED" || !(row["expires_at"] as Timestamp).toInstant().isAfter(clock.instant()) ||
            !crypto.matches(row["payload_digest"] as ByteArray,digest(material(actor,operation,json.valueToTree(input))))) conflict("CONTENT_CHECK_STALE","内容或账号状态已变化，请重新检查")
        jdbc.update("UPDATE content_safety_request SET state='CONSUMED',consumed_at=now() WHERE id=?",id)
    }
    fun media(id: UUID,token: String): Pair<ByteArray,String> {
        val row=jdbc.queryForList("SELECT m.*,r.actor_id,r.session_id,r.actor_kind FROM content_safety_media m JOIN content_safety_request r ON r.id=m.request_id WHERE m.id=? AND m.fetch_expires_at>now() AND r.state IN ('CHECKING','RUNNING','PENDING') AND r.expires_at>now()",id).singleOrNull() ?: missing()
        if(!crypto.matches(row["fetch_digest"] as ByteArray,crypto.tokenDigest(token))) missing()
        tx.executeWithoutResult { sessions.checkInTransaction(Actor(row["actor_id"] as UUID,row["session_id"] as UUID,row["actor_kind"] as String,"MINI_PROGRAM",if(row["actor_kind"]=="ADMIN") "SUPER_ADMIN" else null)) }
        return (row["data"] as ByteArray) to (row["media_type"] as String)
    }
    @Scheduled(fixedDelayString="\${qanda.backend.content-safety.poll-delay-ms:1000}")
    fun tick() {
        if(environment.getProperty("qanda.backend.role","api") !in setOf("worker","all")) return
        tx.executeWithoutResult {
            jdbc.update("UPDATE content_safety_request SET state='EXPIRED',payload_json='{}',confirmation_digest=NULL,worker_token=NULL,worker_heartbeat_at=NULL WHERE expires_at<=now() AND state<>'EXPIRED'")
            jdbc.update("UPDATE content_safety_request SET state='CHECKING',worker_token=NULL,worker_heartbeat_at=NULL WHERE state='RUNNING' AND worker_heartbeat_at<now()-interval '60 seconds' AND expires_at>now()")
            jdbc.update("DELETE FROM content_safety_media WHERE request_id IN (SELECT id FROM content_safety_request WHERE expires_at<=now())")
            jdbc.update("DELETE FROM content_safety_request WHERE expires_at<now()-interval '1 day'")
            jdbc.update("DELETE FROM content_safety_context WHERE expires_at<now() AND NOT EXISTS(SELECT 1 FROM content_safety_request WHERE context_id=content_safety_context.id)")
            jdbc.update("DELETE FROM content_safety_callback WHERE received_at<now()-interval '1 day'")
            jdbc.update("DELETE FROM account_deletion_proof WHERE expires_at<now()")
        }
        val pending=tx.execute {
            jdbc.queryForList("SELECT * FROM content_safety_request WHERE state='CHECKING' AND expires_at>now() ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED").singleOrNull()?.let {
                val workerToken=UUID.randomUUID()
                jdbc.update("UPDATE content_safety_request SET state='RUNNING',worker_token=?,worker_heartbeat_at=now() WHERE id=?",workerToken,it["id"])
                it + ("worker_token" to workerToken)
            }
        } ?: return
        val actor=Actor(pending["actor_id"] as UUID,pending["session_id"] as UUID,pending["actor_kind"] as String,"MINI_PROGRAM",if(pending["actor_kind"]=="ADMIN") "SUPER_ADMIN" else null)
        try { inspect(pending["id"] as UUID,actor,pending["context_id"] as UUID,pending["worker_token"] as UUID) } catch(_: ApiException) { /* The request records the failure for an explicit retry. */ }
    }
}
