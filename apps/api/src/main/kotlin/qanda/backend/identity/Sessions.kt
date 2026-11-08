package qanda.backend.identity

import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.admin.*
import qanda.backend.platform.http.forbidden
import qanda.backend.platform.security.Actor
import java.time.Clock
import java.util.UUID

@Service
class Sessions(private val sql: IdentityMapper, private val admins: AdminAccountMapper,
               private val policies: SecurityPolicyMapper, private val crypto: IdentityCrypto, private val clock: Clock) {
    private val userToken=Regex("u_[A-Za-z0-9_-]{43}")
    private val adminToken=Regex("a_[A-Za-z0-9_-]{43}")
    fun optional(): Actor? = SecurityContextHolder.getContext().authentication?.principal as? Actor
    fun current(): Actor = optional() ?: unauthenticated()
    fun student(): Actor = current().also { if(it.kind!="USER") forbidden() }
    fun studentOrGuest(): Actor? = optional()?.also { if(it.kind!="USER") forbidden() }
    fun admin(): Actor = current().also { if(it.kind!="ADMIN" || it.role!="SUPER_ADMIN") forbidden() }

    @Transactional
    fun authenticate(token: String): Actor {
        val now=clock.instant()
        val touchBefore=now.minusSeconds(30)
        return when {
            token.matches(userToken) -> {
                val session=sql.userSessionAccess(crypto.tokenDigest(token)) ?: unauthenticated()
                checkTestAccount(session.testExpiresAt?.let { TestAccountAccess(it,session.testDisabledAt) },now)
                if(session.revokedAt!=null || !session.expiresAt.isAfter(now) || session.status!="ACTIVE" || session.sessionCredentialVersion!=session.accountCredentialVersion) unauthenticated()
                if(session.lastSeenAt.isBefore(touchBefore)) sql.touchUserSession(session.id!!,now,touchBefore)
                Actor(session.userId!!,session.id!!,"USER","MINI_PROGRAM")
            }
            token.matches(adminToken) -> {
                val session=sql.adminSession(crypto.tokenDigest(token)) ?: unauthenticated()
                val admin=admins.selectById(session.adminId) ?: unauthenticated()
                val policy=policies.selectById(1)
                if(session.revokedAt!=null || !session.expiresAt.isAfter(now) || !session.lastSeenAt.plusSeconds(policy.sessionMinutes*60L).isAfter(now) || admin.status!="ACTIVE" || admin.role!="SUPER_ADMIN" || session.credentialVersion!=admin.credentialVersion) unauthenticated()
                if(session.lastSeenAt.isBefore(touchBefore)) sql.touchAdminSession(session.id!!,now,touchBefore)
                Actor(admin.id!!,session.id!!,"ADMIN","ADMIN_WEB",admin.role)
            }
            else -> unauthenticated()
        }
    }
    fun checkInTransaction(actor: Actor) {
        val now=clock.instant()
        if(actor.kind=="USER") {
            val user=sql.lockUser(actor.id) ?: unauthenticated();val session=sql.lockUserSession(actor.sessionId) ?: unauthenticated()
            checkTestAccount(sql.testAccountAccess(actor.id),now)
            if(user.status!="ACTIVE" || session.userId!=actor.id || session.revokedAt!=null || !session.expiresAt.isAfter(now) || session.credentialVersion!=user.credentialVersion) unauthenticated()
        } else {
            val admin=sql.lockAdmin(actor.id) ?: unauthenticated();val session=sql.lockAdminSession(actor.sessionId) ?: unauthenticated()
            if(admin.status!="ACTIVE" || admin.role!=actor.role || session.adminId!=actor.id || session.revokedAt!=null || !session.expiresAt.isAfter(now) || !session.lastSeenAt.plusSeconds(policies.selectById(1).sessionMinutes*60L).isAfter(now) || session.credentialVersion!=admin.credentialVersion) unauthenticated()
        }
    }
    @Transactional(readOnly=true,timeout=3)
    fun revalidate(actor: Actor) {
        if(actor.kind!="ADMIN") forbidden()
        val now=clock.instant();val admin=admins.selectById(actor.id) ?: unauthenticated();val session=sql.adminSessionById(actor.sessionId) ?: unauthenticated()
        if(admin.status!="ACTIVE" || admin.role!=actor.role || session.adminId!=actor.id || session.revokedAt!=null || !session.expiresAt.isAfter(now) || !session.lastSeenAt.plusSeconds(policies.selectById(1).sessionMinutes*60L).isAfter(now) || session.credentialVersion!=admin.credentialVersion) unauthenticated()
    }
}
