package qanda.backend.identity

import io.swagger.v3.oas.annotations.media.Schema
import java.time.Instant
import java.util.UUID

data class ChallengeInput(@field:Schema(allowableValues=["LOGIN","BIND_EMAIL","CHANGE_EMAIL_NEW","CHANGE_EMAIL_OLD","DELETE_ACCOUNT"]) val purpose: String, val email: String? = null)
data class ChallengeView(val id: UUID, val expiresAt: Instant, val resendAfterSeconds: Int = 60)
data class ChallengeVerificationInput(@field:Schema(allowableValues=["CHANGE_EMAIL_OLD","DELETE_ACCOUNT"]) val purpose: String, @field:Schema(pattern="^[0-9]{6}$") val code: String)
data class ChallengeVerificationView(val expiresAt: Instant)
data class LoginInput(val email: String,@field:Schema(minLength=16,maxLength=16,pattern="^[A-Za-z0-9]{16}$",description="管理员生成的固定测试登录码") val password: String,val deviceId: UUID)
data class WechatLoginInput(val code: String, val deviceId: UUID)
data class TokenView(val accessToken: String, val sessionId: UUID, val expiresAt: Instant, val sessionMinutes: Int? = null)
data class UserView(val id: UUID,val accountCode: String,val nickname: String,val email: String?,val wechatBound: Boolean,
    val status: String,val version: Long,val registeredAt: Instant,val avatarUrl: String?=null,val isTestAccount: Boolean=false)
data class ProfileInput(val expectedVersion: Long,val nickname: String,
    @field:Schema(description="待检测头像，JPEG/PNG data URI，最多 64 KiB、256×256 像素",maxLength=87407) val avatar: String?=null)
data class AdminProfileInput(val expectedVersion: Long,val nickname: String,val accountCode: String,val email: String?)
data class EmailInput(val expectedVersion: Long, val newChallengeId: UUID, @field:Schema(pattern="^[0-9]{6}$") val newCode: String, val oldChallengeId: UUID? = null, @field:Schema(pattern="^[0-9]{6}$") val oldCode: String? = null)
data class WechatBindingInput(val expectedVersion: Long, val code: String)
data class HeartbeatView(val receivedAt: Instant,val onlineUntil: Instant)

data class EmailCodeLoginInput(val challengeId: UUID, @field:Schema(pattern="^[0-9]{6}$") val code: String, val deviceId: UUID)
