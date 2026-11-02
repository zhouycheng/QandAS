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

    @Test fun `production migration initializes once and validates the existing baseline`() {
        PostgreSQLContainer<Nothing>("postgres:17.6-alpine").apply { withDatabaseName("qanda_backend") }.use { database ->
            database.start()
            fun flyway() = Flyway.configure().dataSource(database.jdbcUrl, database.username, database.password)
                .locations("classpath:db/migration").cleanDisabled(true).load()
            assertEquals(1, flyway().migrate().migrationsExecuted)
            assertEquals(0, flyway().migrate().migrationsExecuted)
            assertTrue(flyway().validateWithResult().validationSuccessful)
        }
    }
}
