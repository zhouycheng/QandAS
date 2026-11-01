package qanda.backend

import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.Network
import org.testcontainers.containers.wait.strategy.Wait
import org.testcontainers.images.builder.Transferable
import org.testcontainers.utility.MountableFile
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

@Tag("postgres")
class GatewayProxyTest {
    @Test fun `gateway forwards authorization and first SSE event before upstream closes`() {
        Network.newNetwork().use { network ->
            GenericContainer<Nothing>("python:3.12-alpine").apply {
                withNetwork(network);withNetworkAliases("api","monitor")
                withCopyToContainer(Transferable.of("""
                    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
                    import time
                    class Handler(BaseHTTPRequestHandler):
                        def do_GET(self):
                            if self.path == '/api/v1/health':
                                self.send_response(200); self.end_headers(); self.wfile.write(b'UP'); return
                            if self.headers.get('Authorization') != 'Bearer isolated-monitor':
                                self.send_response(401); self.end_headers(); return
                            self.send_response(200)
                            self.send_header('Content-Type','text/event-stream')
                            self.end_headers()
                            self.wfile.write(b'event:sync-health\ndata:{"queued":12}\n\n'); self.wfile.flush()
                            time.sleep(30)
                    ThreadingHTTPServer(('0.0.0.0',8083),Handler).serve_forever()
                """.trimIndent()),"/server.py")
                withCommand("python","/server.py");withExposedPorts(8083)
                waitingFor(Wait.forHttp("/api/v1/health").forPort(8083))
            }.use { source ->
                source.start()
                GenericContainer<Nothing>("nginx:1.28-alpine").apply {
                    withNetwork(network);withExposedPorts(8083)
                    withCopyFileToContainer(MountableFile.forHostPath(Path.of("monitoring/gateway.conf")),"/etc/nginx/conf.d/default.conf")
                    waitingFor(Wait.forHttp("/api/v1/health").forPort(8083))
                }.use { gateway ->
                    gateway.start()
                    val uri=URI("http://${gateway.host}:${gateway.getMappedPort(8083)}/api/v1/admin/monitoring/sync/stream")
                    val client=HttpClient.newHttpClient()
                    assertEquals(401,client.send(HttpRequest.newBuilder(uri).GET().build(),HttpResponse.BodyHandlers.discarding()).statusCode())
                    val response=client.send(HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5)).header("Authorization","Bearer isolated-monitor").header("Accept","text/event-stream").GET().build(),HttpResponse.BodyHandlers.ofInputStream())
                    assertEquals(200,response.statusCode())
                    assertTrue(response.headers().firstValue("Content-Type").orElse("").startsWith("text/event-stream"))
                    response.body().bufferedReader().use { reader ->
                        assertEquals("event:sync-health",CompletableFuture.supplyAsync { reader.readLine() }.get(5,TimeUnit.SECONDS))
                        assertEquals("data:{\"queued\":12}",reader.readLine())
                    }
                }
            }
        }
    }
}
