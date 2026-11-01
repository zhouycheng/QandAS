package qanda.backend.application

import jakarta.servlet.http.HttpServletRequest
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.MutationResult
import qanda.backend.platform.security.Commands
import qanda.backend.platform.security.requestId
import java.util.UUID

@RestController
@RequestMapping("/api/v1/admin/sync/dead-letters",produces=["application/json"])
class SyncRecoveryController(private val service: ProgressCommands,private val sessions: Sessions,private val commands: Commands) {
    @GetMapping("/head")
    fun head(): DeadLetterHead { sessions.admin();return DeadLetterHead(service.deadLetter()) }
    @PostMapping("/{commandId}/replay")
    fun replay(@PathVariable commandId: UUID,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult {
        val actor=sessions.admin()
        return commands.run(actor,key,"REPLAY_SYNC:$commandId",commandId,MutationResult::class.java,r.requestId()) { service.replay(commandId) }
    }
}

data class DeadLetterHead(val item: DeadLetterView?)
