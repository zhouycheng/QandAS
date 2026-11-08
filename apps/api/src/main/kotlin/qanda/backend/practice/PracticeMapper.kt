package qanda.backend.practice

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import qanda.backend.content.api.QuestionReference
import java.util.UUID

class PracticeChoiceRow { var itemId: UUID?=null;var optionKey: String="" }
@Mapper interface PracticeQueries {
    fun batchChoices(@Param("ids") ids: List<UUID>): List<PracticeChoiceRow>
    fun eligible(@Param("userId") userId: UUID?,@Param("scope") scope: ScopeInput): List<QuestionReference>
    fun eligibleCount(@Param("userId") userId: UUID?,@Param("scope") scope: ScopeInput): Long
    fun insertItems(@Param("items") items: List<PracticeItem>)
    fun lockSession(@Param("id") id: UUID): PracticeSession?
    fun items(@Param("sessionId") sessionId: UUID): List<PracticeItem>
    fun clearChoices(@Param("itemId") itemId: UUID)
    fun addChoice(@Param("itemId") itemId: UUID,@Param("revisionId") revisionId: UUID,@Param("key") key: String)
    fun updateAnswer(@Param("item") item: PracticeItem)
    fun result(@Param("sessionId") sessionId: UUID): PracticeResult?
    fun history(@Param("userId") userId: UUID,@Param("deviceId") deviceId: UUID?,@Param("offset") offset: Int,@Param("limit") limit: Int): List<PracticeSession>
    fun historyCount(@Param("userId") userId: UUID,@Param("deviceId") deviceId: UUID?): Long
}
