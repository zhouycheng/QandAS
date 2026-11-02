package qanda.backend.identity

import io.swagger.v3.oas.annotations.media.Schema
import java.time.Instant
import java.util.UUID

data class ChallengeInput(@field:Schema(allowableValues=["REGISTER","RESET_PASSWORD","BIND_EMAIL","CHANGE_EMAIL_NEW","CHANGE_EMAIL_OLD","CHANGE_PASSWORD"]) val purpose: String, val email: String? = null)
data class ChallengeView(val id: UUID, val expiresAt: Instant, val resendAfterSeconds: Int = 60)
data class ChallengeVerificationInput(@field:Schema(allowableValues=["CHANGE_PASSWORD","CHANGE_EMAIL_OLD"]) val purpose: String, @field:Schema(pattern="^[0-9]{6}$") val code: String)
data class ChallengeVerificationView(val expiresAt: Instant)
data class RegistrationInput(val challengeId: UUID, @field:Schema(pattern="^[0-9]{6}$") val code: String, @field:Schema(minLength=8,maxLength=16,pattern="^(?=[\\s\\S]*[A-Za-z])(?=[\\s\\S]*[0-9])(?![\\s\\S]*\\x00)[\\s\\S]*$",description="8–16 个 Unicode 码点，须包含英文字母和数字") val password: String, val nickname: String = "Q友")
data class WechatRegistrationInput(val registrationToken: String, val nickname: String = "Q友")
data class LoginInput(val email: String, @field:Schema(minLength=8,maxLength=16,pattern="^(?=[\\s\\S]*[A-Za-z])(?=[\\s\\S]*[0-9])(?![\\s\\S]*\\x00)[\\s\\S]*$",description="8–16 个 Unicode 码点，须包含英文字母和数字") val password: String, val deviceId: UUID, @field:Schema(allowableValues=["WEB","MINI_PROGRAM"]) val clientType: String = "WEB")
data class WechatLoginInput(val code: String, val deviceId: UUID)
data class TokenView(val accessToken: String, val sessionId: UUID, val expiresAt: Instant, val sessionMinutes: Int? = null)
data class WechatLoginView(val session: TokenView? = null, val registrationToken: String? = null)
data class UserView(val id: UUID, val accountCode: String, val nickname: String, val email: String?, val wechatBound: Boolean,
                    val collegeId: UUID?, val majorId: UUID?, val currentGrade: Int?, val status: String, val version: Long, val registeredAt: Instant,val collegeName: String?=null,val majorName: String?=null,
                    val academicYear: Int, val profileComplete: Boolean, val passwordSet: Boolean = false,
                    @field:Schema(description="账户头像，JPEG 或 PNG data URI，图片不超过 64 KiB、256×256 像素",maxLength=87407) val avatarUrl: String? = null)
data class ProfileInput(val expectedVersion: Long, val nickname: String, val collegeId: UUID? = null, val majorId: UUID? = null,
                        @field:Schema(description="当前年级：1 大一，2 大二，3 大三，4 大四，5 已毕业；省略时保留年级锚点") val currentGrade: Int? = null,
                        @field:Schema(description="账户头像，JPEG 或 PNG data URI；图片不超过 64 KiB、256×256 像素；省略时保留已有头像",maxLength=87407) val avatar: String? = null)
data class ResetPasswordInput(val challengeId: UUID, @field:Schema(pattern="^[0-9]{6}$") val code: String, @field:Schema(minLength=8,maxLength=16,pattern="^(?=[\\s\\S]*[A-Za-z])(?=[\\s\\S]*[0-9])(?![\\s\\S]*\\x00)[\\s\\S]*$",description="8–16 个 Unicode 码点，须包含英文字母和数字") val newPassword: String)
data class PasswordInput(val expectedVersion: Long, val challengeId: UUID, @field:Schema(pattern="^[0-9]{6}$") val code: String, @field:Schema(minLength=8,maxLength=16,pattern="^(?=[\\s\\S]*[A-Za-z])(?=[\\s\\S]*[0-9])(?![\\s\\S]*\\x00)[\\s\\S]*$",description="8–16 个 Unicode 码点，须包含英文字母和数字") val newPassword: String)
data class EmailInput(val expectedVersion: Long, val newChallengeId: UUID, @field:Schema(pattern="^[0-9]{6}$") val newCode: String, val oldChallengeId: UUID? = null, @field:Schema(pattern="^[0-9]{6}$") val oldCode: String? = null)
data class WechatBindingInput(val expectedVersion: Long, val code: String)
data class SessionView(val id: UUID, val deviceId: UUID, val clientType: String, val issuedAt: Instant, val expiresAt: Instant, val current: Boolean)
data class HeartbeatView(val receivedAt: Instant,val onlineUntil: Instant)
