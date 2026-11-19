package qanda.backend.bankpackage

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.content.ContentAccess
import qanda.backend.platform.http.*
import qanda.backend.platform.security.Actor
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat
import java.util.UUID

data class UploadSize(val sizeBytes: Long)
data class UploadHandle(val uploadId: UUID)

@Service
class BankUploads(private val jdbc: JdbcTemplate, private val access: ContentAccess,private val environment: org.springframework.core.env.Environment) {
    companion object { const val CHUNK = 4 * 1024 * 1024 }

    @Transactional
    fun start(actor: Actor, bank: UUID, size: Long): UploadHandle {
        access.bank(actor, bank, true)
        if (size !in 1..268435456L) invalid("/sizeBytes")
        val id = UUID.randomUUID()
        jdbc.update("INSERT INTO bank_package_upload(id,admin_id,bank_id,size_bytes,expires_at) VALUES(?,?,?,?,now()+interval '1 hour')", id, actor.id, bank, size)
        return UploadHandle(id)
    }

    private fun size(actor: Actor, bank: UUID, id: UUID): Long =
        jdbc.queryForList("SELECT size_bytes FROM bank_package_upload WHERE id=? AND admin_id=? AND bank_id=? AND expires_at>now()", Long::class.java, id, actor.id, bank).singleOrNull() ?: missing()

    @Transactional
    fun put(actor: Actor, bank: UUID, id: UUID, part: Int, bytes: ByteArray) {
        val size = size(actor, bank, id)
        if (part < 0 || part.toLong()*CHUNK >= size || bytes.size.toLong() != minOf(CHUNK.toLong(), size-part.toLong()*CHUNK)) invalid("/part")
        val inserted = jdbc.update("INSERT INTO bank_package_part VALUES(?,?,?) ON CONFLICT DO NOTHING", id, part, bytes)
        if (inserted == 0 && jdbc.queryForObject("SELECT bytes=? FROM bank_package_part WHERE upload_id=? AND part_number=?", Boolean::class.java, bytes, id, part) != true)
            conflict("UPLOAD_PART_CONFLICT", "分块内容已变化，请重新上传")
    }

    fun <T> withArchive(actor: Actor, bank: UUID, id: UUID, work: (Path,String) -> T): T {
        val size = size(actor, bank, id)
        val path = Files.createTempFile("qanda-bank-", ".zip")
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            Files.newOutputStream(path).use { out ->
                for (part in 0 until ((size+CHUNK-1)/CHUNK).toInt()) {
                    val bytes = jdbc.queryForList("SELECT bytes FROM bank_package_part WHERE upload_id=? AND part_number=?", ByteArray::class.java, id, part).singleOrNull() ?: invalid("/parts", message="题包分块尚未传完")
                    out.write(bytes);digest.update(bytes)
                }
            }
            return work(path,HexFormat.of().formatHex(digest.digest()))
        } finally { Files.deleteIfExists(path) }
    }

    @Scheduled(fixedDelay = 300000)
    fun expire() {
        if(environment.getProperty("qanda.backend.role","api") !in setOf("worker","all")) return
        jdbc.update("DELETE FROM bank_package_upload WHERE expires_at<=now()")
        jdbc.update("DELETE FROM bank_agent_transfer WHERE expires_at<=now()")
        jdbc.update("DELETE FROM bank_agent_client c WHERE created_at<now()-interval '30 days' AND NOT EXISTS (SELECT 1 FROM bank_agent_grant g WHERE g.client_id=c.id::text)")
    }
}
