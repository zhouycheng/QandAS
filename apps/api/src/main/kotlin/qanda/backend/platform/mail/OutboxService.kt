package qanda.backend.platform.mail

import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.env.Environment
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.transaction.PlatformTransactionManager
import qanda.backend.identity.EmailChallenge
import java.time.Clock
import java.util.UUID

@Configuration
@ConditionalOnProperty(name=["qanda.backend.mail.enabled"],havingValue="true")
class MailRuntimeConfiguration {
    @Bean fun mailCrypto(json: ObjectMapper,environment: Environment)=MailCrypto(json,environment)
    @Bean internal fun mailTransport(environment: Environment,json: ObjectMapper,clock: Clock): IdentityMailTransport=when(environment.getProperty("qanda.backend.mail.transport")) {
        "local-capture" -> LocalCaptureTransport(environment)
        "tencent-ses" -> TencentSesSettings(environment).let { TencentSesTransport(it,TencentSesTransport.client(it),json,clock) }
        else -> error("邮件传输须明确配置")
    }
}

@Service
class OutboxService internal constructor(private val rows: MailDeliveryMapper,private val sql: MailQueries,private val cryptos: ObjectProvider<MailCrypto>,private val transports: ObjectProvider<IdentityMailTransport>,
                    private val environment: Environment,private val jdbc: JdbcTemplate,manager: PlatformTransactionManager) {
    private val tx=TransactionTemplate(manager)
    private val log=LoggerFactory.getLogger(javaClass)
    fun enqueue(challenge: EmailChallenge,code: String) {
        val crypto=cryptos.ifAvailable ?: mailUnavailable()
        val envelope=crypto.prepare(challenge.id!!,challenge.email,code,"IDENTITY_${challenge.purpose}",1,challenge.expiresAt)
        rows.insert(MailDelivery().apply { id=UUID.randomUUID();challengeId=challenge.id;templateCode=envelope.templateCode;templateVersion=envelope.templateVersion
            ciphertext=envelope.ciphertext;nonce=envelope.nonce;keyVersion=envelope.keyVersion;expiresAt=envelope.expiresAt })
    }
    @Scheduled(fixedDelayString="\${qanda.backend.mail.poll-delay-ms:1000}")
    fun tick() {
        if(environment.getProperty("qanda.backend.role","api") !in setOf("worker","all")) return
        if(!environment.getProperty("qanda.backend.mail.dispatch-enabled",Boolean::class.java,true) || transports.ifAvailable==null) return
        try { dispatchOne() } catch(e: Exception) { log.warn("Mail dispatch deferred: {}",e.javaClass.simpleName) }
    }
    fun dispatchOne(): Boolean {
        val transport=transports.ifAvailable ?: return false
        val lease=UUID.randomUUID()
        val row=tx.execute { sql.sweep();sql.claim()?.also { sql.lease(it.id!!,lease) } } ?: return false
        tx.executeWithoutResult {
            val emailKey=jdbc.queryForList("SELECT email_key FROM email_challenge WHERE id=?",String::class.java,row.challengeId).singleOrNull() ?: return@executeWithoutResult
            // Erasure waits for an already-started dispatch and cancels every message still waiting.
            jdbc.queryForList("SELECT pg_advisory_xact_lock(hashtextextended(?,0))","mail:$emailKey")
            val valid=jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM mail_delivery d JOIN email_challenge c ON c.id=d.challenge_id LEFT JOIN user_account u ON u.id=c.user_id WHERE d.id=? AND d.lease_id=? AND d.state='SENDING' AND c.consumed_at IS NULL AND c.eligible AND c.failed_attempts<5 AND c.expires_at>now() AND (c.user_id IS NULL OR (u.status='ACTIVE' AND u.credential_version=c.credential_version)))",Boolean::class.java,row.id,lease)==true
            if(!valid) { sql.record(row.id!!,lease,"CANCELLED",null,"CHALLENGE_INVALID");return@executeWithoutResult }
            val result=try {
                val material=cryptos.getObject().decrypt(PreparedMailEnvelope(row.challengeId!!,row.templateCode,row.templateVersion,row.expiresAt,row.ciphertext,row.nonce,row.keyVersion))
                transport.send(row.id!!,material)
            } catch(_: Exception) { SendResult(SendState.UNKNOWN,errorCode="TRANSPORT_RESULT_UNKNOWN") }
            sql.record(row.id!!,lease,result.state.name,result.providerMessageId,result.errorCode)
        }
        return true
    }
}
