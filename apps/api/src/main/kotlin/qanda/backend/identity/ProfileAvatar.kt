package qanda.backend.identity

import java.io.ByteArrayInputStream
import java.util.Base64
import javax.imageio.ImageIO

internal fun profileAvatar(value: String): String {
    fun invalidAvatar(): Nothing = qanda.backend.platform.http.invalid("avatar","INVALID_AVATAR","头像无法保存，请重新选择头像")
    if(value.length>87407) invalidAvatar()
    val prefix=listOf("data:image/jpeg;base64,","data:image/png;base64,").firstOrNull { value.startsWith(it) } ?: invalidAvatar()
    val bytes=try { Base64.getDecoder().decode(value.substring(prefix.length)) } catch(_: IllegalArgumentException) { invalidAvatar() }
    if(bytes.isEmpty() || bytes.size>65536) invalidAvatar()
    try {
        ImageIO.createImageInputStream(ByteArrayInputStream(bytes)).use { input ->
            val readers=ImageIO.getImageReaders(input)
            if(!readers.hasNext()) invalidAvatar()
            val reader=readers.next()
            try {
                reader.input=input
                val format=if(prefix.contains("jpeg")) "JPEG" else "PNG"
                if(!reader.formatName.equals(format,true) || reader.getWidth(0) !in 1..256 || reader.getHeight(0) !in 1..256) invalidAvatar()
                if(reader.read(0)==null) invalidAvatar()
            } finally { reader.dispose() }
        }
    } catch(_: java.io.IOException) { invalidAvatar() }
    return prefix+Base64.getEncoder().encodeToString(bytes)
}
