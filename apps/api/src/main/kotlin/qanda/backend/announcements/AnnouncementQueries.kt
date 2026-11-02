package qanda.backend.announcements

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import java.util.UUID

@Mapper interface AnnouncementQueries {
    fun lockAnnouncement(@Param("id") id: UUID): Announcement?
    fun announcements(@Param("userId") userId: UUID?,@Param("offset") offset: Int,@Param("limit") limit: Int): List<Announcement>
    fun announcementCount(@Param("userId") userId: UUID?): Long
    fun recipients(@Param("id") id: UUID): List<UUID>
    fun clearRecipients(@Param("id") id: UUID)
    fun addRecipient(@Param("id") id: UUID,@Param("userId") userId: UUID)
    fun updateAnnouncement(@Param("row") row: Announcement)
}
