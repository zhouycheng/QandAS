package qanda.backend.admin

import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.*
import qanda.backend.platform.http.*
import qanda.backend.platform.security.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1/admin/test-accounts",produces=["application/json"])
class TestAccountController(private val service: TestAccountService,private val sessions: Sessions,private val commands: Commands) {
    @GetMapping fun list(@RequestParam(required=false) keyword: String?,@RequestParam(required=false) status: String?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<TestAccountView> {
        sessions.admin();return service.list(keyword,status,PageSpec(page,pageSize))
    }
    @PostMapping @ResponseStatus(HttpStatus.CREATED)
    fun create(@RequestBody input: TestAccountInput,@RequestHeader("Idempotency-Key") key: UUID,request: HttpServletRequest): TestAccountView {
        val actor=sessions.admin();return commands.run(actor,key,"CREATE_TEST_ACCOUNT",input,TestAccountView::class.java,request.requestId()) { service.create(input,actor.id) }
    }
    @GetMapping("/{id}/credentials") fun credentials(@PathVariable id: UUID,request: HttpServletRequest): TestAccountCredentials = service.credentials(id,sessions.admin().id,request.requestId())
    @PutMapping("/{id}/status")
    fun disable(@PathVariable id: UUID,@RequestBody input: TestAccountStatusInput,@RequestHeader("Idempotency-Key") key: UUID,request: HttpServletRequest): MutationResult {
        val actor=sessions.admin();return commands.run(actor,key,"DISABLE_TEST_ACCOUNT:$id",input,MutationResult::class.java,request.requestId()) { service.disable(id,input.expectedVersion) }
    }
}
