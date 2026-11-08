package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.http.HttpStatus
import qanda.backend.admin.AdminAccountMapper
import qanda.backend.admin.SecurityPolicyMapper
import qanda.backend.identity.*
import qanda.backend.platform.http.ApiException
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID

class SessionsTest {
    private val now=Instant.parse("2026-11-09T00:00:00Z")
    private val token="u_"+"a".repeat(43)
    private val digest=ByteArray(32)
    private val sql=mock(IdentityMapper::class.java)
    private val crypto=mock(IdentityCrypto::class.java).also { `when`(it.tokenDigest(token)).thenReturn(digest) }
    private val sessions=Sessions(sql,mock(AdminAccountMapper::class.java),mock(SecurityPolicyMapper::class.java),crypto,Clock.fixed(now,ZoneOffset.UTC))
    private fun access()=UserSessionAccess().apply {
        id=UUID.randomUUID();userId=UUID.randomUUID();expiresAt=now.plusSeconds(600);lastSeenAt=now
        sessionCredentialVersion=1;accountCredentialVersion=1;status="ACTIVE"
    }

    @Test fun `student authorization is reread on every request without redundant touches`() {
        val row=access();`when`(sql.userSessionAccess(digest)).thenReturn(row)
        repeat(2) { assertEquals(row.userId,sessions.authenticate(token).id) }
        row.revokedAt=now
        assertEquals(HttpStatus.UNAUTHORIZED,assertThrows(ApiException::class.java) { sessions.authenticate(token) }.status)
        verify(sql,times(3)).userSessionAccess(digest)
        assertTrue(mockingDetails(sql).invocations.none { it.method.name=="touchUserSession" })
    }

    @Test fun `joined authentication retains all student expiration and revocation checks`() {
        val changes=listOf<(UserSessionAccess)->Unit>(
            { it.expiresAt=now },{ it.revokedAt=now },{ it.status="DISABLED" },{ it.accountCredentialVersion=2 },
            { it.testExpiresAt=now },{ it.testExpiresAt=now.plusSeconds(600);it.testDisabledAt=now })
        changes.forEach { change ->
            val row=access().also(change);`when`(sql.userSessionAccess(digest)).thenReturn(row)
            assertEquals(HttpStatus.UNAUTHORIZED,assertThrows(ApiException::class.java) { sessions.authenticate(token) }.status)
        }
    }

    @Test fun `session activity uses the existing strict thirty second refresh window`() {
        val row=access().apply { lastSeenAt=now.minusSeconds(30) };`when`(sql.userSessionAccess(digest)).thenReturn(row)
        sessions.authenticate(token)
        assertTrue(mockingDetails(sql).invocations.none { it.method.name=="touchUserSession" })
        row.lastSeenAt=now.minusSeconds(31)
        sessions.authenticate(token)
        verify(sql).touchUserSession(row.id!!,now,now.minusSeconds(30))
    }
}
