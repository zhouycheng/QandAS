package qanda.backend.identity

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.core.io.ClassPathResource

internal object DefaultAvatars {
    val values: List<String> = ClassPathResource("default-avatars.json").inputStream.use { input ->
        ObjectMapper().readTree(input).map { profileAvatar(it["avatarUrl"].asText()) }
    }
    fun random(): String = values.random()
}
