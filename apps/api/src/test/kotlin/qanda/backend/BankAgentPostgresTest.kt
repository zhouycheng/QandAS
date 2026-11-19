package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.test.context.TestPropertySource
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

@TestPropertySource(properties=["QANDA_MCP_RESOURCE=https://bank.example.test/mcp","QANDA_MCP_CLIENTS={\"fixture\":[\"http://127.0.0.1:8888/callback\"]}"])
class BankAgentPostgresTest: PostgresFixture() {
    @Test fun `PKCE write grant edits drafts and rejects published writes replay and revoked requests`() {
        val verifier="v".repeat(64)
        val challenge=Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        val redirect="http://127.0.0.1:8888/callback"
        val resource="https://bank.example.test/mcp"
        val consent=mapOf("clientId" to "fixture","redirectUri" to redirect,"resource" to resource,"scope" to "banks:read banks:write","challenge" to challenge,"method" to "S256")
        call("POST","/admin/bank-agents/authorize",consent+mapOf("redirectUri" to "https://example.test"),status=422)
        val code=call("POST","/admin/bank-agents/authorize",consent)["code"].asText()
        fun exchange(key: String): HttpResponse<String> {
            val params=mapOf("grant_type" to "authorization_code","client_id" to "fixture","code" to code,"code_verifier" to key,"redirect_uri" to redirect,"resource" to resource)
            val form=params.entries.joinToString("&") { it.key+"="+URLEncoder.encode(it.value,Charsets.UTF_8) }
            return http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/bank-agent/token")).header("Content-Type","application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form)).build(),HttpResponse.BodyHandlers.ofString())
        }
        assertEquals(422,exchange("x".repeat(64)).statusCode())
        val exchanged=exchange(verifier)
        assertEquals(200,exchanged.statusCode(),exchanged.body())
        assertEquals(422,exchange(verifier).statusCode())
        val token=json.readTree(exchanged.body())["access_token"].asText()
        fun tool(name: String,body: Any): HttpResponse<String> = http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/bank-agent/tools/qanda_$name"))
            .header("Authorization","Bearer $token").header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(body))).build(),HttpResponse.BodyHandlers.ofString())
        val f=fixture()
        val bank=id(call("POST","/admin/question-banks",mapOf("subjectId" to f.subject,"name" to "Agent 草稿")))
        val input=mapOf("bankId" to bank,"idempotencyKey" to UUID.randomUUID(),"input" to question(bank,"TRUE_FALSE"))
        val created=tool("create_question",input)
        assertEquals(200,created.statusCode(),created.body())
        assertEquals(json.readTree(created.body()),json.readTree(tool("create_question",input).body()))
        assertEquals(403,tool("create_question",input+mapOf("bankId" to f.bank,"input" to question(f.bank,"TRUE_FALSE"))).statusCode())
        if(System.getenv("QANDA_MCP_ACCEPTANCE")=="1") {
            val client=ProcessBuilder("node","../mcp/acceptance/reading-bank.mjs")
            client.environment().putAll(mapOf("QANDA_TEST_TOKEN" to token,"QANDA_TEST_BANK" to bank.toString(),"QANDA_MCP_RESOURCE" to resource,"QANDA_API_UPSTREAM" to "http://127.0.0.1:$port"))
            val process=client.redirectErrorStream(true).start()
            try {
                assertTrue(process.waitFor(60,java.util.concurrent.TimeUnit.SECONDS))
                val output=process.inputStream.bufferedReader().readText()
                assertEquals(0,process.exitValue(),output)
                assertEquals("修订后的图形练习",call("GET","/admin/questions/"+UUID.fromString(output))["stem"].asText())
            } finally { process.destroyForcibly() }
        }
        val grant=call("GET","/admin/bank-agents")["agents"].first()["id"].asText()
        assertEquals(204,raw("DELETE","/admin/bank-agents/$grant").statusCode())
        assertEquals(401,tool("create_question",input).statusCode())
    }
}
