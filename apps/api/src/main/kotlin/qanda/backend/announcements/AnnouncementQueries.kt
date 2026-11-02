package qanda.backend.announcements

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import java.util.UUID

@Mapper interface AnnouncementQueries {
    fun lockAnnouncement(@Param("id") id: UUID): Announcement?
    fun announcements(@Param("userId") userId: UUID?,@Param("platform") platform: String?,@Param("offset") offset: Int,@Param("limit") limit: Int): List<Announcement>
    fun announcementCount(@Param("userId") userId: UUID?,@Param("platform") platform: String?): Long
    fun platforms(@Param("id") id: UUID): List<String>
    fun recipients(@Param("id") id: UUID): List<UUID>
    fun clearPlatforms(@Param("id") id: UUID)
    fun clearRecipients(@Param("id") id: UUID)
    fun addPlatform(@Param("id") id: UUID,@Param("platform") platform: String)
    fun addRecipient(@Param("id") id: UUID,@Param("userId") userId: UUID)
    fun updateAnnouncement(@Param("row") row: Announcement)
}
