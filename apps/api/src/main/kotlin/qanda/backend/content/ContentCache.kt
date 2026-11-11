package qanda.backend.content

import com.fasterxml.jackson.core.JsonProcessingException
import com.fasterxml.jackson.databind.ObjectMapper
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.core.env.Environment
import org.springframework.data.redis.core.RedisCallback
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

@Service
class ContentCache(private val redis: StringRedisTemplate,private val json: ObjectMapper,
                   environment: Environment,private val registry: MeterRegistry) {
    private val enabled=environment.getProperty("qanda.backend.content-cache.enabled",Boolean::class.java,false)
    private val namespace=environment.getProperty("qanda.backend.content-cache.namespace","qanda:content:v1")
    private val retryAt=AtomicLong()
    private val enabledMetric=AtomicInteger(if(enabled) 1 else 0)
    private val failures=registry.counter("qanda.content.cache.failures")

    init {
        require(namespace.matches(Regex("[A-Za-z0-9:_-]{1,100}")))
        registry.gauge("qanda.content.cache.enabled",enabledMetric)
    }

    private fun available()=enabled && System.nanoTime()>=retryAt.get()
    private fun key(region: String,id: String)="$namespace:$region:$id"
    private fun count(region: String,result: String,n: Int) {
        if(n>0) registry.counter("qanda.content.cache.requests","cache",region,"result",result).increment(n.toDouble())
    }
    private fun failed() { failures.increment();retryAt.set(System.nanoTime()+5_000_000_000L) }

    fun <T: Any> read(region: String,ids: List<String>,type: Class<T>): Map<String,T> {
        if(ids.isEmpty()) return emptyMap()
        if(!available()) { count(region,"bypass",ids.size);return emptyMap() }
        val found=mutableMapOf<String,T>()
        try {
            ids.chunked(128).forEach { batch ->
                val values=redis.opsForValue().multiGet(batch.map { key(region,it) }).orEmpty()
                batch.forEachIndexed { index,id ->
                    val value=values.getOrNull(index)
                    if(value!=null && value.length<=524288) {
                        try { found[id]=json.readValue(value,type) }
                        catch(_: JsonProcessingException) { failures.increment() }
                    }
                }
            }
            count(region,"hit",found.size);count(region,"miss",ids.size-found.size)
        } catch(_: Exception) { failed();count(region,"bypass",ids.size);return emptyMap() }
        return found
    }

    fun put(region: String,values: Map<String,Any>) {
        if(values.isEmpty() || !available()) return
        val write: () -> Unit={
            if(available()) {
                try {
                    values.entries.chunked(128).forEach { batch ->
                        redis.executePipelined(RedisCallback<Any?> { connection ->
                            batch.forEach { (id,value) ->
                                val bytes=json.writeValueAsBytes(value)
                                if(bytes.size<=524288) connection.stringCommands().setEx(key(region,id).toByteArray(),
                                    3600L+ThreadLocalRandom.current().nextLong(600),bytes)
                            }
                            null
                        })
                    }
                } catch(_: Exception) { failed() }
            }
        }
        // A rolled-back content version can be reused; publish only committed cache entries.
        if(TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(object: TransactionSynchronization {
                override fun afterCommit() { write() }
            })
        } else write()
    }
}

data class CachedBankCounts(val questionCount: Long,val activeQuestionCount: Long)
data class CachedRevision(val revision: QuestionRevision,val options: List<QuestionOption>,val attachments: List<java.util.UUID>)
