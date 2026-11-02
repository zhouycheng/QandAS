package qanda.backend.monitoring

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.core.env.Environment
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Clock
import java.time.Duration
import java.time.Instant

data class SyncMetrics(val queued: Double?,val processing: Double?,val productionPerSecond: Double?,val consumptionPerSecond: Double?,
    val committedPerSecond: Double?,val retrying: Double?,val deadLetters: Double?,val consumers: Double?,val averageLatencyMs: Double?,val p95LatencyMs: Double?)
data class SyncHealthView(val sampledAt: Instant?,val checkedAt: Instant,val windowSeconds: Int,val status: String,val reason: String?,val metrics: SyncMetrics)
data class ComponentHealth(val name: String,val status: String)
data class EndpointHealth(val method: String,val path: String,val requestsPerSecond: Double?,val errorsPerSecond: Double?,val p95Seconds: Double?)
data class SystemHealthView(val sampledAt: Instant?,val components: List<ComponentHealth>,val endpoints: List<EndpointHealth>,val activityPending: Long?,val mailPending: Long?,val sync: SyncHealthView)

@Service
class SyncHealth(private val json: ObjectMapper,private val jdbc: JdbcTemplate,private val environment: Environment,private val clock: Clock) {
    private val http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build()
    @Volatile private var latest=SyncHealthView(null,clock.instant(),60,"UNAVAILABLE","等待指标采集",SyncMetrics(null,null,null,null,null,null,null,null,null,null))
    @Volatile private var components=listOf<ComponentHealth>()
    @Volatile private var endpoints=listOf<EndpointHealth>()
    @Volatile private var jobs: Pair<Long?,Long?> = null to null
    fun snapshot()=latest.let { if(Duration.between(it.checkedAt,clock.instant()).seconds>15) it.copy(status="STALE",reason="指标采集已中断") else it }
    fun health()=SystemHealthView(latest.sampledAt,components,endpoints,jobs.first,jobs.second,snapshot())
    @Scheduled(fixedDelay=5000)
    fun tick() { if(environment.getProperty("qanda.backend.monitoring-enabled",Boolean::class.java,false)) sample() }
    fun sample() {
        val now=clock.instant()
        try {
            val base=environment.getProperty("qanda.backend.prometheus-url","http://127.0.0.1:9090").trimEnd('/')
            val query=URLEncoder.encode("{__name__=~\"qanda_sync_.*|qanda_http_.*|up\"}",Charsets.UTF_8)
            val response=http.send(HttpRequest.newBuilder(URI("$base/api/v1/query?query=$query")).timeout(Duration.ofSeconds(3)).GET().build(),HttpResponse.BodyHandlers.ofString())
            check(response.statusCode()==200)
            val body=json.readTree(response.body());check(body["status"].asText()=="success")
            val values=body["data"]["result"].toList()
            fun value(name: String)=values.firstOrNull { it["metric"]["__name__"]?.asText()==name }?.get("value")?.get(1)?.asText()?.toDoubleOrNull()?.takeIf { it.isFinite() }
            components=values.filter { it["metric"]["__name__"]?.asText()=="up" }.map { ComponentHealth(it["metric"]["job"].asText(),if(it["value"][1].asDouble()==1.0) "UP" else "DOWN") }
            endpoints=values.filter { it["metric"]["__name__"]?.asText()?.startsWith("qanda_http_")==true }.groupBy { it["metric"]["method"].asText() to it["metric"]["uri"].asText() }.map { (route,metrics) ->
                fun number(name: String)=metrics.firstOrNull { it["metric"]["__name__"].asText()==name }?.get("value")?.get(1)?.asText()?.toDoubleOrNull()?.takeIf { it.isFinite() }
                EndpointHealth(route.first,route.second,number("qanda_http_requests"),number("qanda_http_errors"),number("qanda_http_p95"))
            }
            check(components.any { it.name=="rabbitmq" && it.status=="UP" } && value("qanda_sync_ready")!=null && (value("qanda_sync_scrape_age") ?: Double.POSITIVE_INFINITY)<=15)
            val database=jdbc.queryForMap("""SELECT count(*)/60.0 committed,
                avg(extract(epoch FROM completed_at-created_at)*1000) average,
                percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM completed_at-created_at)*1000) p95
                FROM monitoring_sync_completion WHERE completed_at>=now()-interval '60 seconds'""")
            val sampled=(value("qanda_sync_samples") ?: 0.0)>=12
            val reset=(value("qanda_sync_resets") ?: 0.0)>0
            latest=SyncHealthView(now,now,60,if(reset) "RESET" else if(sampled) "HEALTHY" else "SAMPLING",if(reset) "队列计数器已重置，正在重新采样" else if(!sampled) "正在积累 60 秒样本" else null,
                SyncMetrics(value("qanda_sync_ready"),value("qanda_sync_unacked"),value("qanda_sync_produced").takeIf { sampled && !reset },value("qanda_sync_consumed").takeIf { sampled && !reset },
                    (database["committed"] as? Number)?.toDouble(),value("qanda_sync_retry"),value("qanda_sync_dead"),value("qanda_sync_consumers"),
                    (database["average"] as? Number)?.toDouble(),(database["p95"] as? Number)?.toDouble()))
            jobs=jdbc.queryForObject("SELECT * FROM monitoring_jobs",{ r,_ -> r.getLong("activity") to r.getLong("mail") })!!
        } catch(_: Exception) {
            latest=latest.copy(checkedAt=now,status=if(latest.sampledAt==null) "UNAVAILABLE" else "STALE",reason="指标采集失败，显示最近成功数据")
        }
    }
}
