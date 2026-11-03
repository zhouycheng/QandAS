package qanda.backend.identity

import com.baomidou.mybatisplus.annotation.*
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.core.JsonToken
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.annotation.JsonDeserialize
import com.baomidou.mybatisplus.core.mapper.BaseMapper
import io.swagger.v3.oas.annotations.media.Schema
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import org.springframework.core.env.Environment
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.platform.http.*
import qanda.backend.platform.security.Commands
import java.time.Clock
import java.time.Instant
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class TestAccountDaysDeserializer: JsonDeserializer<Int>() {
    override fun deserialize(parser: JsonParser,context: DeserializationContext): Int {
        if(parser.currentToken!=JsonToken.VALUE_NUMBER_INT) invalid("validDays")
        return parser.intValue
    }
}
data class TestAccountInput(@field:JsonDeserialize(using=TestAccountDaysDeserializer::class) @field:Schema(minimum="1",maximum="365") val validDays: Int = 7, val includeInStatistics: Boolean = false)
data class TestAccountStatusInput(val expectedVersion: Long)
data class TestAccountView(val id: UUID,val email: String,val createdAt: Instant,val expiresAt: Instant,
    @field:Schema(allowableValues=["ACTIVE","DISABLED","EXPIRED"]) val status: String,val includeInStatistics: Boolean,val version: Long)
data class TestAccountCredentials(val email: String,val password: String,val expiresAt: Instant) {
    override fun toString()="TestAccountCredentials([REDACTED])"
}
data class TestAccountAccess(val expiresAt: Instant,val disabledAt: Instant?)
internal fun checkTestAccount(access: TestAccountAccess?,now: Instant) {
    if(access!=null && (access.disabledAt!=null || !access.expiresAt.isAfter(now))) unauthenticated("测试账号已停用或到期")
}
internal fun fixedTestCredentials(): Nothing = conflict("TEST_ACCOUNT_FIXED_CREDENTIALS","测试账号的登录凭据由管理员管理")

@TableName("test_account")
class TestAccount {
    @TableId(type=IdType.INPUT) var userId: UUID? = null
    var expiresAt: Instant = Instant.now()
    var includeInStatistics: Boolean = false
    var createdBy: UUID? = null
    var disabledAt: Instant? = null
    var disableReason: String? = null
    var passwordCiphertext: String? = null
    var passwordNonce: String? = null
    var passwordKeyVersion: Int? = null
}
@Mapper interface TestAccountMapper: BaseMapper<TestAccount> {
    fun page(@Param("keyword") keyword: String?,@Param("status") status: String?,@Param("now") now: Instant,@Param("offset") offset: Int,@Param("limit") limit: Int): List<TestAccountView>
    fun count(@Param("keyword") keyword: String?,@Param("status") status: String?,@Param("now") now: Instant): Long
    fun disable(@Param("id") id: UUID,@Param("now") now: Instant,@Param("reason") reason: String)
    fun due(@Param("now") now: Instant): List<UUID>
}

@Component
class TestAccountCrypto(private val environment: Environment) {
    private val random=SecureRandom()
    private fun keys(): Map<Int,ByteArray> = try {
        val entries=environment.getRequiredProperty("BACKEND_TEST_ACCOUNT_ENCRYPTION_KEYS").split(',').map {
            val pair=it.split(':',limit=2);pair[0].toInt() to Base64.getDecoder().decode(pair[1])
        }
        require(entries.isNotEmpty() && entries.map { it.first }.distinct().size==entries.size && entries.all { it.first in 1..32767 && it.second.size==32 })
        entries.toMap()
    } catch(_: Exception) { unavailable("TEST_ACCOUNT_KEY_UNAVAILABLE") }
    fun password(): String {
        val alphabet="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
        while(true) {
            val value=(1..16).map { alphabet[random.nextInt(alphabet.length)] }.joinToString("")
            if(value.any { it.isLetter() } && value.any { it.isDigit() }) return value
        }
    }
    fun encrypt(row: TestAccount,password: String) {
        val keys=keys();val version=environment.getProperty("BACKEND_TEST_ACCOUNT_ENCRYPTION_ACTIVE_VERSION",Int::class.java,1)
        val key=keys[version] ?: unavailable("TEST_ACCOUNT_KEY_UNAVAILABLE")
        val nonce=ByteArray(12).also(random::nextBytes)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE,SecretKeySpec(key,"AES"),GCMParameterSpec(128,nonce))
        cipher.updateAAD(row.userId.toString().toByteArray(Charsets.UTF_8))
        row.passwordCiphertext=Base64.getEncoder().encodeToString(cipher.doFinal(password.toByteArray(Charsets.UTF_8)))
        row.passwordNonce=Base64.getEncoder().encodeToString(nonce);row.passwordKeyVersion=version
    }
    fun decrypt(row: TestAccount): String {
        val key=keys()[row.passwordKeyVersion] ?: unavailable("TEST_ACCOUNT_KEY_UNAVAILABLE")
        return try {
            val cipher=Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE,SecretKeySpec(key,"AES"),GCMParameterSpec(128,Base64.getDecoder().decode(row.passwordNonce)))
            cipher.updateAAD(row.userId.toString().toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(Base64.getDecoder().decode(row.passwordCiphertext)),Charsets.UTF_8)
        } catch(_: Exception) { unavailable("TEST_ACCOUNT_CREDENTIALS_UNAVAILABLE") }
    }
}

