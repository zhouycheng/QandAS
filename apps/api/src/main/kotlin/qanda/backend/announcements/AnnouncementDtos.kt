package qanda.backend.announcements

import io.swagger.v3.oas.annotations.media.Schema
import java.time.Instant
import java.util.UUID

data class AnnouncementInput(val title: String,val summary: String="",val body: String="",@field:Schema(allowableValues=["ALL","SELECTED"]) val audience: String="ALL",val userIds: List<UUID> = emptyList(),
                             @field:Schema(allowableValues=["DRAFT","PUBLISHED","SCHEDULED"]) val status: String="DRAFT",val publishAt: Instant?=null,val expectedVersion: Long?=null,val pinned: Boolean=false,val showCommunityGroup: Boolean=false)
data class AnnouncementView(val id: UUID,val title: String,val summary: String,val body: String,val audience: String,val userIds: List<UUID>,val status: String,val publishAt: Instant?,val version: Long,val updatedAt: Instant,val pinned: Boolean,val showCommunityGroup: Boolean)
