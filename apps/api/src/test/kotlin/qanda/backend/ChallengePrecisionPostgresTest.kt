package qanda.backend

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.context.ApplicationContext
import org.springframework.transaction.support.TransactionTemplate
import qanda.backend.identity.*
import qanda.backend.platform.security.TransactionLocks
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID

class ChallengePrecisionPostgresTest : PostgresFixture() {
    @Autowired lateinit var context: ApplicationContext

    @Test fun `challenge expiration survives database precision rounding at a millisecond boundary`() {
        val service = ChallengeService(context.getBean(IdentityMapper::class.java), context.getBean(EmailChallengeMapper::class.java),
            context.getBean(UserAccountMapper::class.java), context.getBean(IdentityCrypto::class.java), outbox,
            context.getBean(TransactionLocks::class.java), Clock.fixed(Instant.parse("2030-01-01T00:00:00.123999999Z"), ZoneOffset.UTC), transactionManager)
        val issued = TransactionTemplate(transactionManager).execute {
            service.issue(ChallengeInput("LOGIN", "${UUID.randomUUID()}@example.test"), null)
        }!!
        val persisted = jdbc.queryForObject("SELECT expires_at FROM email_challenge WHERE id=?",
            { row, _ -> row.getTimestamp(1).toInstant() }, issued.id)
        assertEquals(Instant.parse("2030-01-01T00:10:00.123Z"), issued.expiresAt)
        assertEquals(issued.expiresAt, persisted)
    }
}
