package qanda.backend.admin

import io.swagger.v3.oas.annotations.media.Schema
import java.time.Instant
import java.util.UUID

data class AdminLoginInput(val username: String,val password: String,val deviceId: UUID)
data class AdminInput(val username: String,val name: String,@field:Schema(allowableValues=["SUPER_ADMIN"]) val role: String="SUPER_ADMIN",@field:Schema(allowableValues=["ACTIVE","DISABLED"]) val status: String="ACTIVE",val password: String?=null,val expectedVersion: Long?=null)
data class AdminView(val id: UUID,val username: String,val name: String,@field:Schema(allowableValues=["SUPER_ADMIN"]) val role: String,val status: String,val version: Long,val createdAt: Instant,val lastLoginAt: Instant?)
data class AccountStatusInput(val expectedVersion: Long,@field:Schema(allowableValues=["ACTIVE","DISABLED"]) val status: String)
data class PolicyInput(val expectedVersion: Long,val lockEnabled: Boolean,val maxAttempts: Int,val lockMinutes: Int,val sessionMinutes: Int,
                       val minPasswordLength: Int,val requireLetter: Boolean,val requireNumber: Boolean,val requireMixedCase: Boolean,
                       val newDeviceVerification: Boolean=false,val changeInitialPassword: Boolean=false)
data class PolicyView(val lockEnabled: Boolean,val maxAttempts: Int,val lockMinutes: Int,val sessionMinutes: Int,val minPasswordLength: Int,
                      val requireLetter: Boolean,val requireNumber: Boolean,val requireMixedCase: Boolean,val version: Long,val updatedAt: Instant,
                      val newDeviceVerification: Boolean=false,val changeInitialPassword: Boolean=false)
