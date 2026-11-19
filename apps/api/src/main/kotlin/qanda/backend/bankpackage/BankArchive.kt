package qanda.backend.bankpackage

import com.fasterxml.jackson.core.StreamReadFeature
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import qanda.backend.platform.http.invalid
import java.nio.file.Path
import java.util.zip.ZipFile

internal class BankArchive(path: Path, private val json: ObjectMapper) : AutoCloseable {
    private val zip = try { ZipFile(path.toFile()) } catch (_: java.util.zip.ZipException) { invalid("/zip",message="无法读取 ZIP 文件") }
    private val images = mutableMapOf<String, String>()
    private val imagePath = Regex("""assets/images/(?:[\p{L}\p{N}_. -]+/)*[\p{L}\p{N}_. -]+\.(png|jpe?g|webp)""", RegexOption.IGNORE_CASE)

    fun read(): JsonNode {
        val names = mutableSetOf<String>()
        var size = 0L
        for (entry in zip.entries()) {
            val name = entry.name.removeSuffix("/")
            if (name.split('/').any { it.isEmpty() || it == "." || it == ".." } || !names.add(name) || names.size > 10000)
                invalid("/zip", message = "题包路径重复、无效或条目过多")
            if (entry.isDirectory) {
                if (entry.size != 0L || name != "assets" && name != "assets/images" && !name.startsWith("assets/images/")) invalid("/zip")
                continue
            }
            val limit = when {
                name == "bank.json" -> 32L shl 20
                name == "review-report.md" -> 2L shl 20
                imagePath.matches(name) -> 5L shl 20
                else -> invalid("/zip", message = "题包包含不支持的文件")
            }
            if (entry.size !in 0..limit || size + entry.size > (256L shl 20)) invalid("/zip", message = "题包解压量超限")
            size += entry.size
        }
        if ("review-report.md" in names) bytes("review-report.md")
        val root = try { json.factory.createParser(bytes("bank.json")).use { parser ->
            parser.enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION.mappedFeature())
            val doc = json.readTree<JsonNode>(parser) ?: invalid("/bank.json")
            if (parser.nextToken() != null) invalid("/bank.json")
            doc
        } } catch (_: com.fasterxml.jackson.core.JsonProcessingException) { invalid("/bank.json",message="题包清单不是有效 JSON") }
        if (root.path("format").asText() != "qanda-question-bank" || root.path("version").asText() != "1.0" ||
            !root.path("questions").isArray || !root.path("assets").isArray || !root.path("chapters").isArray || !root.path("sources").isArray ||
            root.path("bank").path("name").asText().isBlank() || root.fieldNames().asSequence().any { it !in setOf("format","version","bank","chapters","assets","sources","questions") }) invalid("/bank.json")
        val paths = mutableSetOf<String>()
        root["assets"].forEach { asset ->
            val id = asset.path("id").asText()
            val name = asset.path("path").asText()
            if (id.isBlank() || !imagePath.matches(name) || images.put(id, name) != null || !paths.add(name)) invalid("/assets")
            if (name !in names) invalid("/assets",message="题包缺少图片 $name")
        }
        if (names.filter(imagePath::matches).toSet() != paths) invalid("/assets", message = "图片清单与题包内容不符")
        return root
    }

    fun image(id: String): Pair<String, ByteArray> {
        val name = images[id] ?: invalid("/assetIds")
        return media(name) to bytes(name)
    }

    private fun media(name: String) = when (name.substringAfterLast('.').lowercase()) {
        "png" -> "image/png"
        "webp" -> "image/webp"
        else -> "image/jpeg"
    }

    private fun bytes(name: String): ByteArray {
        val entry = zip.getEntry(name) ?: invalid("/zip", message = "题包缺少 $name")
        val bytes = zip.getInputStream(entry).use { it.readNBytes(entry.size.toInt() + 1) }
        if (bytes.size.toLong() != entry.size || java.util.zip.CRC32().apply { update(bytes) }.value != entry.crc)
            invalid("/zip", message = "题包文件校验失败")
        return bytes
    }

    override fun close() = zip.close()
}
