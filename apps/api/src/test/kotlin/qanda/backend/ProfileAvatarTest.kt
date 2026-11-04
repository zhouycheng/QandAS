package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import qanda.backend.identity.profileAvatar
import qanda.backend.identity.DefaultAvatars
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.Base64
import javax.imageio.ImageIO

class ProfileAvatarTest {
    @Test fun `all six default avatars meet the existing image limits`() {
        assertEquals(6,DefaultAvatars.values.size)
        assertEquals(6,DefaultAvatars.values.distinct().size)
        DefaultAvatars.values.forEach { avatar ->
            assertEquals(avatar,profileAvatar(avatar))
            val image=ImageIO.read(Base64.getDecoder().decode(avatar.substringAfter(',')).inputStream())
            assertEquals(160,image.width);assertEquals(160,image.height)
        }
        repeat(20) { assertTrue(DefaultAvatars.random() in DefaultAvatars.values) }
    }
    private fun image(size: Int=160): String {
        val output=ByteArrayOutputStream()
        ImageIO.write(BufferedImage(size,size,BufferedImage.TYPE_INT_RGB),"png",output)
        return "data:image/png;base64,"+Base64.getEncoder().encodeToString(output.toByteArray())
    }
    @Test fun `avatars validate bytes format dimensions and encoded size`() {
        val valid=image()
        assertEquals(valid,profileAvatar(valid))
        listOf("https://example.test/avatar.png","data:image/svg+xml;base64,PHN2Zy8+","data:image/png;base64,invalid!",valid.replace("image/png","image/jpeg"),image(257),"data:image/png;base64,"+"A".repeat(87400)).forEach {
            assertThrows(qanda.backend.platform.http.ApiException::class.java) { profileAvatar(it) }
        }
    }
}
