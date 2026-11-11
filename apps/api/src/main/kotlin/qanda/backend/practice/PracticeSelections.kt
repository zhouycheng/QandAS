package qanda.backend.practice

import io.micrometer.core.instrument.MeterRegistry
import org.springframework.stereotype.Service
import qanda.backend.content.ContentCache
import qanda.backend.content.afterContentCommit
import qanda.backend.content.api.BankReference
import qanda.backend.content.api.QuestionReference
import java.util.LinkedHashMap
import java.util.UUID

data class CachedEligibilityGroup(val id: UUID,val size: Long)
data class CachedEligibilityPool(val groups: List<CachedEligibilityGroup>,val availableCount: Long,val overflow: Boolean=false)
data class EligibilityPreview(val availableCount: Long,val questions: List<QuestionReference>)

internal fun chooseGroupIds(groups: List<CachedEligibilityGroup>,count: Int,completeFirst: Boolean): List<UUID> {
    val selected=mutableListOf<UUID>();var remaining=count.toLong()
    for((position,group) in groups.withIndex()) {
        if(group.size>remaining) {
            if(position==0 && completeFirst && group.size<=1000) selected.add(group.id)
            break
        }
        selected.add(group.id);remaining-=group.size
    }
    return selected
}

@Service
class PracticeSelections(private val sql: PracticeQueries,private val cache: ContentCache,private val meters: MeterRegistry) {
    // shortcut: retain 32 versioned pools of at most 1,000 groups; larger scopes use bounded SQL selection.
    private val local=object: LinkedHashMap<String,CachedEligibilityPool>(32,0.75f,true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String,CachedEligibilityPool>?)=size>32
    }
    private fun remember(key: String,pool: CachedEligibilityPool) { synchronized(local) { local[key]=pool } }
    private fun valid(pool: CachedEligibilityPool)=if(pool.overflow) pool.groups.isEmpty() && pool.availableCount>1000 else
        pool.groups.size<=1000 && pool.groups.all { it.size>0 } && pool.groups.distinctBy { it.id }.size==pool.groups.size && pool.availableCount==pool.groups.sumOf { it.size }

    private fun pool(scope: ScopeInput,banks: List<BankReference>): CachedEligibilityPool? {
        if(!cache.isEnabled() || scope.selectionKind!="NORMAL" || scope.collectionChip!="all" || banks.size!=1 || scope.chapterIds.isNotEmpty() || scope.questionIds.isNotEmpty()) return null
        val bank=banks.single();val key="${bank.id}:${bank.contentVersion}"
        synchronized(local) { local[key] }?.let {
            meters.counter("qanda.content.cache.requests","cache","practice-groups-memory","result","hit").increment();return it
        }
        meters.counter("qanda.content.cache.requests","cache","practice-groups-memory","result","miss").increment()
        cache.read("practice-groups",listOf(key),CachedEligibilityPool::class.java)[key]?.let {
            if(valid(it)) { remember(key,it);return it }
            meters.counter("qanda.content.cache.failures").increment()
        }
        val rows=sql.candidateGroups(null,scope.copy(order="SEQUENTIAL"),1001)
        val pool=CachedEligibilityPool(if(rows.size>1000) emptyList() else rows.map { CachedEligibilityGroup(it.id!!,it.size) },rows.firstOrNull()?.availableCount ?: 0,rows.size>1000)
        cache.put("practice-groups",mapOf(key to pool));afterContentCommit { remember(key,pool) }
        return pool
    }

    private fun groups(userId: UUID?,scope: ScopeInput,banks: List<BankReference>): Pair<Long,List<CachedEligibilityGroup>> {
        pool(scope,banks)?.takeUnless { it.overflow }?.let {
            return it.availableCount to if(scope.order=="RANDOM") it.groups.shuffled() else it.groups
        }
        val rows=sql.candidateGroups(userId,scope,scope.count)
        return (rows.firstOrNull()?.availableCount ?: 0) to rows.map { CachedEligibilityGroup(it.id!!,it.size) }
    }
    private fun questions(userId: UUID?,scope: ScopeInput,groups: List<CachedEligibilityGroup>): List<QuestionReference> {
        val ids=chooseGroupIds(groups,scope.count,scope.completeFirstGroup && scope.selectionKind=="NORMAL")
        return if(ids.isEmpty()) emptyList() else sql.groupQuestions(userId,scope,ids)
    }
    fun preview(userId: UUID?,scope: ScopeInput,banks: List<BankReference>): EligibilityPreview {
        val (available,groups)=groups(userId,scope,banks)
        return EligibilityPreview(available,questions(userId,scope,groups))
    }
    fun choose(userId: UUID?,scope: ScopeInput,banks: List<BankReference>): List<QuestionReference> = questions(userId,scope,groups(userId,scope,banks).second)
}
