package qanda.backend.contentsafety

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.mock.env.MockEnvironment
import qanda.backend.platform.http.ApiException
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64
import java.util.HexFormat
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

class WechatCallbackTest {
    private val json=jacksonObjectMapper()
    private val key=ByteArray(32) { 13 }
    private val now=Instant.parse("2026-11-04T00:00:00Z")
    private val clock=Clock.fixed(now,ZoneOffset.UTC)
    private val environment=MockEnvironment().withProperty("BACKEND_WECHAT_CALLBACK_TOKEN","fixture-token")
        .withProperty("BACKEND_WECHAT_CALLBACK_AES_KEY",Base64.getEncoder().withoutPadding().encodeToString(key))
        .withProperty("BACKEND_WECHAT_APP_ID","wx0000000000000000")
    private val callback=WechatCallback(environment,json,clock)
    private val timestamp=now.epochSecond.toString()
    private fun sign(vararg fields: String)=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest((listOf("fixture-token")+fields).sorted().joinToString("").toByteArray()))
    private fun encrypt(payload: String,app: String="wx0000000000000000"): String {
        val message=payload.toByteArray();val raw=ByteArray(16)+ByteBuffer.allocate(4).putInt(message.size).array()+message+app.toByteArray()
        val padding=32-raw.size%32;val cipher=Cipher.getInstance("AES/CBC/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE,SecretKeySpec(key,"AES"),IvParameterSpec(key.copyOfRange(0,16)))
        return Base64.getEncoder().encodeToString(cipher.doFinal(raw+ByteArray(padding) { padding.toByte() }))
    }
    @Test fun `encrypted media verdict verifies signature app and expiry for JSON and XML envelopes`() {
        val payload="""{"Event":"wxa_media_check","trace_id":"fixture-trace","result":{"suggest":"pass"}}"""
        val encrypted=encrypt(payload);val signature=sign(timestamp,"nonce",encrypted)
        for(body in listOf(json.writeValueAsString(mapOf("Encrypt" to encrypted)),"<xml><Encrypt><![CDATA[$encrypted]]></Encrypt></xml>")) {
            assertEquals("fixture-trace",callback.event(signature,timestamp,"nonce",body)["trace_id"].asText())
        }
        assertThrows(ApiException::class.java) { callback.event("0".repeat(40),timestamp,"nonce",json.writeValueAsString(mapOf("Encrypt" to encrypted))) }
        val wrongApp=encrypt(payload,"wx1111111111111111")
        assertThrows(ApiException::class.java) { callback.event(sign(timestamp,"nonce",wrongApp),timestamp,"nonce",json.writeValueAsString(mapOf("Encrypt" to wrongApp))) }
        val stale=now.minusSeconds(301).epochSecond.toString()
        assertThrows(ApiException::class.java) { callback.event(sign(stale,"nonce",encrypted),stale,"nonce",json.writeValueAsString(mapOf("Encrypt" to encrypted))) }
        assertThrows(ApiException::class.java) { callback.event(signature,timestamp,"nonce","<!DOCTYPE xml [<!ENTITY external SYSTEM 'file:///etc/passwd'>]><xml><Encrypt>&external;</Encrypt></xml>") }
    }
    @Test fun `url handshake and provider fixture cannot enable production bypass`() {
        assertEquals("echo",callback.echo(sign(timestamp,"nonce"),null,timestamp,"nonce","echo"))
        val disabled=WechatContentChecks(MockEnvironment().withProperty("BACKEND_CONTENT_SAFETY_PROVIDER","local"),json,clock)
        assertEquals("CONTENT_SAFETY_UNAVAILABLE",assertThrows(ApiException::class.java) { disabled.text("openid","text",1) }.code)
        val local=WechatContentChecks(MockEnvironment().withProperty("BACKEND_CONTENT_SAFETY_PROVIDER","local").withProperty("qanda.backend.mode","test"),json,clock)
        local.text("openid","valid",1)
        assertEquals("CONTENT_REJECTED",assertThrows(ApiException::class.java) { local.text("openid","[risk]",1) }.code)
        assertEquals("CONTENT_REVIEW_REQUIRED",assertThrows(ApiException::class.java) { local.text("openid","[review]",1) }.code)
        assertEquals("CONTENT_SAFETY_UNAVAILABLE",assertThrows(ApiException::class.java) { local.text("openid","[unavailable]",1) }.code)
    }
}
