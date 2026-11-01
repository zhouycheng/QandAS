package qanda.backend.admin

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import qanda.backend.identity.*
import qanda.backend.identity.api.PreparedPassword
import qanda.backend.platform.http.ApiException
import qanda.backend.platform.queries.AuditReader
import qanda.backend.platform.security.LoginAttempts
import java.time.Clock
import java.util.UUID

class AdminServiceTest {
    private val accounts=mock(AdminAccountMapper::class.java)
    private val sessions=mock(AdminSessionMapper::class.java)
    private val policies=mock(SecurityPolicyMapper::class.java)
    private val queries=mock(AdminQueries::class.java)
    private val identity=mock(IdentityMapper::class.java)
    private val crypto=mock(IdentityCrypto::class.java)
    private val service=AdminService(accounts,sessions,policies,queries,identity,mock(UserAccountMapper::class.java),
        mock(IdentityService::class.java),mock(AuditReader::class.java),crypto,mock(LoginAttempts::class.java),Clock.systemUTC())

    private fun account()=AdminAccount().apply { id=UUID.randomUUID();username="admin_test";name="管理员";passwordHash="old-hash" }

    @Test fun `last active administrator cannot be disabled`() {
        val admin=account();`when`(identity.lockAdmin(admin.id!!)).thenReturn(admin);`when`(queries.activeAdminCount()).thenReturn(1)
        val error=assertThrows(ApiException::class.java) { service.save(admin.id,AdminInput(admin.username,admin.name,status="DISABLED",expectedVersion=1)) }
        assertEquals("LAST_ADMIN",error.code)
        verify(accounts,never()).updateById(admin);verify(identity,never()).revokeAdminSessions(admin.id!!)
    }

    @Test fun `disabling an administrator revokes only that account sessions`() {
        val admin=account();`when`(identity.lockAdmin(admin.id!!)).thenReturn(admin);`when`(queries.activeAdminCount()).thenReturn(2)
        service.save(admin.id,AdminInput(admin.username,admin.name,status="DISABLED",expectedVersion=1))
        assertEquals("INACTIVE",admin.status);assertEquals(2L,admin.credentialVersion);assertEquals(2L,admin.version)
        verify(identity).revokeAdminSessions(admin.id!!);verify(accounts).updateById(admin)
    }

    @Test fun `created administrators have the single administrator identity`() {
        `when`(policies.selectById(1)).thenReturn(SecurityPolicy())
        `when`(crypto.preparePassword("Password12345")).thenReturn(PreparedPassword("new-hash"))
        val result=service.save(null,AdminInput("new_admin","新管理员",password="Password12345"))
        val captured=org.mockito.ArgumentCaptor.forClass(AdminAccount::class.java)
        verify(accounts).insert(captured.capture())
        assertEquals(result.id,captured.value.id);assertEquals("SUPER_ADMIN",captured.value.role);assertEquals("ACTIVE",captured.value.status)
        val error=assertThrows(ApiException::class.java) { service.save(null,AdminInput("new_admin","新管理员",role="CONTENT_ADMIN",password="Password12345")) }
        assertEquals("VALIDATION_FAILED",error.code)
    }
}
