package db.migration

import org.flywaydb.core.api.migration.BaseJavaMigration
import org.flywaydb.core.api.migration.Context
import org.springframework.core.io.ClassPathResource

class V1__InitialSchema : BaseJavaMigration() {
    override fun getChecksum(): Int = java.util.zip.CRC32().apply {
        scripts.forEach { update(ClassPathResource(it).contentAsByteArray) }
    }.value.toInt()
    override fun migrate(context: Context) {
        context.connection.createStatement().use { statement ->
            scripts.forEach { statement.execute(ClassPathResource(it).getContentAsString(Charsets.UTF_8)) }
        }
    }
    companion object { private val scripts = listOf("db/schema.sql", "db/monitoring-permissions.sql") }
}
