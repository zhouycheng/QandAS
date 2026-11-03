package qanda.backend.identity

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.springframework.mock.env.MockEnvironment
import qanda.backend.platform.http.ApiException
import java.util.Base64
import java.util.UUID

class TestAccountCryptoTest {
    @Test fun `passwords meet student policy and encryption binds them to their account and key version`() {
        val key=Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
        val env=MockEnvironment().withProperty("BACKEND_TEST_ACCOUNT_ENCRYPTION_KEYS","1:$key")
        val crypto=TestAccountCrypto(env)
        repeat(30) { val password=crypto.password();assertEquals(16,password.length);assertTrue(password.any(Char::isLetter));assertTrue(password.any(Char::isDigit)) }
        val row=TestAccount().apply { userId=UUID.randomUUID() }
        crypto.encrypt(row,"GeneratedTest123");assertEquals("GeneratedTest123",crypto.decrypt(row))
        val nonce=row.passwordNonce;crypto.encrypt(row,"GeneratedTest123");assertNotEquals(nonce,row.passwordNonce)
        row.userId=UUID.randomUUID();assertThrows(ApiException::class.java) { crypto.decrypt(row) }
        assertThrows(ApiException::class.java) { TestAccountCrypto(MockEnvironment()).encrypt(row,"GeneratedTest123") }
        env.setProperty("BACKEND_TEST_ACCOUNT_ENCRYPTION_ACTIVE_VERSION","2")
        assertThrows(ApiException::class.java) { crypto.encrypt(row,"GeneratedTest123") }
    }
}
