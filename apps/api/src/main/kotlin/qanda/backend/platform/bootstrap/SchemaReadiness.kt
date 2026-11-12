package qanda.backend.platform.bootstrap

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.beans.factory.InitializingBean
import org.springframework.context.annotation.DependsOn
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import qanda.backend.platform.persistence.SystemMapper

@Configuration
@ConditionalOnProperty(name=["qanda.backend.schema-command"],havingValue="false",matchIfMissing=true)
class SchemaReadiness {
    @Bean @DependsOn("backendSafety","validateProductionProviders")
    fun databaseReady(sql: SystemMapper,env: org.springframework.core.env.Environment,jdbc: org.springframework.jdbc.core.JdbcTemplate)=InitializingBean {
        val ready=if(env.getProperty("qanda.backend.role")=="monitor") jdbc.queryForObject("SELECT count(include_in_statistics) FROM monitoring_student WHERE false",Long::class.java)==0L else sql.ready() && jdbc.queryForObject("SELECT count(result_source) FROM practice_result WHERE false",Long::class.java)==0L && jdbc.queryForObject("SELECT count(payload_bytes) FROM sync_command WHERE false",Long::class.java)==0L
        val payloadReady=ready && (env.getProperty("qanda.backend.role") == "monitor" || jdbc.queryForObject("SELECT NOT attnotnull FROM pg_attribute WHERE attrelid='sync_command'::regclass AND attname='payload_json'",Boolean::class.java)==true)
        check(ready && payloadReady) { "数据库结构未就绪，请按README运行db-init初始化开发库" }
    }
}
data class HealthView(val status: String="UP",val version: String="1.0.0")
@RestController
class HealthController {
    @GetMapping("/api/v1/health",produces=["application/json"]) fun health()=HealthView()
}