@Service
@Transactional
class TestAccountService(private val rows: TestAccountMapper,private val users: UserAccountMapper,private val profiles: UserProfileMapper,
    private val identity: IdentityMapper,private val crypto: IdentityCrypto,private val secrets: TestAccountCrypto,private val clock: Clock,private val audit: Commands) {
    fun list(keyword: String?,status: String?,page: PageSpec): Page<TestAccountView> {
        if((keyword?.length ?: 0)>100) invalid("keyword")
        if(status!=null && status !in setOf("ACTIVE","DISABLED","EXPIRED")) invalid("status")
        val now=clock.instant()
        return Page(rows.page(keyword,status,now,page.offset,page.pageSize),rows.count(keyword,status,now),page.page,page.pageSize)
    }
    fun create(input: TestAccountInput,adminId: UUID): TestAccountView {
        if(input.validDays !in 1..365) invalid("validDays")
        val now=clock.instant().truncatedTo(java.time.temporal.ChronoUnit.MILLIS);val id=UUID.randomUUID();val password=secrets.password()
        val record=TestAccount().apply { userId=id;expiresAt=now.plusSeconds(input.validDays*86400L);includeInStatistics=input.includeInStatistics;createdBy=adminId }
        secrets.encrypt(record,password)
        val user=UserAccount().apply { this.id=id;accountCode=crypto.accountCode();nickname="测试账号";email="test_${id.toString().replace("-","")}@qanda.invalid";emailKey=email
            passwordHash=crypto.prepareStudentPassword(password).encoded;createdAt=now;updatedAt=now }
        users.insert(user);profiles.insert(UserProfile().apply { userId=id });rows.insert(record)
        return TestAccountView(id,user.email!!,now,record.expiresAt,"ACTIVE",record.includeInStatistics,user.version)
    }
    fun credentials(id: UUID,adminId: UUID,requestId: UUID): TestAccountCredentials {
        val user=identity.lockUser(id) ?: missing();val row=rows.selectById(id) ?: missing()
        if(user.status!="ACTIVE" || row.disabledAt!=null || !row.expiresAt.isAfter(clock.instant())) conflict("TEST_ACCOUNT_INACTIVE","测试账号已停用或到期")
        val password=secrets.decrypt(row)
        audit.recordAdminRead(adminId,"VIEW_TEST_ACCOUNT_CREDENTIALS:$id",requestId)
        return TestAccountCredentials(user.email!!,password,row.expiresAt)
    }
    fun disable(id: UUID,expectedVersion: Long?=null): MutationResult {
        val user=identity.lockUser(id) ?: missing();val row=rows.selectById(id) ?: missing()
        expectedVersion?.let { requireVersion(it,user.version) }
        if(row.disabledAt==null) {
            val now=clock.instant();rows.disable(id,now,if(row.expiresAt.isAfter(now)) "MANUAL" else "EXPIRED")
            user.status="DISABLED";user.version++;user.credentialVersion++;user.updatedAt=now;users.updateById(user);identity.revokeUserSessions(id)
        }
        return MutationResult(id,user.version)
    }
    fun expireDue() { rows.due(clock.instant()).forEach { disable(it) } }
}

@Component
class TestAccountExpiry(private val service: TestAccountService,private val environment: Environment) {
    @Scheduled(fixedDelay=60000)
    fun tick() { if(environment.getProperty("qanda.backend.role","api") in setOf("worker","all") && !environment.getProperty("qanda.backend.schema-command",Boolean::class.java,false)) service.expireDue() }
}
