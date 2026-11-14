package qanda.backend

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

    @Test fun `fresh database initialization loads complete schema and explicit reset replaces data`() {
        PostgreSQLContainer<Nothing>("postgres:17.6-alpine").apply { withDatabaseName("qanda_backend") }.use { database ->
            database.start()
            val source=org.springframework.jdbc.datasource.DriverManagerDataSource(database.jdbcUrl,database.username,database.password)
            qanda.backend.platform.bootstrap.DatabaseCommands.initialize(source)
            source.connection.use { connection -> connection.createStatement().use { statement ->
                statement.executeQuery("SELECT result_source FROM practice_result WHERE false").close()
                statement.executeQuery("SELECT id FROM active_question WHERE false").close()
                statement.executeQuery("SELECT id FROM visible_question_bank WHERE false").close()
                statement.executeUpdate("INSERT INTO subject(id,name,status) VALUES(gen_random_uuid(),'Test course','ACTIVE')")
                statement.execute("ALTER TABLE practice_item DROP COLUMN confirmed_at")
                statement.execute("ALTER TABLE question_feedback DROP COLUMN read_version")
                statement.execute("ALTER TABLE course_request DROP COLUMN read_version")
            } }
            repeat(2) {
                val upgrade=ProcessBuilder(java.nio.file.Path.of(System.getProperty("java.home"),"bin/java").toString(),"-jar","target/qanda-backend-1.0.0.jar","schema-init").apply {
                    environment().putAll(mapOf("BACKEND_DB_URL" to database.jdbcUrl,"BACKEND_DB_USER" to database.username,"BACKEND_DB_PASSWORD" to database.password))
                    redirectErrorStream(true)
                }.start()
                assertTrue(upgrade.waitFor(30,java.util.concurrent.TimeUnit.SECONDS));assertEquals(0,upgrade.exitValue(),upgrade.inputStream.bufferedReader().readText())
                source.connection.use { connection -> connection.createStatement().use { statement ->
                    statement.executeQuery("SELECT confirmed_at FROM practice_item WHERE false").close()
                    statement.executeQuery("SELECT f.read_version,c.read_version FROM question_feedback f,course_request c WHERE false").close()
                    statement.executeQuery("SELECT count(*) FROM subject").use { row -> row.next();assertEquals(1,row.getInt(1),"结构升级保留已有记录") }
                } }
            }
            assertThrows(IllegalArgumentException::class.java) { qanda.backend.platform.bootstrap.DatabaseCommands.initialize(source) }
            qanda.backend.platform.bootstrap.DatabaseCommands.initialize(source,reset=true)
            source.connection.use { connection -> connection.createStatement().use { statement ->
                statement.executeQuery("SELECT count(*) FROM subject").use { row -> row.next();assertEquals(0,row.getInt(1)) }
            } }
        }
    }
}
