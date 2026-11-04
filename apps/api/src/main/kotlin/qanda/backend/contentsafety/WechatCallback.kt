package qanda.backend.contentsafety

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.core.env.Environment
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import qanda.backend.platform.http.ApiException
import java.io.StringReader
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.time.Clock
import java.util.Base64
import java.util.HexFormat
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import org.xml.sax.InputSource

@Component
class WechatCallback(private val environment: Environment,private val json: ObjectMapper,private val clock: Clock) {
    private fun reject(): Nothing=throw ApiException(HttpStatus.FORBIDDEN,"INVALID_CALLBACK","回调校验失败")
    private fun token()=environment.getProperty("BACKEND_WECHAT_CALLBACK_TOKEN")?.takeIf { it.length in 3..32 } ?: reject()
    private fun field(body: String,name: String): String {
        if(body.toByteArray().size>65536) reject()
        return try {
            if(body.trimStart().startsWith("{")) json.readTree(body).path(name).asText() else {
                val factory=DocumentBuilderFactory.newInstance()
                factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true)
                factory.setFeature("http://xml.org/sax/features/external-general-entities",false)
                factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false)
                factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD,"");factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA,"")
                factory.newDocumentBuilder().parse(InputSource(StringReader(body))).getElementsByTagName(name).item(0)?.textContent ?: reject()
            }
        } catch(_: Exception) { reject() }
    }
    private fun verify(signature: String,timestamp: String,nonce: String,encrypted: String?=null) {
        val seconds=timestamp.toLongOrNull() ?: reject()
        if(seconds<clock.instant().epochSecond-300 || seconds>clock.instant().epochSecond+300 || nonce.length !in 1..128 || signature.length!=40) reject()
        val material=listOfNotNull(token(),timestamp,nonce,encrypted).sorted().joinToString("")
        val expected=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(material.toByteArray()))
        if(!MessageDigest.isEqual(expected.toByteArray(),signature.toByteArray())) reject()
    }
    private fun decrypt(value: String): String {
        try {
            val encoded=environment.getProperty("BACKEND_WECHAT_CALLBACK_AES_KEY") ?: reject()
            if(encoded.length!=43) reject()
            val key=Base64.getDecoder().decode(encoded+"=")
            val input=Base64.getDecoder().decode(value)
            if(key.size!=32 || input.isEmpty() || input.size%16!=0 || input.size>65536) reject()
            val cipher=Cipher.getInstance("AES/CBC/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE,SecretKeySpec(key,"AES"),IvParameterSpec(key.copyOfRange(0,16)))
            val bytes=cipher.doFinal(input);val padding=bytes.last().toInt() and 255
            if(padding !in 1..32 || padding>bytes.size || bytes.takeLast(padding).any { (it.toInt() and 255)!=padding }) reject()
            val end=bytes.size-padding
            if(end<20) reject()
            val length=ByteBuffer.wrap(bytes,16,4).int
            if(length<0 || length>end-20) reject()
            val app=String(bytes,20+length,end-20-length,Charsets.UTF_8)
            if(app!=environment.getProperty("BACKEND_WECHAT_APP_ID")) reject()
            return String(bytes,20,length,Charsets.UTF_8)
        } catch(_: Exception) { reject() }
    }
    fun echo(signature: String?,messageSignature: String?,timestamp: String,nonce: String,echo: String): String {
        if(echo.length>65536) reject()
        if(messageSignature!=null) { verify(messageSignature,timestamp,nonce,echo);return decrypt(echo) }
        verify(signature ?: reject(),timestamp,nonce)
        return echo
    }
    fun event(signature: String,timestamp: String,nonce: String,body: String): JsonNode {
        val encrypted=field(body,"Encrypt")
        verify(signature,timestamp,nonce,encrypted)
        val payload=decrypt(encrypted)
        val value=try { json.readTree(payload) } catch(_: Exception) { reject() }
        if(value.path("Event").asText()!="wxa_media_check" || value.path("trace_id").asText().isBlank()) reject()
        return value
    }
}
