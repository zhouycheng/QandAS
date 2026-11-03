package qanda.backend

import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.testcontainers.containers.PostgreSQLContainer
import qanda.backend.platform.bootstrap.DeploymentHealth

class DeploymentPostgresTest : PostgresFixture() {
    @Autowired lateinit var deploymentHealth: DeploymentHealth

    @Test fun `readiness requires a running worker and recovers without changing practice data`() {
        assertEquals("UP", deploymentHealth.health().status.code)
        consumers.stop()
        try { assertEquals("DOWN", deploymentHealth.health().status.code) }
        finally { consumers.start() }
        for (attempt in 1..100) {
            if (deploymentHealth.health().status.code == "UP") return
            Thread.sleep(100)
        }
        fail<Unit>("Worker readiness did not recover")
    }

    @Test fun `production initializes the complete V1 schema once`() {
        PostgreSQLContainer<Nothing>("postgres:17.6-alpine").apply { withDatabaseName("qanda_backend") }.use { database ->
            database.start()
            fun flyway() = Flyway.configure().dataSource(database.jdbcUrl, database.username, database.password)
                .locations("classpath:db/migration").cleanDisabled(true).load()
            assertEquals(listOf("1"),flyway().info().all().mapNotNull { it.version?.version })
            assertEquals(1,flyway().migrate().migrationsExecuted)
            java.sql.DriverManager.getConnection(database.jdbcUrl,database.username,database.password).use { connection ->
                connection.createStatement().use { statement ->
                    statement.executeQuery("SELECT profile_setup_seen FROM user_account LIMIT 0").close()
                    statement.executeQuery("SELECT expires_at FROM test_account LIMIT 0").close()
                    statement.executeQuery("SELECT include_in_statistics FROM monitoring_student LIMIT 0").close()
                    statement.executeQuery("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='email_challenge_purpose_check'").use { row ->
                        assertTrue(row.next());assertTrue(row.getString(1).contains("LOGIN"))
                    }
                }
            }
            assertEquals(0,flyway().migrate().migrationsExecuted)
            assertTrue(flyway().validateWithResult().validationSuccessful)
        }
    }
}
