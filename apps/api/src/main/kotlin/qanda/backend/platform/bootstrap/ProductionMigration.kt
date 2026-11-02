package qanda.backend.platform.bootstrap

import org.flywaydb.core.Flyway

object ProductionMigration {
    fun run() {
        val url = System.getenv("BACKEND_DB_URL") ?: error("BACKEND_DB_URL is required")
        require(url.matches(Regex("jdbc:postgresql://[^/]+/qanda_backend(?:\\?.*)?"))) { "A dedicated qanda_backend database is required" }
        Flyway.configure().dataSource(url, System.getenv("BACKEND_DB_USER") ?: "qanda_backend",
            System.getenv("BACKEND_DB_PASSWORD") ?: error("BACKEND_DB_PASSWORD is required"))
            .locations("classpath:db/migration").cleanDisabled(true).baselineOnMigrate(false)
            .initSql("SET lock_timeout='3s'; SET statement_timeout='30s'").load().migrate()
    }
}
