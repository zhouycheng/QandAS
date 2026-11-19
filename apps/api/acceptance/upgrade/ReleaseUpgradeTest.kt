package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.testcontainers.containers.GenericContainer
import org.testcontainers.utility.MountableFile
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.imageio.ImageIO

/** Compile against the released fixture to exercise the original client payloads. */
class ReleaseUpgradeTest : PostgresFixture() {
    private fun snapshot(value: com.fasterxml.jackson.databind.JsonNode) = value.deepCopy<com.fasterxml.jackson.databind.JsonNode>().apply {
        // The entity's edit counter is live; revisionId and revision identify the issued content.
        findParents("revisionId").filterIsInstance<com.fasterxml.jackson.databind.node.ObjectNode>()
            .filter { it.has("questionBankId") }.forEach { it.remove("version") }
    }

    @Test fun upgrade() {
        val root=Path.of(System.getenv("QANDA_CANDIDATE_ROOT"))
        val jar=java.nio.file.Files.copy(root.resolve("apps/api/target/qanda-backend-1.0.0.jar"),
            Path.of("target/candidate-under-test.jar"),java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        val user=student()
        val bank=fixture()
        val base="/admin/question-banks/${bank.bank}"
        val image=ByteArrayOutputStream().also { ImageIO.write(BufferedImage(2,2,BufferedImage.TYPE_INT_ARGB),"png",it) }
        val file=id(json.readTree(raw("POST","$base/images",image.toByteArray(),contentType="image/png").body()))
        val readingInput=mapOf("questionBankId" to bank.bank,"type" to "READING","stem" to "读图","passage" to "旧图文","assetIds" to listOf(file),
            "subQuestions" to listOf(mapOf("id" to UUID.randomUUID(),"type" to "TRUE_FALSE","stem" to "旧判断","correctValue" to true,"explanation" to "旧解析")))
        val group=id(call("POST","/admin/questions",readingInput))
        val workbook=json.readTree("""{"fileId":"${UUID.randomUUID()}","subject":"Excel 升级演练","bank":{"name":"旧表格"},"questions":[{"id":"q","type":"TRUE_FALSE","stem":"旧表格题","correctValue":true}]}""")
        val boundary="qanda-${UUID.randomUUID()}"
        val multipart=ByteArrayOutputStream().apply {
            write("--$boundary\r\nContent-Disposition: form-data; name=\"files\"; filename=\"old.xlsx\"\r\n\r\n".toByteArray())
            write(qanda.backend.excel.ExcelWorkbook.write(workbook,"banks"))
            write("\r\n--$boundary\r\nContent-Disposition: form-data; name=\"options\"\r\n\r\n".toByteArray())
            write("""{"targets":{"${workbook["fileId"].asText()}":{"createSubject":true}}}""".toByteArray())
            write("\r\n--$boundary--\r\n".toByteArray())
        }.toByteArray()
        fun excelImport()=raw("POST","/admin/question-banks/excel/imports",multipart,contentType="multipart/form-data; boundary=$boundary").let {
            assertEquals(200,it.statusCode(),it.body()); json.readTree(it.body())
        }
        val excelReceipt=excelImport()
        val version=call("GET",base)["contentVersion"].asLong()
        val payload=mapOf("expectedContentVersion" to version,"questions" to listOf(question(bank.bank,"TRUE_FALSE")))
        val importKey=UUID.randomUUID()
        val receipt=call("POST","$base/imports",payload,key=importKey)
        val scope=mapOf("questionBankId" to bank.bank,"count" to 6,"order" to "SEQUENTIAL")
        fun practice()=call("POST","/practice/sessions",mapOf("scope" to scope,"expectedContentVersion" to receipt["contentVersion"].asLong(),"feedback" to "AFTER_FINISH","deviceId" to UUID.randomUUID()),user.token)
        val finished=practice()
        fun submit(value: com.fasterxml.jackson.databind.JsonNode, key: UUID, expectedVersion: Long=value["version"].asLong())=finish("/practice/sessions/${id(value)}/finish",mapOf(
            "expectedVersion" to expectedVersion,"durationSeconds" to 0,"writerToken" to value["writer"]["writerToken"].asText(),"items" to answers(value)),user.token,key=key)
        submit(finished,UUID.randomUUID())
        val resultPath="/practice/sessions/${id(finished)}/result"
        val result=call("GET",resultPath,token=user.token)
        call("PUT","/me/favorites/${bank.questions.first()}",token=user.token)
        val open=practice()
        val openPath="/practice/sessions/${id(open)}"
        val original=call("GET",openPath,token=user.token)["items"]
        val oldPort=port
        val env=mapOf("BACKEND_MODE" to "test","BACKEND_WECHAT_PROVIDER" to "local","BACKEND_COMMAND_DIGEST_KEYS" to "1:$key",
            "BACKEND_IDENTITY_MAC_KEYS" to "1:$key","BACKEND_IDENTITY_RATE_KEY" to key,"BACKEND_DB_USER" to postgres.username,"BACKEND_DB_PASSWORD" to postgres.password)
        fun migrate(expectSuccess: Boolean=true) {
            val cmd=ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-jar",jar.toString(),"schema-init")
            cmd.environment().putAll(env + ("BACKEND_DB_URL" to postgres.jdbcUrl.substringBefore('?')))
            val p=cmd.redirectErrorStream(true).redirectOutput(Path.of("target/schema-upgrade.log").toFile()).start()
            assertTrue(p.waitFor(90,TimeUnit.SECONDS)); assertEquals(expectSuccess,p.exitValue()==0,java.nio.file.Files.readString(Path.of("target/schema-upgrade.log")))
        }
        jdbc.execute("ALTER TABLE subject RENAME COLUMN name TO unexpected_name")
        try {
            migrate(expectSuccess=false)
            assertNull(jdbc.queryForObject("SELECT to_regclass('schema_migration')::text",String::class.java))
            assertTrue(java.nio.file.Files.readString(Path.of("target/schema-upgrade.log")).contains("subject.name"))
        } finally { jdbc.execute("ALTER TABLE subject RENAME COLUMN unexpected_name TO name") }
        // Simulate a committed first batch from a previous migration attempt.
        jdbc.execute("ALTER TABLE question ADD COLUMN portable_id uuid")
        val preserved=UUID.randomUUID()
        jdbc.update("UPDATE question SET portable_id=? WHERE id=?",preserved,group)
        jdbc.dataSource!!.connection.use { blocker ->
            blocker.autoCommit=false
            blocker.createStatement().use { it.execute("LOCK TABLE file_asset IN ACCESS SHARE MODE") }
            try {
                migrate(expectSuccess=false)
                assertTrue(java.nio.file.Files.readString(Path.of("target/schema-upgrade.log")).contains("lock timeout"))
                assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM question WHERE portable_id IS NULL",Int::class.java))
                assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM schema_migration",Int::class.java))
                assertEquals(result,call("GET",resultPath,token=user.token))
            } finally { blocker.rollback() }
        }
        migrate();migrate()
        assertEquals(preserved,jdbc.queryForObject("SELECT portable_id FROM question WHERE id=?",UUID::class.java,group))
        assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM schema_migration",Int::class.java))
        val envInContainer=env + mapOf("BACKEND_LOCAL_CONTAINER" to "true","BACKEND_MAIL_ENCRYPTION_KEYS" to "1:$key","BACKEND_TEST_ACCOUNT_ENCRYPTION_KEYS" to "1:$key","BACKEND_DB_URL" to "jdbc:postgresql://upgrade-db:5432/qanda_backend","BACKEND_BIND_ADDRESS" to "0.0.0.0",
            "BACKEND_REVISION" to "upgrade-candidate","BACKEND_RABBIT_HOST" to "rabbitmq","BACKEND_RABBIT_USER" to "qanda","BACKEND_RABBIT_PASSWORD" to "isolated-queue-password",
            "BACKEND_FILES_ENABLED" to "true","BACKEND_FILE_ROOT" to "/test-assets","BACKEND_PROMETHEUS_URL" to "http://upgrade-prom:9090")
        fun backend(role: String, applicationJar: Path=jar)=GenericContainer<Nothing>("eclipse-temurin:21-jre-jammy").apply {
            withNetwork(rabbit.network);withNetworkAliases(role);withEnv(envInContainer);withEnv("BACKEND_ROLE",role)
            if(role=="worker") withEnv("BACKEND_WORKER_ENABLED","true")
            if(role=="monitor") { withEnv("BACKEND_MONITORING_ENABLED","true");withEnv("BACKEND_DB_SESSION_INIT","SET ROLE qanda_monitor") }
            withCopyFileToContainer(MountableFile.forHostPath(applicationJar),"/candidate.jar")
            withCopyFileToContainer(MountableFile.forHostPath(assetRoot),"/test-assets")
            waitingFor(org.testcontainers.containers.wait.strategy.Wait.forHttp("/api/v1/health").forStatusCode(200))
            withExposedPorts(8083);withCommand("java","-Xmx192m","-jar","/candidate.jar")
        }
        consumers.stop()
        backend("worker").use { worker -> backend("api").use { api -> backend("monitor").use { monitor -> GenericContainer<Nothing>("nginx:1.28-alpine").use { gateway ->
            worker.start();api.start();monitor.start()
            gateway.withNetwork(rabbit.network);gateway.withExposedPorts(8083)
            gateway.withCopyFileToContainer(MountableFile.forHostPath(root.resolve("apps/api/monitoring/gateway.conf")),"/etc/nginx/conf.d/default.conf")
            gateway.start()
            try {
                port=gateway.getMappedPort(8083)
                assertEquals(original,call("GET",openPath,token=user.token)["items"])
                assertEquals(result,call("GET",resultPath,token=user.token))
                call("PUT","/admin/questions/$group",readingInput+mapOf("expectedVersion" to 1,"passage" to "新版材料","assetIds" to emptyList<UUID>()))
                assertEquals(snapshot(original),snapshot(call("GET",openPath,token=user.token)["items"]))
                assertEquals(snapshot(result),snapshot(call("GET",resultPath,token=user.token)))
                val questionCount=jdbc.queryForObject("SELECT count(*) FROM question",Int::class.java)
                assertEquals(excelReceipt,excelImport())
                assertEquals(receipt,call("POST","$base/imports",payload,key=importKey))
                assertEquals(questionCount,jdbc.queryForObject("SELECT count(*) FROM question",Int::class.java))
                val media=http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/v1/files/$file")).header("Authorization","Bearer ${user.token}").GET().build(),HttpResponse.BodyHandlers.ofByteArray())
                assertEquals(200,media.statusCode());assertArrayEquals(image.toByteArray(),media.body())
                for(kind in listOf("FAVORITE","WRONG")) assertTrue(call("POST","/practice/scope-preview",scope+("selectionKind" to kind),user.token)["availableCount"].asInt()>0)
                for(path in listOf("statistics/activity","statistics/online-users","statistics/rankings","monitoring/compatibility","monitoring/health"))
                    repeat(2) { call("GET","/admin/$path") }
                val stream=http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/v1/admin/monitoring/sync/stream")).header("Authorization","Bearer $adminToken").GET().build(),HttpResponse.BodyHandlers.ofInputStream())
                stream.body().bufferedReader().use { assertTrue(it.lineSequence().take(10).any { line -> line.contains("sync-health") }) }
                val saveKey=UUID.randomUUID()
                val saveBody=progressBody(open)
                val saved=progress("$openPath/sync-commands",saveBody,user.token,key=saveKey)
                assertEquals(saved,progress("$openPath/sync-commands",saveBody,user.token,key=saveKey))
                val resumed=call("GET",openPath,token=user.token)
                val command=UUID.randomUUID()
                val newResult=submit(open,command,resumed["version"].asLong())
                assertEquals(newResult,submit(open,command,resumed["version"].asLong()))
                assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM practice_result WHERE session_id=?",Int::class.java,id(open)))
                api.stop(); worker.stop(); monitor.stop()
                val releasedJar=Path.of("target/qanda-backend-1.0.0.jar").toAbsolutePath()
                backend("worker",releasedJar).use { oldWorker ->
                    backend("api",releasedJar).use { oldApi ->
                        backend("monitor",releasedJar).use { oldMonitor ->
                            oldWorker.start(); oldApi.start(); oldMonitor.start()
                            assertEquals(0,gateway.execInContainer("nginx","-s","reload").exitCode)
                            eventually { raw("GET","/health",token=null).statusCode()==200 }
                            assertEquals(newResult,call("GET","$openPath/result",token=user.token))
                            assertEquals(snapshot(result),snapshot(call("GET",resultPath,token=user.token)))
                            assertEquals(receipt,call("POST","$base/imports",payload,key=importKey))
                        }
                    }
                }
                val digest=java.security.MessageDigest.getInstance("SHA-256")
                val evidence=mapOf("verifiedAt" to java.time.Instant.now().toString(),
                    "releasedRevision" to System.getenv("QANDA_RELEASED_REVISION"),
                    "candidateJarSha256" to java.util.HexFormat.of().formatHex(digest.digest(java.nio.file.Files.readAllBytes(jar))),
                    "bankId" to bank.bank,"imageId" to file,
                    "imageSha256" to java.util.HexFormat.of().formatHex(digest.digest(image.toByteArray())),
                    "issuedItems" to original.map { item -> val q=item["question"]
                        mapOf("itemId" to item["itemId"],"questionId" to q["id"],"revisionId" to q["revisionId"],"materialRevisionId" to q.path("material").path("revisionId").asText(null)) },
                    "results" to listOf(result,newResult).map { r -> mapOf("sessionId" to r["sessionId"],"resultId" to r["id"],"objective" to r["objective"],"shortAnswer" to r["shortAnswer"]) })
                json.writerWithDefaultPrettyPrinter().writeValue(Path.of("target/release-upgrade.json").toFile(),evidence)
            } finally { port=oldPort }
        } } } }
    }
}
