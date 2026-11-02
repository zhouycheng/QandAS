package qanda.backend.discovery

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import java.time.Instant
import java.util.UUID

class RecommendedBankRow { var subjectId: UUID?=null;var bankId: UUID?=null }
@Mapper interface DiscoveryMapper {
    fun recommendationBanks(@Param("userId") userId: UUID,@Param("ids") ids: List<UUID>): List<RecommendedBankRow>
    fun favorite(@Param("userId") userId: UUID,@Param("questionId") questionId: UUID)
    fun unfavorite(@Param("userId") userId: UUID,@Param("questionId") questionId: UUID)
    fun recommendedSubjects(@Param("userId") userId: UUID,@Param("offset") offset: Int,@Param("limit") limit: Int): List<UUID>
    fun recommendedCount(@Param("userId") userId: UUID): Long
}
