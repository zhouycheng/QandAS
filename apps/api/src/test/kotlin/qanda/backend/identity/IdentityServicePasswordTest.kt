package qanda.backend.identity

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.mock.env.MockEnvironment
import qanda.backend.catalog.api.CatalogDirectory
import qanda.backend.identity.api.WechatCodeExchange
import qanda.backend.platform.events.ActivityEvents
import qanda.backend.platform.http.ApiException
import qanda.backend.platform.security.Actor
import qanda.backend.platform.security.LoginAttempts
import java.time.Clock
import java.util.UUID

class IdentityServicePasswordTest {
    @Test fun `student service applies the same password policy to all four flows`() {
        val users=mock(UserAccountMapper::class.java);val profiles=mock(UserProfileMapper::class.java)
        val sessionRows=mock(UserSessionMapper::class.java);val challengeRows=mock(EmailChallengeMapper::class.java)
        val sql=mock(IdentityMapper::class.java);val challenges=mock(ChallengeService::class.java)
        val crypto=IdentityCrypto(MockEnvironment());val attempts=mock(LoginAttempts::class.java)
        val service=IdentityService(users,profiles,mock(UserWechatMapper::class.java),sessionRows,mock(WechatTicketMapper::class.java),challengeRows,sql,
            crypto,challenges,mock(WechatCodeExchange::class.java),mock(CatalogDirectory::class.java),attempts,Clock.systemUTC(),mock(ActivityEvents::class.java))
        val challengeId=UUID.randomUUID();val address="student@example.test"
        val proof=EmailChallenge().apply { id=challengeId;email=address;emailKey=address }
        `when`(challenges.consume(challengeId,"REGISTER",null)).thenReturn(proof)
        val registration=RegistrationInput(challengeId,"123456","abc12345")
        assertThrows(ApiException::class.java) { service.register(registration.copy(password="abcdefgh")) }
        val created=service.register(registration)
        val user=mockingDetails(users).invocations.first { it.method.name=="insert" }.arguments[0] as UserAccount
        assertEquals(created.id,user.id);assertTrue(crypto.verifyStudentPassword(registration.password,user.passwordHash))
        `when`(sql.userByEmail(address)).thenReturn(user);`when`(sql.lockUser(user.id!!)).thenReturn(user)

        val login=LoginInput(address,registration.password,UUID.randomUUID())
        assertThrows(ApiException::class.java) { service.login(login.copy(password="abcdefgh")) }
        assertTrue(service.login(login).accessToken.startsWith("u_"))

        proof.userId=user.id
        `when`(challengeRows.selectById(challengeId)).thenReturn(proof)
        val reset=ResetPasswordInput(challengeId,"123456","NewPass123")
        assertEquals("/newPassword",assertThrows(ApiException::class.java) { service.reset(reset.copy(newPassword="abcdefgh")) }.fieldErrors.single().field)
        service.reset(reset)
        val actor=Actor(user.id!!,UUID.randomUUID(),"USER","WEB")
        val change=PasswordInput(user.version,challengeId,"123456","Final123")
        assertEquals("/newPassword",assertThrows(ApiException::class.java) { service.changePassword(actor,change.copy(newPassword="abcdefgh")) }.fieldErrors.single().field)
        service.changePassword(actor,change)
        val hashes=mockingDetails(sql).invocations.filter { it.method.name=="updateCredentials" }.map { it.arguments[3] as String }
        assertEquals(2,hashes.size)
        assertTrue(crypto.verifyStudentPassword(reset.newPassword,hashes[0]));assertTrue(crypto.verifyStudentPassword(change.newPassword,hashes[1]))
        verify(sql,times(2)).revokeUserSessions(user.id!!)
    }
}
