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

    @Test fun `existing databases upgrade query views and development initialization loads the same schema`() {
        PostgreSQLContainer<Nothing>("postgres:17.6-alpine").apply { withDatabaseName("qanda_backend") }.use { database ->
            database.start()
            fun flyway() = Flyway.configure().dataSource(database.jdbcUrl, database.username, database.password)
                .locations("classpath:db/migration").cleanDisabled(true).load()
            assertEquals(listOf("1","2","3"),flyway().info().all().mapNotNull { it.version?.version })
            assertEquals(1,Flyway.configure().dataSource(database.jdbcUrl,database.username,database.password)
                .locations("classpath:db/migration").target("1").load().migrate().migrationsExecuted)
            java.sql.DriverManager.getConnection(database.jdbcUrl,database.username,database.password).use { connection ->
                connection.createStatement().use { it.executeUpdate("INSERT INTO subject(id,name,status) VALUES('00000000-0000-0000-0000-000000000001','Existing course','ACTIVE')") }
            }
            assertEquals(1,Flyway.configure().dataSource(database.jdbcUrl,database.username,database.password)
                .locations("classpath:db/migration").target("2").load().migrate().migrationsExecuted)
            assertEquals(1,flyway().migrate().migrationsExecuted)
            java.sql.DriverManager.getConnection(database.jdbcUrl,database.username,database.password).use { connection ->
                connection.createStatement().use { statement ->
                    statement.executeQuery("SELECT auth_method FROM user_session LIMIT 0").close()
                    statement.executeQuery("SELECT college_id,major_id,grade FROM bank_category LIMIT 0").close()
                    statement.executeQuery("SELECT expires_at FROM test_account LIMIT 0").close()
                    statement.executeQuery("SELECT id FROM active_question LIMIT 0").close()
                    statement.executeQuery("SELECT id FROM visible_question_bank LIMIT 0").close()
                    statement.executeQuery("SELECT name FROM subject WHERE id='00000000-0000-0000-0000-000000000001'").use { row ->
                        assertTrue(row.next());assertEquals("Existing course",row.getString(1))
                    }
                    statement.executeQuery("SELECT include_in_statistics FROM monitoring_student LIMIT 0").close()
                    statement.executeQuery("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='email_challenge_purpose_check'").use { row ->
                        assertTrue(row.next());assertTrue(row.getString(1).contains("LOGIN"))
                    }
                }
            }
            assertEquals(0,flyway().migrate().migrationsExecuted)
            assertTrue(flyway().validateWithResult().validationSuccessful)
            val source=org.springframework.jdbc.datasource.DriverManagerDataSource(database.jdbcUrl,database.username,database.password)
            assertThrows(IllegalArgumentException::class.java) { qanda.backend.platform.bootstrap.DatabaseCommands.initialize(source) }
            qanda.backend.platform.bootstrap.DatabaseCommands.initialize(source,reset=true)
            source.connection.use { connection -> connection.createStatement().use { statement ->
                statement.executeQuery("SELECT id FROM active_question LIMIT 0").close()
                statement.executeQuery("SELECT id FROM visible_question_bank LIMIT 0").close()
            } }
        }
    }
}
