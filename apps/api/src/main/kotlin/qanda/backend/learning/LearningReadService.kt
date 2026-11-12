package qanda.backend.learning

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.discovery.FavoriteView
import qanda.backend.platform.http.*
import qanda.backend.practice.PracticeSummary
import java.time.Clock
import java.time.Instant
import java.util.UUID

class OverviewRow {
    var answerAttemptCount: Long=0;var objectiveAnsweredCount: Long=0;var objectiveCorrectCount: Long=0
    var selfRatedCount: Long=0;var selfRatedCorrectCount: Long=0;var selfRatedWrongCount: Long=0
    var answeredCount: Long=0;var correctCount: Long=0;var wrongCount: Long=0;var masteredCount: Long=0
    var favoriteCount: Long=0;var totalCount: Long=0;var subjectCount: Long=0;var bankCount: Long=0
    var durationSeconds: Long=0;var practiceCount: Long=0;var wrongBookCount: Long=0
}
data class LearningOverviewView(val answeredCount: Long,val correctCount: Long,val wrongCount: Long,val masteredCount: Long,
    val favoriteCount: Long,val totalCount: Long,val subjectCount: Long,val bankCount: Long,val durationSeconds: Long,
    val practiceCount: Long,val recentSession: PracticeSummary?,val wrongBookCount: Long,
    val answerAttemptCount: Long,val distinctQuestionCount: Long,val objectiveAnsweredCount: Long,val objectiveCorrectCount: Long,
    val objectiveAccuracy: Double?,val selfRatedCount: Long,val selfRatedCorrectCount: Long,val selfRatedWrongCount: Long,val includedSessionIds: List<UUID> = emptyList(),val questionFacts: List<PendingQuestionFact> = emptyList(),val assessmentFacts: List<PendingAssessmentFact> = emptyList())
data class PendingLearningInput(val pendingSessionIds: List<UUID> = emptyList(),val pendingQuestionIds: List<UUID> = emptyList(),val deviceId: UUID?=null,val pendingAssessmentItemIds: List<UUID> = emptyList())
data class PendingAssessmentFact(var itemId: UUID?=null,var selfAssessment: String?=null)
data class PendingQuestionFact(var questionId: UUID?=null,var judgment: String="",var selfAssessment: String?=null,var lastPracticedAt: Instant?=null,var wrongCount: Long=0,var rightCount: Long=0)
class CollectionRow {
    var questionId: UUID?=null;var questionBankId: UUID?=null;var subjectId: UUID?=null
    var questionBankName: String="";var subjectName: String="";var stem: String="";var type: String="";var contentFormat: String="PLAIN_TEXT";var presentation: String="STANDARD"
    var available: Boolean=false;var practiced: Boolean=false;var createdAt: Instant=Instant.EPOCH
    var lastPracticedAt: Instant?=null;var lastOutcome: String="";var rightCount: Long=0;var wrongCount: Long=0
}
class CollectionSummaryRow {
    var subjective: Boolean=false;var aggregate: Boolean=false
    var subjectId: UUID?=null;var subjectName: String="";var questionBankId: UUID?=null;var questionBankName: String=""
    var total: Long=0;var repeatCount: Long=0;var recentCount: Long=0;var practicedCount: Long=0
    var rightCount: Long=0;var wrongCount: Long=0
}
class CollectionFacet {
    var subjectId: UUID?=null;var subjectName: String="";var questionBankId: UUID?=null;var questionBankName: String="";var count: Long=0
}
data class CollectionSummaryView(val total: Long,val repeatCount: Long,val recentCount: Long,val practicedCount: Long,
    val pendingCount: Long,val rightCount: Long,val wrongCount: Long,val facets: List<CollectionFacet>,val subjectiveCount: Long=0,val subjectiveFacets: List<CollectionFacet> = emptyList())
data class CollectionFilter(val kind: String,val status: String="UNMASTERED",val subjectId: UUID?=null,val bankId: UUID?=null,
    val chip: String="all",val sort: String="recent",val since: Instant)
