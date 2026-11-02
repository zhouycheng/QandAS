package qanda.backend.operations

import jakarta.servlet.http.HttpServletRequest
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import qanda.backend.platform.security.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1",produces=["application/json"])
class OperationsController(private val service: OperationsService,private val sessions: Sessions,private val commands: Commands) {
    @PostMapping("/me/question-feedback") fun submitFeedback(@RequestBody input: FeedbackInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.student();return commands.run(a,key,"SUBMIT_FEEDBACK",input,MutationResult::class.java,r.requestId()) { service.feedback(a,input) } }
    @GetMapping("/me/question-feedback") fun feedback(@RequestParam(required=false) status: String?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<FeedbackView> = service.feedback(sessions.student(),status,PageSpec(page,pageSize))
    @PostMapping("/me/course-requests") fun requestCourse(@RequestBody input: CourseRequestInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.student();return commands.run(a,key,"REQUEST_COURSE",input,MutationResult::class.java,r.requestId()) { service.request(a,input) } }
    @GetMapping("/me/course-requests") fun requests(@RequestParam(required=false) status: String?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<CourseRequestView> = service.requests(sessions.student(),status,PageSpec(page,pageSize))
    @GetMapping("/admin/question-feedback") fun adminFeedback(@RequestParam(required=false) status: String?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<FeedbackView> = service.feedback(sessions.admin(),status,PageSpec(page,pageSize))
    @PutMapping("/admin/question-feedback/{id}") fun handleFeedback(@PathVariable id: UUID,@RequestBody input: HandleInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin();return commands.run(a,key,"HANDLE_FEEDBACK:$id",input,MutationResult::class.java,r.requestId()) { service.handleFeedback(a,id,input) } }
    @GetMapping("/admin/course-requests") fun adminRequests(@RequestParam(required=false) status: String?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<CourseRequestView> { val a=sessions.admin();return service.requests(a,status,PageSpec(page,pageSize)) }
    @PutMapping("/admin/course-requests/{id}") fun handleRequest(@PathVariable id: UUID,@RequestBody input: HandleInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin();return commands.run(a,key,"HANDLE_REQUEST:$id",input,MutationResult::class.java,r.requestId()) { service.handleRequest(id,input) } }
    @GetMapping("/admin/dashboard") fun dashboard(): DashboardView { sessions.admin();return service.dashboard() }
}
