package qanda.backend.application

import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import qanda.backend.practice.ProgressInput
import qanda.backend.platform.security.requestId
import qanda.backend.practice.ProgressAck
import java.util.UUID

@RestController
@RequestMapping("/api/v1/practice/sessions/{id}",produces=["application/json"])
class ProgressCommandController(private val service: ProgressCommands,private val sessions: Sessions) {
    @PostMapping("/progress-commands") @ResponseStatus(HttpStatus.ACCEPTED)
    fun submit(@PathVariable id: UUID,@RequestHeader("Idempotency-Key") key: UUID,@RequestBody input: ProgressInput,r: HttpServletRequest): ProgressCommandView = service.submit(sessions.student(),id,key,input,r.requestId())
    @GetMapping("/progress-commands/{commandId}")
    fun read(@PathVariable id: UUID,@PathVariable commandId: UUID): ProgressCommandView = service.read(sessions.student(),id,commandId)
}
