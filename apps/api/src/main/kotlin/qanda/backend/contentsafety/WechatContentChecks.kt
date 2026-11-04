package qanda.backend.contentsafety

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.springframework.core.env.Environment
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import qanda.backend.platform.config.BackendSafety
import qanda.backend.platform.http.ApiException
import java.time.Clock
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

data class MediaCheck(val traceId: String)

@Component
class WechatContentChecks(private val environment: Environment,private val json: ObjectMapper,private val clock: Clock) {
    private val client=OkHttpClient.Builder().connectTimeout(2,TimeUnit.SECONDS).readTimeout(5,TimeUnit.SECONDS)
        .callTimeout(8,TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
    private var token: String?=null
    private var expires=Instant.EPOCH
    private fun local(): Boolean {
        val provider=environment.getProperty("BACKEND_CONTENT_SAFETY_PROVIDER","official")
        if(provider=="official") return false
        if(provider!="local" || environment.getProperty("qanda.backend.mode","production") !in setOf("local","test") ||
            !BackendSafety.localBindingAllowed(environment.getProperty("server.address","127.0.0.1"),environment.getProperty("BACKEND_LOCAL_CONTAINER",Boolean::class.java,false))) unavailable()
        return true
    }
    fun text(openId: String,content: String,scene: Int) {
        if(local()) {
            when { content.contains("[risk]") -> rejected("risky");content.contains("[review]") -> rejected("review");content.contains("[unavailable]") -> unavailable() }
            return
        }
        val body=post("/wxa/msg_sec_check?access_token="+accessToken(),mapOf("version" to 2,"openid" to openId,"scene" to scene,"content" to content))
        if(body.path("result").path("suggest").asText()!="pass") rejected(body.path("result").path("suggest").asText())
    }
    fun media(openId: String,url: String,scene: Int): MediaCheck {
        if(local()) return MediaCheck("local-"+UUID.randomUUID())
        val body=post("/wxa/media_check_async?access_token="+accessToken(),mapOf("version" to 2,"openid" to openId,"scene" to scene,"media_url" to url,"media_type" to 2))
        val trace=body.path("trace_id").asText()
        if(trace.isBlank() || trace.length>128) unavailable()
        return MediaCheck(trace)
    }
    @Synchronized
    private fun accessToken(): String {
        if(token!=null && expires.isAfter(clock.instant())) return token!!
        val app=environment.getProperty("BACKEND_WECHAT_APP_ID") ?: unavailable()
        val secret=environment.getProperty("BACKEND_WECHAT_APP_SECRET") ?: unavailable()
        val body=post("/cgi-bin/stable_token",mapOf("grant_type" to "client_credential","appid" to app,"secret" to secret,"force_refresh" to false))
        val value=body.path("access_token").asText()
        val seconds=body.path("expires_in").asLong()
        if(value.isBlank() || value.length>2048 || seconds<120) unavailable()
        token=value;expires=clock.instant().plusSeconds(seconds-60)
        return value
    }
    private fun post(path: String,input: Any): JsonNode {
        val bytes=try {
            val request=Request.Builder().url("https://api.weixin.qq.com"+path).post(json.writeValueAsBytes(input).toRequestBody("application/json".toMediaType())).build()
            client.newCall(request).execute().use { response ->
                if(response.code!=200) unavailable()
                val source=response.body?.source() ?: unavailable()
                val output=okio.Buffer()
                while(output.size<=16384) { if(source.read(output,16385-output.size)==-1L) break }
                if(output.size>16384) unavailable()
                output.readByteArray()
            }
        } catch(_: Exception) { unavailable() }
        val body=try { json.readTree(bytes) } catch(_: Exception) { unavailable() }
        val error=body.path("errcode").asInt(0)
        if(error in setOf(40001,40014,42001)) synchronized(this) { token=null;expires=Instant.EPOCH }
        if(!body.isObject || error!=0) unavailable()
        return body
    }
    private fun rejected(suggest: String): Nothing = throw ApiException(HttpStatus.UNPROCESSABLE_ENTITY,
        if(suggest=="review") "CONTENT_REVIEW_REQUIRED" else "CONTENT_REJECTED","内容未通过检查，请修改后重试")
    private fun unavailable(): Nothing = throw ApiException(HttpStatus.SERVICE_UNAVAILABLE,"CONTENT_SAFETY_UNAVAILABLE","内容检查暂时不可用，请稍后重试")
}
