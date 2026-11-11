package qanda.backend.practice

import jakarta.servlet.http.HttpServletRequest
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import qanda.backend.platform.security.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1",produces=["application/json"])
class PracticeController(private val service: PracticeService,private val sessions: Sessions,private val commands: Commands) {
    @PostMapping("/practice/scope-preview") fun preview(@RequestBody input: ScopeInput): ScopeView=service.preview(sessions.studentOrGuest(),input)
    @PostMapping("/practice/trial-snapshots") fun trialSnapshot(@RequestBody input: TrialSnapshotInput): TrialSnapshotView { sessions.studentOrGuest();return service.trialSnapshot(input) }
    @PostMapping("/practice/sessions") fun create(@RequestBody input: CreatePracticeInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): PracticeView { val a=sessions.student();return commands.run(a,key,"CREATE_PRACTICE",input,PracticeView::class.java,r.requestId()) { service.create(a,input) } }
    @GetMapping("/practice/sessions/{id}") fun read(@PathVariable id: UUID): PracticeView=service.read(sessions.student().id,id)
    @GetMapping("/practice/sessions/{id}/result") fun result(@PathVariable id: UUID): ResultView=service.result(sessions.student().id,id)
    @PutMapping("/practice/sessions/{id}/items/{itemId}/self-assessment") fun assess(@PathVariable id: UUID,@PathVariable itemId: UUID,@RequestBody input: SelfAssessmentInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): ResultView { val a=sessions.student();return commands.run(a,key,"SELF_ASSESSMENT:$id:$itemId",input,ResultView::class.java,r.requestId()) { service.assess(a,id,itemId,input) } }
    @PostMapping("/practice/sessions/{id}/cancel") fun cancel(@PathVariable id: UUID,@RequestBody input: ExpectedVersionInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.student();return commands.run(a,key,"CANCEL_PRACTICE:$id",input,MutationResult::class.java,r.requestId()) { service.cancel(a,id,input) } }
    @GetMapping("/practice/sessions/{id}/snapshot") fun snapshot(@PathVariable id: UUID,@RequestParam deviceId: UUID,@RequestHeader("X-Practice-Writer") writerToken: UUID): PracticeView = service.snapshot(sessions.student(),id,deviceId,writerToken)
}
