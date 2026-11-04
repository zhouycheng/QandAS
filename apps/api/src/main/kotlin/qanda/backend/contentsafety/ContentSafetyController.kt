package qanda.backend.contentsafety

import org.springframework.http.CacheControl
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import java.util.UUID
import jakarta.servlet.http.HttpServletRequest

data class SafetyContextInput(val code: String)
data class SafetyConfirmation(val requestId: UUID,val token: String,val code: String)
data class SafetyInvitationInput(val requestId: UUID,val token: String)

@RestController
@RequestMapping("/api/v1",produces=["application/json"])
class ContentSafetyController(private val safety: ContentSafety,private val sessions: Sessions,private val callbacks: WechatCallback) {
    private fun actor(request: HttpServletRequest)=if(request.requestURI.startsWith("/api/v1/admin/")) sessions.admin() else sessions.student()
    @PostMapping("/me/content-safety/contexts")
    fun context(@RequestBody input: SafetyContextInput): SafetyContextView=safety.context(sessions.student(),input.code)
    @PostMapping("/me/content-safety/requests","/admin/content-safety/requests")
    fun prepare(@RequestBody input: SafetyInput,request: HttpServletRequest): SafetyView=safety.prepare(actor(request),input)
    @GetMapping("/me/content-safety/requests/{id}","/admin/content-safety/requests/{id}")
    fun status(@PathVariable id: UUID,request: HttpServletRequest): SafetyView=safety.view(actor(request),id)
    @PostMapping("/content-safety/confirmations")
    fun confirm(@RequestBody input: SafetyConfirmation): SafetyView=safety.confirm(input.requestId,input.token,input.code)
    @PostMapping("/content-safety/confirmations/inspection")
    fun invitation(@RequestBody input: SafetyInvitationInput): SafetyInvitation=safety.invitation(input.requestId,input.token)
    @GetMapping("/content-safety/media/{id}")
    fun media(@PathVariable id: UUID,@RequestParam token: String): ResponseEntity<ByteArray> {
        val (bytes,type)=safety.media(id,token)
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.parseMediaType(type)).body(bytes)
    }
    @GetMapping("/content-safety/wechat-callback",produces=["text/plain"])
    fun echo(@RequestParam(required=false) signature: String?,@RequestParam(name="msg_signature",required=false) messageSignature: String?,
        @RequestParam timestamp: String,@RequestParam nonce: String,@RequestParam echostr: String): String=callbacks.echo(signature,messageSignature,timestamp,nonce,echostr)
    @PostMapping("/content-safety/wechat-callback",consumes=["application/json","text/xml","application/xml"],produces=["text/plain"])
    fun callback(@RequestParam(name="msg_signature") signature: String,@RequestParam timestamp: String,@RequestParam nonce: String,@RequestBody body: String): String {
        val event=callbacks.event(signature,timestamp,nonce,body)
        safety.callback(event.path("trace_id").asText(),event.path("result").path("suggest").asText())
        return "success"
    }
}
