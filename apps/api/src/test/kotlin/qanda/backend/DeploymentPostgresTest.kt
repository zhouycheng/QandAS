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
            val baseline=Flyway.configure().dataSource(database.jdbcUrl,database.username,database.password)
                .locations("classpath:db/migration").target("1").cleanDisabled(true).load()
            assertEquals(1,baseline.migrate().migrationsExecuted)
            java.sql.DriverManager.getConnection(database.jdbcUrl,database.username,database.password).use { connection ->
                connection.createStatement().use { statement ->
                    statement.execute("INSERT INTO user_account(id,account_code,nickname) VALUES('00000000-0000-0000-0000-000000000001','MIGRATION','保留用户')")
                    statement.execute("INSERT INTO college(id,code,name,status) VALUES('00000000-0000-0000-0000-000000000010','MIGRATION','迁移学院','ACTIVE')")
                    statement.execute("INSERT INTO major(id,college_id,code,name,status) VALUES('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000010','M','迁移专业','ACTIVE')")
                    statement.execute("INSERT INTO user_account(id,account_code,nickname) VALUES('00000000-0000-0000-0000-000000000002','COMPLETE','完整用户')")
                    statement.execute("INSERT INTO user_profile(user_id,major_id,grade,grade_academic_year) VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000011',2,2026)")
                }
            }
            assertEquals(1,flyway().migrate().migrationsExecuted)
            java.sql.DriverManager.getConnection(database.jdbcUrl,database.username,database.password).use { connection ->
                connection.createStatement().use { statement ->
                    statement.executeQuery("SELECT profile_setup_seen FROM user_account WHERE account_code='COMPLETE'").use { row -> assertTrue(row.next());assertTrue(row.getBoolean(1)) }
                    statement.executeQuery("SELECT nickname,profile_setup_seen FROM user_account WHERE account_code='MIGRATION'").use { row ->
                        assertTrue(row.next());assertEquals("保留用户",row.getString(1));assertFalse(row.getBoolean(2))
                    }
                }
            }
            assertEquals(0, flyway().migrate().migrationsExecuted)
            assertTrue(flyway().validateWithResult().validationSuccessful)
        }
    }
}
