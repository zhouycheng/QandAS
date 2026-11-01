package qanda.backend.announcements

import jakarta.servlet.http.HttpServletRequest
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import qanda.backend.platform.security.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1",produces=["application/json"])
class AnnouncementController(private val service: AnnouncementService,private val sessions: Sessions,private val commands: Commands) {
    @GetMapping("/announcements") fun announcements(@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<AnnouncementView> = service.announcements(sessions.student(),PageSpec(page,pageSize))
    @GetMapping("/admin/announcements") fun adminAnnouncements(@RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<AnnouncementView> = service.announcements(sessions.admin(true),PageSpec(page,pageSize))
    @PostMapping("/admin/announcements") fun createAnnouncement(@RequestBody input: AnnouncementInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin(true);return commands.run(a,key,"CREATE_ANNOUNCEMENT",input,MutationResult::class.java,r.requestId()) { service.saveAnnouncement(a,null,input) } }
    @PutMapping("/admin/announcements/{id}") fun updateAnnouncement(@PathVariable id: UUID,@RequestBody input: AnnouncementInput,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin(true);return commands.run(a,key,"UPDATE_ANNOUNCEMENT:$id",input,MutationResult::class.java,r.requestId()) { service.saveAnnouncement(a,id,input) } }
    @DeleteMapping("/admin/announcements/{id}") fun deleteAnnouncement(@PathVariable id: UUID,@RequestParam expectedVersion: Long,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): MutationResult { val a=sessions.admin(true);return commands.run(a,key,"DELETE_ANNOUNCEMENT:$id",expectedVersion,MutationResult::class.java,r.requestId()) { service.deleteAnnouncement(id,expectedVersion) } }
}
