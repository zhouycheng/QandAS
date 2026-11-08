package qanda.backend.identity

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import qanda.backend.admin.AdminAccount
import qanda.backend.admin.AdminSession
import java.time.Instant
import java.util.UUID

class UserSessionAccess {
    var id: UUID?=null;var userId: UUID?=null
    var expiresAt: Instant=Instant.EPOCH;var lastSeenAt: Instant=Instant.EPOCH;var revokedAt: Instant?=null
    var sessionCredentialVersion: Long=0;var accountCredentialVersion: Long=0;var status: String=""
    var testExpiresAt: Instant?=null;var testDisabledAt: Instant?=null
}

@Mapper interface IdentityMapper {
    fun testAccountAccess(@Param("id") id: UUID): TestAccountAccess?
    fun userByEmail(@Param("email") email: String): UserAccount?
    fun lockUser(@Param("id") id: UUID): UserAccount?
    fun lockAdmin(@Param("id") id: UUID): AdminAccount?
    fun userSessionAccess(@Param("digest") digest: ByteArray): UserSessionAccess?
    fun adminSession(@Param("digest") digest: ByteArray): AdminSession?
    fun lockUserSession(@Param("id") id: UUID): UserSession?
    fun lockAdminSession(@Param("id") id: UUID): AdminSession?
    fun adminSessionById(@Param("id") id: UUID): AdminSession?
    fun touchUserSession(@Param("id") id: UUID, @Param("now") now: Instant,@Param("before") before: Instant)
    fun touchForeground(@Param("id") id: UUID,@Param("userId") userId: UUID,@Param("now") now: Instant): Int
    fun touchAdminSession(@Param("id") id: UUID, @Param("now") now: Instant,@Param("before") before: Instant)
    fun revokeUserSessions(@Param("userId") userId: UUID)
    fun revokeAdminSessions(@Param("adminId") adminId: UUID)
    fun lockChallenge(@Param("id") id: UUID): EmailChallenge?
    fun recentChallenge(@Param("email") email: String): Instant?
    fun failChallenge(@Param("id") id: UUID)
    fun consumeChallenge(@Param("id") id: UUID)
    fun wechat(@Param("appId") appId: String, @Param("openId") openId: String): UserWechat?
    fun updateCredentials(@Param("id") id: UUID,@Param("email") email: String?,@Param("emailKey") emailKey: String?)
    fun updateAdminUser(@Param("id") id: UUID,@Param("accountCode") accountCode: String,@Param("nickname") nickname: String,@Param("email") email: String?,@Param("emailKey") emailKey: String?,@Param("version") version: Long,@Param("credentialVersion") credentialVersion: Long,@Param("updatedAt") updatedAt: Instant)
}
