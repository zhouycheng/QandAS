package qanda.backend.bankpackage

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.core.env.Environment
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.IdentityCrypto
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import qanda.backend.platform.security.Actor
import java.net.URI
import java.util.Base64
import java.util.UUID

data class AgentConsent(val clientId: String,val redirectUri: String,val resource: String,val scope: String,val challenge: String,val method: String)
data class AgentGrant(val id: UUID,val actor: Actor,val client: String,val scopes: Set<String>)

@RestController
class BankAgentGrants(private val jdbc: JdbcTemplate,private val sessions: Sessions,private val crypto: IdentityCrypto,
                      private val environment: Environment,private val json: ObjectMapper) {
    fun resource() = environment.getProperty("QANDA_MCP_RESOURCE","")
    @GetMapping("/bank-agent/resource")
    @io.swagger.v3.oas.annotations.Hidden
    fun protectedResource() = mapOf("resource" to resource())

    private val scopes=setOf("banks:read","banks:write","banks:publish",
        "catalog:read","catalog:write","users:read","users:write","test_accounts:read","test_accounts:write","admins:read","announcements:read","announcements:write","feedback:read","feedback:write","operations:read","security:read","security:write","audit:read")
    private fun validRedirect(value: String): Boolean {
        val uri=runCatching { URI(value) }.getOrNull() ?: return false
        return value.length<=2048 && uri.host!=null && uri.fragment==null && uri.userInfo==null &&
            (uri.scheme=="https" || uri.scheme=="http" && uri.host in setOf("127.0.0.1","[::1]","localhost"))
    }

    @Transactional
    @ResponseStatus(org.springframework.http.HttpStatus.CREATED)
    @PostMapping("/bank-agent/register")
    @io.swagger.v3.oas.annotations.Hidden
    fun register(@RequestBody metadata: com.fasterxml.jackson.databind.JsonNode): Any {
        val redirects=metadata.path("redirect_uris")
        if(resource().isBlank() || !redirects.isArray || redirects.size() !in 1..8 || redirects.any { !it.isTextual || !validRedirect(it.asText()) } ||
            metadata.path("token_endpoint_auth_method").asText("none")!="none") invalid("/client")
        val name=name(metadata.path("client_name").asText("MCP Agent"),120)
        jdbc.execute("SELECT pg_advisory_xact_lock(hashtext('bank-agent-registration'))")
        if((jdbc.queryForObject("SELECT count(*) FROM bank_agent_client WHERE created_at>now()-interval '1 hour'",Long::class.java) ?: 0)>500)
            throw ApiException(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS,"REGISTRATION_LIMIT","客户端注册频繁，请稍后重试")
        val id=UUID.randomUUID()
        jdbc.update("INSERT INTO bank_agent_client(id,name,redirects) VALUES(?,?,?::jsonb)",id,name,redirects.toString())
        return mapOf("client_id" to id,"client_name" to name,"redirect_uris" to redirects,"token_endpoint_auth_method" to "none",
            "grant_types" to listOf("authorization_code"),"response_types" to listOf("code"))
    }

    @GetMapping(value=["/api/v1/admin/bank-agents"],produces=["application/json"])
    fun grants(): Any {
        val actor=sessions.admin()
        return mapOf("resource" to resource(),"agents" to jdbc.queryForList("SELECT id,client_id AS client,scope,expires_at FROM bank_agent_grant WHERE admin_id=? AND revoked_at IS NULL AND expires_at>now() ORDER BY expires_at DESC",actor.id))
    }

    @DeleteMapping("/api/v1/admin/bank-agents/{id}")
    @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
    fun revoke(@PathVariable id: UUID) {
        jdbc.update("UPDATE bank_agent_grant SET revoked_at=now() WHERE id=? AND admin_id=?",id,sessions.admin().id)
    }

    @Transactional
    @PostMapping(value=["/api/v1/admin/bank-agents/authorize"],produces=["application/json"])
    fun authorize(@RequestBody consent: AgentConsent): Map<String,String> {
        val actor=sessions.admin()
        sessions.checkInTransaction(actor)
        val registered=runCatching { UUID.fromString(consent.clientId) }.getOrNull()?.let { id ->
            jdbc.queryForList("SELECT redirects::text FROM bank_agent_client WHERE id=?",String::class.java,id).singleOrNull()
        }
        val client=registered?.let(json::readTree) ?: json.readTree(environment.getProperty("QANDA_MCP_CLIENTS","{}")).path(consent.clientId)
        if (!client.isArray || client.none { it.asText()==consent.redirectUri }) invalid("/redirectUri")
        if(!validRedirect(consent.redirectUri)) invalid("/redirectUri")
        if(resource().isBlank() || resource()!=consent.resource) invalid("/resource")
        if(consent.method!="S256" || !consent.challenge.matches(Regex("[A-Za-z0-9_-]{43}"))) invalid("/codeChallenge")
        val selected=consent.scope.split(" ").toSet()
        if(!scopes.containsAll(selected) || (selected.any { it.startsWith("banks:") } && "banks:read" !in selected) || "banks:publish" in selected && "banks:write" !in selected) invalid("/scope")
        val code=crypto.randomToken()
        jdbc.update("INSERT INTO bank_agent_grant(id,admin_id,session_id,client_id,redirect_uri,resource,scope,challenge,code_hash,expires_at) VALUES(?,?,?,?,?,?,?,?,?,now()+interval '3 minutes')",
            UUID.randomUUID(),actor.id,actor.sessionId,consent.clientId,consent.redirectUri,consent.resource,consent.scope,consent.challenge,crypto.tokenDigest(code))
        return mapOf("code" to code)
    }

    @Transactional
    @PostMapping("/bank-agent/token",consumes=["application/x-www-form-urlencoded"])
    @io.swagger.v3.oas.annotations.Hidden
    fun token(@RequestParam params: Map<String,String>): Map<String,Any> {
        val verifier=params["code_verifier"].orEmpty()
        if(params["grant_type"]!="authorization_code" || !verifier.matches(Regex("[A-Za-z0-9._~-]{43,128}"))) invalid("/grant")
        val challenge=Base64.getUrlEncoder().withoutPadding().encodeToString(crypto.tokenDigest(verifier))
        val token=crypto.randomToken()
        val changed=jdbc.update("UPDATE bank_agent_grant SET code_hash=NULL,token_hash=?,expires_at=now()+interval '1 hour' WHERE code_hash=? AND client_id=? AND redirect_uri=? AND resource=? AND resource=? AND challenge=? AND expires_at>now() AND revoked_at IS NULL",
            crypto.tokenDigest(token),crypto.tokenDigest(params["code"].orEmpty()),params["client_id"],params["redirect_uri"],params["resource"],resource(),challenge)
        if(changed!=1) invalid("/grant")
        val grant=authenticate("Bearer "+token)
        return mapOf("access_token" to token,"token_type" to "Bearer","expires_in" to 3600,"scope" to grant.scopes.joinToString(" "))
    }

    fun authenticate(header: String): AgentGrant {
        if(!header.matches(Regex("Bearer [A-Za-z0-9_-]{43}"))) unauthorized()
        return active("token_hash=?",crypto.tokenDigest(header.substring(7)))
    }

    fun fromTransfer(id: UUID) = active("id=?",id)

    private fun active(predicate: String,value: Any): AgentGrant {
        val grant=jdbc.query("SELECT id,admin_id,session_id,client_id,scope FROM bank_agent_grant WHERE $predicate AND resource=? AND revoked_at IS NULL AND expires_at>now() FOR SHARE",
            { r,_ -> AgentGrant(r.getObject(1,UUID::class.java),Actor(r.getObject(2,UUID::class.java),r.getObject(3,UUID::class.java),"ADMIN","MCP","SUPER_ADMIN"),r.getString(4),r.getString(5).split(" ").toSet()) },value,resource()).singleOrNull()
            ?: unauthorized()
        sessions.checkInTransaction(grant.actor)
        return grant
    }
    private fun unauthorized(): Nothing = throw ApiException(org.springframework.http.HttpStatus.UNAUTHORIZED,"INVALID_TOKEN","Agent 授权无效或已到期")
}
