package qanda.backend.announcements

import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.identity.api.AccountDirectory
import qanda.backend.platform.http.*
import qanda.backend.platform.security.Actor
import java.time.Clock
import java.util.UUID

@Service
@Transactional(timeout=3)
class AnnouncementService(private val announcements: AnnouncementMapper,private val sql: AnnouncementQueries,private val users: AccountDirectory,private val clock: Clock) {
    fun announcement(row: Announcement,admin: Boolean): AnnouncementView = AnnouncementView(row.id!!,row.title,row.summary,row.body,row.audience,sql.platforms(row.id!!),if(admin) sql.recipients(row.id!!) else emptyList(),
        if(row.status=="SCHEDULED" && row.publishAt?.isAfter(clock.instant())==false) "PUBLISHED" else row.status,row.publishAt,row.version,row.updatedAt,row.pinned,row.showCommunityGroup)
    fun announcements(actor: Actor,p: PageSpec): Page<AnnouncementView> {
        val userId=actor.takeIf { it.kind=="USER" }?.id
        return Page(sql.announcements(userId,actor.clientType,p.offset,p.pageSize).map { announcement(it,actor.kind=="ADMIN") },sql.announcementCount(userId,actor.clientType),p.page,p.pageSize)
    }
    fun saveAnnouncement(actor: Actor,id: UUID?,input: AnnouncementInput): MutationResult {
        if(input.audience !in setOf("ALL","SELECTED") || input.status !in setOf("DRAFT","PUBLISHED","SCHEDULED")) invalid("/status")
        if(input.platforms.any { it !in setOf("WEB","MINI_PROGRAM") } || input.platforms.distinct().size!=input.platforms.size || input.userIds.distinct().size!=input.userIds.size || input.userIds.size>1000) invalid("/audience")
        if(input.audience=="ALL" && input.userIds.isNotEmpty() || input.audience=="SELECTED" && input.userIds.isEmpty()) invalid("/userIds")
        if(input.status!="DRAFT" && (input.platforms.isEmpty() || input.summary.isBlank() || input.body.isBlank())) invalid("/body")
        if(input.status=="SCHEDULED" && input.publishAt==null) invalid("/publishAt")
        input.userIds.forEach { if(!users.exists(it)) invalid("/userIds") }
        val row=id?.let { sql.lockAnnouncement(it) ?: missing() } ?: Announcement().apply { this.id=UUID.randomUUID();createdBy=actor.id }
        if(id!=null) requireVersion(input.expectedVersion ?: invalid("/expectedVersion"),row.version)
        row.title=name(input.title);row.summary=text(input.summary,500);row.body=text(input.body,40000);row.audience=input.audience;row.status=input.status;row.publishAt=input.publishAt;row.updatedAt=clock.instant()
        row.pinned=input.pinned;row.showCommunityGroup=input.showCommunityGroup
        if(id==null) announcements.insert(row) else { row.version++;sql.updateAnnouncement(row) }
        sql.clearPlatforms(row.id!!);sql.clearRecipients(row.id!!);input.platforms.forEach { sql.addPlatform(row.id!!,it) };input.userIds.forEach { sql.addRecipient(row.id!!,it) }
        return MutationResult(row.id!!,row.version)
    }
    fun deleteAnnouncement(id: UUID,expectedVersion: Long): MutationResult {
        val row=sql.lockAnnouncement(id) ?: missing();requireVersion(expectedVersion,row.version);sql.clearPlatforms(id);sql.clearRecipients(id);announcements.deleteById(id);return MutationResult(id,row.version)
    }
}
