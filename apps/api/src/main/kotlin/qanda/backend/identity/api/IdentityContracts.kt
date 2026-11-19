package qanda.backend.identity.api

const val ADMIN_PASSWORD_MIN_LENGTH = 8
const val ADMIN_PASSWORD_MAX_LENGTH = 128

class PreparedPassword(val encoded: String) { override fun toString() = "PreparedPassword([REDACTED])" }
class WechatIdentity(val appId: String, val openId: String, val unionId: String?) { override fun toString() = "WechatIdentity([REDACTED])" }
interface WechatCodeExchange { fun exchange(code: String): WechatIdentity }
