package qanda.backend

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.data.redis.RedisConnectionFailureException
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.data.redis.core.ValueOperations
import org.springframework.mock.env.MockEnvironment
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import qanda.backend.content.CachedBankCounts
import qanda.backend.content.ContentCache

class ContentCacheTest {
    private class Fixture(enabled: Boolean=true) {
        val redis=mock(StringRedisTemplate::class.java)
        @Suppress("UNCHECKED_CAST") val values=mock(ValueOperations::class.java) as ValueOperations<String,String>
        val registry=SimpleMeterRegistry()
        val cache=ContentCache(redis,jacksonObjectMapper(),MockEnvironment().withProperty("qanda.backend.content-cache.enabled",enabled.toString())
            .withProperty("qanda.backend.content-cache.namespace","isolated-test"),registry)
        init { `when`(redis.opsForValue()).thenReturn(values);clearInvocations(redis) }
        fun writes()=mockingDetails(redis).invocations.count { it.method.name=="executePipelined" }
    }

    @Test fun `versioned keys use one multi get and corrupted entries become misses`() {
        val f=Fixture()
        `when`(f.values.multiGet(listOf("isolated-test:bank-counts:first:1","isolated-test:bank-counts:second:2")))
            .thenReturn(listOf("{broken","{\"questionCount\":4,\"activeQuestionCount\":3}"))
        val result=f.cache.read("bank-counts",listOf("first:1","second:2"),CachedBankCounts::class.java)
        assertEquals(mapOf("second:2" to CachedBankCounts(4,3)),result)
        assertEquals(1.0,f.registry.get("qanda.content.cache.requests").tags("cache","bank-counts","result","hit").counter().count())
        assertEquals(1.0,f.registry.get("qanda.content.cache.requests").tags("cache","bank-counts","result","miss").counter().count())
    }

    @Test fun `cache failures bypass repeated connection attempts during recovery`() {
        val f=Fixture()
        `when`(f.values.multiGet(listOf("isolated-test:bank-counts:first:1"))).thenThrow(RedisConnectionFailureException("offline"))
        repeat(2) { assertTrue(f.cache.read("bank-counts",listOf("first:1"),CachedBankCounts::class.java).isEmpty()) }
        verify(f.values,times(1)).multiGet(listOf("isolated-test:bank-counts:first:1"))
        assertEquals(1.0,f.registry.get("qanda.content.cache.failures").counter().count())
    }

    @Test fun `rollback never publishes a reusable content version`() {
        val f=Fixture();TransactionSynchronizationManager.initSynchronization()
        try {
            f.cache.put("bank-counts",mapOf("bank:2" to CachedBankCounts(4,3)))
            assertEquals(0,f.writes())
            TransactionSynchronizationManager.getSynchronizations().forEach { it.afterCompletion(TransactionSynchronization.STATUS_ROLLED_BACK) }
            assertEquals(0,f.writes())
        } finally { TransactionSynchronizationManager.clearSynchronization() }
    }

    @Test fun `committed content is published after the transaction completes`() {
        val f=Fixture();TransactionSynchronizationManager.initSynchronization()
        try {
            f.cache.put("bank-counts",mapOf("bank:2" to CachedBankCounts(4,3)))
            assertEquals(0,f.writes())
            TransactionSynchronizationManager.getSynchronizations().forEach { it.afterCommit() }
            assertEquals(1,f.writes())
        } finally { TransactionSynchronizationManager.clearSynchronization() }
    }

    @Test fun `disabled cache never contacts Redis`() {
        val f=Fixture(false)
        assertTrue(f.cache.read("bank-counts",listOf("bank:1"),CachedBankCounts::class.java).isEmpty())
        f.cache.put("bank-counts",mapOf("bank:1" to CachedBankCounts(4,3)))
        verifyNoInteractions(f.redis)
    }
}
