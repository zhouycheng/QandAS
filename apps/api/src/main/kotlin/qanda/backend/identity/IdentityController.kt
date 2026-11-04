package qanda.backend.identity

import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.*
import qanda.backend.platform.http.MutationResult
import qanda.backend.platform.security.Commands
import qanda.backend.platform.security.requestId
import java.util.UUID

@RestController
@RequestMapping("/api/v1",produces=["application/json"])
class IdentityController(private val service: IdentityService,private val sessions: Sessions,private val challenges: ChallengeService,private val commands: Commands) {
    @PostMapping("/auth/email-challenges") @ResponseStatus(HttpStatus.CREATED)
    fun requestPublicEmailChallenge(@RequestBody input: ChallengeInput,@RequestHeader("Idempotency-Key") key: UUID,request: HttpServletRequest): ChallengeView =
        commands.run(null,key,"AUTH_CHALLENGE",input,ChallengeView::class.java,request.requestId()) { challenges.issue(input,null) }
    @PostMapping("/auth/sessions") fun login(@RequestBody input: LoginInput): TokenView = service.login(input)
    @PostMapping("/auth/email-code-sessions")
    fun emailCodeLogin(@RequestBody input: EmailCodeLoginInput): TokenView {
        challenges.verify(input.challengeId,input.code)
        return service.emailCodeLogin(input)
    }
    @PostMapping("/auth/wechat-sessions") fun wechatLogin(@RequestBody input: WechatLoginInput): TokenView = service.wechatLogin(input)
    @GetMapping("/me") fun me(): UserView = service.view(sessions.student().id)
    @PostMapping("/me/activity/heartbeat") fun heartbeat(): HeartbeatView = service.heartbeat(sessions.student())
    @PutMapping("/me/profile")
    fun updateProfile(@RequestBody input: ProfileInput,@RequestHeader("Idempotency-Key") key: UUID,request: HttpServletRequest): MutationResult {
        val actor=sessions.student();return commands.run(actor,key,"UPDATE_PROFILE",input,MutationResult::class.java,request.requestId()) { service.updateProfile(actor,input) }
    }
    @PostMapping("/me/email-challenges")
    fun requestOwnEmailChallenge(@RequestBody input: ChallengeInput,@RequestHeader("Idempotency-Key") key: UUID,request: HttpServletRequest): ChallengeView {
        val actor=sessions.student();return commands.run(actor,key,"OWN_CHALLENGE",input,ChallengeView::class.java,request.requestId()) { challenges.issue(input,actor.id) }
    }
    @PostMapping("/me/email-challenges/{id}/verification")
    fun verifyOwnEmailChallenge(@PathVariable id: UUID,@RequestBody input: ChallengeVerificationInput): ChallengeVerificationView =
        challenges.verifyOwn(id,input,sessions.student().id)
    @PutMapping("/me/email-binding")
    fun changeEmail(@RequestBody input: EmailInput,@RequestHeader("Idempotency-Key") key: UUID,request: HttpServletRequest): MutationResult {
        val actor=sessions.student();return commands.run(actor,key,"CHANGE_EMAIL",input,MutationResult::class.java,request.requestId()) {
            challenges.verify(input.newChallengeId,input.newCode);input.oldChallengeId?.let { challenges.verify(it,input.oldCode ?: invalid("oldCode")) };service.changeEmail(actor,input)
        }
    }
    @PutMapping("/me/wechat-binding")
    fun bindWechat(@RequestBody input: WechatBindingInput,@RequestHeader("Idempotency-Key") key: UUID,request: HttpServletRequest): MutationResult {
        val actor=sessions.student();return commands.run(actor,key,"BIND_WECHAT",input,MutationResult::class.java,request.requestId()) { service.bindWechat(actor,input) }
    }
    @DeleteMapping("/auth/sessions/current") fun logout(): MutationResult { val actor=sessions.student();return service.revoke(actor,actor.sessionId) }
}
