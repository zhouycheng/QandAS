package qanda.backend.catalog

import jakarta.servlet.http.HttpServletRequest
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import qanda.backend.platform.security.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1",produces=["application/json"])
class CatalogController(private val service: CatalogService,private val sessions: Sessions,private val commands: Commands) {
    @GetMapping("/admin/colleges/{id}") fun adminCollege(@PathVariable id: UUID): CollegeView { sessions.admin();return service.college(id) }
    @GetMapping("/admin/majors/{id}") fun adminMajor(@PathVariable id: UUID): MajorView { sessions.admin();return service.major(id) }
    @GetMapping("/admin/subjects/{id}") fun adminSubject(@PathVariable id: UUID): SubjectView { sessions.admin();return service.subject(id,false) }
    @GetMapping("/admin/subjects/{id}/user-access") fun userAccess(@PathVariable id: UUID,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<SubjectAccessView> {
        sessions.admin();return service.userAccess(id,PageSpec(page,pageSize))
    }
    @PostMapping("/admin/subjects/{id}/user-access") fun grant(@PathVariable id: UUID,@RequestBody input: SubjectAccessInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult {
        val a=sessions.admin();return commands.run(a,key,"GRANT_SUBJECT:$id",input,MutationResult::class.java,r.requestId()) { service.access(id,input.userId,input.expectedVersion,a.id,true) }
    }
    @DeleteMapping("/admin/subjects/{id}/user-access/{userId}") fun revoke(@PathVariable id: UUID,@PathVariable userId: UUID,@RequestParam expectedVersion: Long,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult {
        val a=sessions.admin();return commands.run(a,key,"REVOKE_SUBJECT:$id:$userId",expectedVersion,MutationResult::class.java,r.requestId()) { service.access(id,userId,expectedVersion,a.id,false) }
    }
    @GetMapping("/colleges") fun colleges(@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<CollegeView> = service.colleges(PageSpec(page,pageSize),false)
    @GetMapping("/colleges/{id}/majors") fun majors(@PathVariable id: UUID,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<MajorView> = service.majors(id,PageSpec(page,pageSize),false)
    @GetMapping("/subjects") fun subjects(@RequestParam(required=false) keyword: String?,@RequestParam(defaultValue="false") includeProgress: Boolean,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<SubjectView> { val actor=sessions.studentOrGuest();return service.subjects(PageSpec(page,pageSize),keyword,true,actor?.id,includeProgress) }
    @GetMapping("/subjects/{id}") fun subject(@PathVariable id: UUID,@RequestParam(defaultValue="false") includeProgress: Boolean): SubjectView { val actor=sessions.studentOrGuest();return service.subject(id,true,actor?.id,includeProgress) }
    @GetMapping("/admin/directory-summary") fun directory(@RequestParam(required=false) collegeId: UUID?,@RequestParam(required=false) majorId: UUID?): DirectorySummary { sessions.admin();return service.directory(collegeId,majorId) }
    @GetMapping("/admin/colleges") fun adminColleges(@RequestParam(required=false) keyword: String?,@RequestParam(required=false) status: String?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<CollegeView> { sessions.admin();return service.colleges(PageSpec(page,pageSize),true,keyword,status) }
    @GetMapping("/admin/majors") fun allMajors(@RequestParam(required=false) collegeId: UUID?,@RequestParam(required=false) keyword: String?,@RequestParam(required=false) status: String?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<MajorView> { sessions.admin();return service.majors(collegeId,PageSpec(page,pageSize),true,keyword,status) }
    @GetMapping("/admin/subjects") fun adminSubjects(@RequestParam(required=false) keyword: String?,@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<SubjectView> { sessions.admin();return service.subjects(PageSpec(page,pageSize),keyword,false) }
    @PostMapping("/admin/colleges") fun createCollege(@RequestBody input: CollegeInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin();return commands.run(a,key,"CREATE_COLLEGE",input,MutationResult::class.java,r.requestId()) { service.college(null,input) } }
    @PutMapping("/admin/colleges/{id}") fun updateCollege(@PathVariable id: UUID,@RequestBody input: CollegeInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin();return commands.run(a,key,"UPDATE_COLLEGE:$id",input,MutationResult::class.java,r.requestId()) { service.college(id,input) } }
    @PostMapping("/admin/majors") fun createMajor(@RequestBody input: MajorInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin();return commands.run(a,key,"CREATE_MAJOR",input,MutationResult::class.java,r.requestId()) { service.major(null,input) } }
    @PutMapping("/admin/majors/{id}") fun updateMajor(@PathVariable id: UUID,@RequestBody input: MajorInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin();return commands.run(a,key,"UPDATE_MAJOR:$id",input,MutationResult::class.java,r.requestId()) { service.major(id,input) } }
    @PostMapping("/admin/subjects") fun createSubject(@RequestBody input: SubjectInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin();return commands.run(a,key,"CREATE_SUBJECT",input,MutationResult::class.java,r.requestId()) { service.subject(null,input) } }
    @PutMapping("/admin/subjects/{id}") fun updateSubject(@PathVariable id: UUID,@RequestBody input: SubjectInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin();return commands.run(a,key,"UPDATE_SUBJECT:$id",input,MutationResult::class.java,r.requestId()) { service.subject(id,input) } }
}
