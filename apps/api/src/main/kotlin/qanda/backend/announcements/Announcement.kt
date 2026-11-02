package qanda.backend.announcements

import com.baomidou.mybatisplus.annotation.*
import java.time.Instant
import java.util.UUID

@TableName("announcement")
class Announcement {
    @TableId(type = IdType.INPUT)
    var id: UUID? = null
    var title: String = ""
    var summary: String = ""
    var body: String = ""
    var audience: String = "ALL"
    var status: String = "DRAFT"
    var publishAt: Instant? = null
    var pinned: Boolean = false
    var showCommunityGroup: Boolean = false
    var version: Long = 1
    var createdBy: UUID? = null
    var updatedAt: Instant = Instant.now()
}
