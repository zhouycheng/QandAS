package qanda.backend.identity

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.api.WechatCodeExchange
import qanda.backend.platform.http.invalid
import qanda.backend.platform.security.Actor
import qanda.backend.platform.security.requestId
import java.time.Clock
import java.time.Instant
import java.sql.Timestamp
import java.util.UUID

data class DeletionVerification(val challengeId: UUID?=null,val code: String?=null,val loginCode: String?=null)
data class DeletionProofView(val proof: String,val expiresAt: Instant)
data class DeleteAccountInput(val proof: String,val confirmed: Boolean)
data class DeletionResult(val completed: Boolean=true)

@Service
class AccountDeletion(private val jdbc: JdbcTemplate,private val identity: IdentityMapper,private val sessions: Sessions,
    private val crypto: IdentityCrypto,private val challenges: ChallengeService,private val wechat: WechatCodeExchange,
    private val tests: TestAccountMapper,private val clock: Clock) {
    fun verifyEmail(input: DeletionVerification) {
        input.challengeId?.let { challenges.verify(it,input.code ?: invalid("/code")) }
    }
    @Transactional
    fun prepare(actor: Actor,input: DeletionVerification): DeletionProofView {
        // Resolve the one-use provider code before taking the account write lock.
        val wx=input.code?.takeIf { input.challengeId==null && input.loginCode==null }?.let(wechat::exchange)
        sessions.checkInTransaction(actor)
        val user=identity.lockUser(actor.id) ?: unauthenticated()
        val session=identity.lockUserSession(actor.sessionId) ?: unauthenticated()
        when(session.authMethod) {
            "EMAIL" -> challenges.consume(input.challengeId ?: invalid("/challengeId"),"DELETE_ACCOUNT",actor.id)
            "WECHAT" -> if(wx==null || identity.wechat(wx.appId,wx.openId)?.userId!=actor.id) invalidProof()
            "TEST" -> if(!crypto.verifyTestLoginCode(input.loginCode ?: invalid("/loginCode"),tests.loginCodeHash(actor.id))) invalidProof()
            else -> invalidProof()
        }
        val proof=crypto.randomToken();val expires=clock.instant().plusSeconds(600)
        jdbc.update("INSERT INTO account_deletion_proof(token_digest,user_id,session_id,credential_version,expires_at) VALUES(?,?,?,?,?)",
            crypto.tokenDigest(proof),actor.id,actor.sessionId,user.credentialVersion,Timestamp.from(expires))
        return DeletionProofView(proof,expires)
    }
    @Transactional
    fun erase(input: DeleteAccountInput,key: UUID,requestId: UUID): DeletionResult {
        if(!input.confirmed) invalid("/confirmed")
        if(!input.proof.matches(Regex("[A-Za-z0-9_-]{43}"))) invalidProof()
        val digest=crypto.tokenDigest(input.proof)
        val initial=jdbc.queryForList("SELECT user_id FROM account_deletion_proof WHERE token_digest=?",digest).singleOrNull() ?: invalidProof()
        (initial["user_id"] as? UUID)?.let(identity::lockUser)
        val proof=jdbc.queryForList("SELECT * FROM account_deletion_proof WHERE token_digest=? FOR UPDATE",digest).singleOrNull() ?: invalidProof()
        if(!(proof["expires_at"] as Timestamp).toInstant().isAfter(clock.instant())) invalidProof()
        if(proof["completed_at"]!=null) {
            if(proof["command_id"]!=key) conflict("IDEMPOTENCY_CONFLICT","注销请求标识不一致")
            return DeletionResult()
        }
        val id=proof["user_id"] as UUID
        val actor=Actor(id,proof["session_id"] as UUID,"USER","MINI_PROGRAM")
        sessions.checkInTransaction(actor)
        val user=identity.lockUser(id) ?: invalidProof()
        if(user.credentialVersion!=(proof["credential_version"] as Number).toLong()) invalidProof()
        if(user.emailKey!=null) jdbc.queryForList("SELECT pg_advisory_xact_lock(hashtextextended(?,0))","mail:${user.emailKey}")
        jdbc.update("UPDATE user_account SET status='DELETING',credential_version=credential_version+1 WHERE id=?",id)
        identity.revokeUserSessions(id)
        jdbc.queryForObject("SELECT set_config('qanda.erasing_user',?,true)",String::class.java,id.toString())
        jdbc.update("UPDATE audit_log SET actor_user_id=NULL,operation=regexp_replace(operation,':'||?||'$', '') WHERE actor_user_id=? OR operation LIKE '%:'||?",id.toString(),id,id.toString())
        jdbc.update("DELETE FROM sync_command WHERE user_id=?",id)
        jdbc.update("DELETE FROM command_receipt WHERE actor_user_id=?",id)
        jdbc.update("DELETE FROM domain_event_outbox WHERE user_id=?",id)
        jdbc.update("DELETE FROM content_safety_callback WHERE trace_id IN (SELECT m.trace_id FROM content_safety_media m JOIN content_safety_request r ON r.id=m.request_id WHERE r.actor_id=? AND r.actor_kind='USER')",id)
        jdbc.update("DELETE FROM content_safety_media WHERE request_id IN (SELECT id FROM content_safety_request WHERE actor_id=? AND actor_kind='USER')",id)
        jdbc.update("DELETE FROM content_safety_request WHERE actor_id=? AND actor_kind='USER'",id)
        jdbc.update("DELETE FROM content_safety_context WHERE actor_id=? AND actor_kind='USER'",id)
        jdbc.update("DELETE FROM practice_result WHERE session_id IN (SELECT id FROM practice_session WHERE user_id=?)",id)
        jdbc.update("DELETE FROM practice_item_choice WHERE item_id IN (SELECT i.id FROM practice_item i JOIN practice_session s ON s.id=i.session_id WHERE s.user_id=?)",id)
        jdbc.update("DELETE FROM practice_item WHERE session_id IN (SELECT id FROM practice_session WHERE user_id=?)",id)
        jdbc.update("DELETE FROM practice_sync_state WHERE session_id IN (SELECT id FROM practice_session WHERE user_id=?)",id)
        jdbc.update("DELETE FROM practice_session WHERE user_id=?",id)
        for(table in listOf("user_favorite","question_feedback","course_request","announcement_recipient","user_activity","test_account","user_wechat")) {
            jdbc.update("DELETE FROM $table WHERE user_id=?",id)
        }
        jdbc.update("DELETE FROM session_presence WHERE session_id IN (SELECT id FROM user_session WHERE user_id=?)",id)
        jdbc.update("DELETE FROM user_session WHERE user_id=?",id)
        jdbc.update("DELETE FROM mail_delivery WHERE challenge_id IN (SELECT id FROM email_challenge WHERE user_id=? OR email_key=?)",id,user.emailKey)
        jdbc.update("DELETE FROM email_challenge WHERE user_id=? OR email_key=?",id,user.emailKey)
        jdbc.update("DELETE FROM account_deletion_proof WHERE user_id=? AND token_digest<>?",id,digest)
        jdbc.update("DELETE FROM user_account WHERE id=?",id)
        jdbc.update("INSERT INTO audit_log(id,operation,request_id,outcome) VALUES(?,'DELETE_ACCOUNT',?,'SUCCESS')",UUID.randomUUID(),requestId)
        jdbc.update("UPDATE account_deletion_proof SET user_id=NULL,session_id=NULL,credential_version=NULL,command_id=?,completed_at=now(),expires_at=? WHERE token_digest=?",
            key,Timestamp.from(clock.instant().plusSeconds(86400)),digest)
        return DeletionResult()
    }
}

@RestController
@RequestMapping("/api/v1",produces=["application/json"])
class AccountDeletionController(private val service: AccountDeletion,private val sessions: Sessions) {
    @PostMapping("/me/deletion-confirmations")
    fun prepare(@RequestBody input: DeletionVerification): DeletionProofView {
        val actor=sessions.student();service.verifyEmail(input);return service.prepare(actor,input)
    }
    @DeleteMapping("/me")
    fun erase(@RequestBody input: DeleteAccountInput,@RequestHeader("Idempotency-Key") key: UUID,request: jakarta.servlet.http.HttpServletRequest): DeletionResult=service.erase(input,key,request.requestId())
}