@Mapper interface LearningReadMapper {
    fun overview(@Param("userId") userId: UUID): OverviewRow
    fun pendingFacts(@Param("userId") userId: UUID,@Param("pendingFactIds") ids: List<UUID>): List<PendingQuestionFact>
    fun assessmentFacts(@Param("userId") userId: UUID,@Param("ids") ids: List<UUID>): List<PendingAssessmentFact>
    fun includedSessions(@Param("userId") userId: UUID,@Param("ids") ids: List<UUID>): List<UUID>
    fun latestSession(@Param("userId") userId: UUID,@Param("deviceId") deviceId: UUID?): PracticeSummary?
    fun collection(@Param("userId") userId: UUID,@Param("f") f: CollectionFilter,@Param("offset") offset: Int,@Param("limit") limit: Int): List<CollectionRow>
    fun collectionCount(@Param("userId") userId: UUID,@Param("f") f: CollectionFilter): Long
    fun collectionSummary(@Param("userId") userId: UUID,@Param("f") f: CollectionFilter): List<CollectionSummaryRow>
}
@Service
@Transactional(readOnly=true)
class LearningReadService(private val sql: LearningReadMapper,private val clock: Clock) {
    @Transactional(readOnly=true,isolation=org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    fun overview(userId: UUID,deviceId: UUID?=null,pendingSessionIds: List<UUID> = emptyList(),pendingQuestionIds: List<UUID> = emptyList(),pendingAssessmentItemIds: List<UUID> = emptyList()): LearningOverviewView {
        if(pendingSessionIds.size>1000 || pendingQuestionIds.size>10000 || pendingAssessmentItemIds.size>1000 || pendingSessionIds.distinct().size!=pendingSessionIds.size) invalid("/pendingSessionIds")
        val r=sql.overview(userId);val s=sql.latestSession(userId,deviceId)
        return LearningOverviewView(r.answeredCount,r.correctCount,r.wrongCount,r.masteredCount,r.favoriteCount,r.totalCount,
            r.subjectCount,r.bankCount,r.durationSeconds,r.practiceCount,s,r.wrongBookCount,r.answerAttemptCount,r.answeredCount,
            r.objectiveAnsweredCount,r.objectiveCorrectCount,if(r.objectiveAnsweredCount==0L) null else r.objectiveCorrectCount.toDouble()/r.objectiveAnsweredCount,
            r.selfRatedCount,r.selfRatedCorrectCount,r.selfRatedWrongCount,if(pendingSessionIds.isEmpty()) emptyList() else sql.includedSessions(userId,pendingSessionIds),if(pendingQuestionIds.isEmpty()) emptyList() else sql.pendingFacts(userId,pendingQuestionIds.distinct()),if(pendingAssessmentItemIds.isEmpty()) emptyList() else sql.assessmentFacts(userId,pendingAssessmentItemIds.distinct()))
    }
    private fun filter(kind: String,status: String="UNMASTERED",subjectId: UUID?=null,bankId: UUID?=null,chip: String="all",sort: String="recent"): CollectionFilter {
        if(kind !in setOf("WRONG","FAVORITE")) invalid("/kind")
        if(status !in setOf("ALL","UNMASTERED","MASTERED")) invalid("/status")
        if(chip !in if(kind=="WRONG") setOf("all","repeat","recent","subjective") else setOf("all","pending","practiced")) invalid("/chip")
        if(chip=="subjective" && status!="UNMASTERED") invalid("/status")
        if(sort !in if(kind=="WRONG") setOf("urgent","recent") else setOf("recent","old")) invalid("/sort")
        return CollectionFilter(kind,status,subjectId,bankId,chip,sort,clock.instant().minusSeconds(7*86400))
    }
    fun summary(userId: UUID,kind: String): CollectionSummaryView {
        val rows=sql.collectionSummary(userId,filter(kind))
        val r=rows.firstOrNull { it.aggregate && !it.subjective } ?: CollectionSummaryRow()
        fun facets(subjective: Boolean)=rows.filter { !it.aggregate && it.subjective==subjective }.map { row ->
            CollectionFacet().apply { subjectId=row.subjectId;subjectName=row.subjectName;questionBankId=row.questionBankId;questionBankName=row.questionBankName;count=row.total }
        }
        return CollectionSummaryView(r.total,r.repeatCount,r.recentCount,r.practicedCount,r.total-r.practicedCount,r.rightCount,r.wrongCount,facets(false),
            rows.firstOrNull { it.aggregate && it.subjective }?.total ?: 0,facets(true))
    }
    fun wrong(userId: UUID,status: String,bankId: UUID?,p: PageSpec,subjectId: UUID?=null,chip: String="all",sort: String="recent"): Page<WrongView> {
        val f=filter("WRONG",status,subjectId,bankId,chip,sort)
        return Page(sql.collection(userId,f,p.offset,p.pageSize).map { WrongView(it.questionId!!,it.questionBankId!!,it.stem,it.type,it.lastOutcome,it.lastPracticedAt!!,it.rightCount,it.wrongCount,it.available,it.subjectId,it.subjectName,it.questionBankName,it.contentFormat,it.presentation) },sql.collectionCount(userId,f),p.page,p.pageSize)
    }
    fun favorites(userId: UUID,p: PageSpec,subjectId: UUID?=null,bankId: UUID?=null,chip: String="all",sort: String="recent"): Page<FavoriteView> {
        val f=filter("FAVORITE",subjectId=subjectId,bankId=bankId,chip=chip,sort=sort)
        return Page(sql.collection(userId,f,p.offset,p.pageSize).map { FavoriteView(it.questionId!!,it.questionBankId!!,it.stem,it.type,it.available,it.createdAt,it.subjectId,it.subjectName,it.questionBankName,it.practiced,it.contentFormat,it.presentation) },sql.collectionCount(userId,f),p.page,p.pageSize)
    }
}
