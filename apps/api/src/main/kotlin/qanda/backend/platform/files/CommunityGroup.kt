package qanda.backend.platform.files

import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.CacheControl
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import qanda.backend.platform.security.Commands
import qanda.backend.platform.security.requestId
import java.time.Instant
import java.util.Base64
import java.util.UUID

data class CommunityGroupView(val version: Long, val expiresAt: Instant?, val available: Boolean)
data class CommunityGroupInput(val expectedVersion: Long, val image: String, val expiresAt: Instant)

@Service
class CommunityGroup(private val jdbc: JdbcTemplate) {
    fun read(): CommunityGroupView = jdbc.queryForObject(
        "SELECT version, expires_at, image IS NOT NULL AS present FROM community_group WHERE id=1"
    ) { row, _ ->
        val expires = row.getTimestamp("expires_at")?.toInstant()
        CommunityGroupView(row.getLong("version"), expires, row.getBoolean("present") && expires != null && expires.isAfter(Instant.now()))
    }!!

    fun image(): ByteArray {
        val bytes = jdbc.queryForObject("SELECT CASE WHEN expires_at > now() THEN image END FROM community_group WHERE id=1", ByteArray::class.java)
        return bytes ?: throw ApiException(org.springframework.http.HttpStatus.NOT_FOUND, "GROUP_QR_UNAVAILABLE", "群二维码暂不可用")
    }

    fun save(input: CommunityGroupInput): CommunityGroupView {
        if (!input.expiresAt.isAfter(Instant.now())) invalid("expiresAt", message="有效期必须晚于当前时间")
        val parts = input.image.split(",", limit=2)
        if (parts.size != 2 || parts[0] !in setOf("data:image/png;base64", "data:image/jpeg;base64")) invalid("image", message="请选择 PNG 或 JPEG 图片")
        if (parts[1].length > 7_000_000) invalid("image", message="图片不能超过 5 MiB")
        val raw = try { Base64.getDecoder().decode(parts[1]) } catch (_: IllegalArgumentException) { invalid("image", message="图片格式无效") }
        val normalized = ImageNormalizer.normalize(ImageNormalizer.readBounded(raw.inputStream(), 5L*1024*1024), ImageLimits(parts[0].substringAfter("data:").substringBefore(';')))
        val changed = jdbc.update("UPDATE community_group SET image=?, expires_at=?, version=version+1, updated_at=now() WHERE id=1 AND version=?", normalized.bytes, java.sql.Timestamp.from(input.expiresAt), input.expectedVersion)
        if (changed != 1) conflict()
        return read()
    }
}

@RestController
@RequestMapping("/api/v1", produces=["application/json"])
class CommunityGroupController(private val group: CommunityGroup, private val sessions: Sessions, private val commands: Commands) {
    @GetMapping("/community/group") fun publicGroup(): CommunityGroupView = group.read()
    @GetMapping("/community/group/image", produces=["image/png"])
    fun image(): ResponseEntity<ByteArray> = ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.IMAGE_PNG).body(group.image())
    @GetMapping("/admin/community/group") fun adminGroup(): CommunityGroupView { sessions.admin(); return group.read() }
    @PutMapping("/admin/community/group")
    fun save(@RequestBody input: CommunityGroupInput, @RequestHeader("Idempotency-Key") key: UUID, request: HttpServletRequest): CommunityGroupView {
        val actor=sessions.admin()
        return commands.run(actor, key, "COMMUNITY_GROUP", input, CommunityGroupView::class.java, request.requestId()) { group.save(input) }
    }
}
