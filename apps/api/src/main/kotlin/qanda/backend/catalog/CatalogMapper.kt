package qanda.backend.catalog

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import java.util.UUID

class SubjectListFacts { var subjectId: UUID?=null;var bankCount: Long=0;var questionCount: Long=0;var answeredCount: Long=0;var correctCount: Long=0;var wrongCount: Long=0 }
@Mapper interface CatalogQueries {
    fun subjectListFacts(@Param("ids") ids: List<UUID>,@Param("userId") userId: UUID): List<SubjectListFacts>

    fun gradeCounts(@Param("collegeId") collegeId: UUID?,@Param("majorId") majorId: UUID?): List<GradeCount>
    fun memberCounts(@Param("kind") kind: String,@Param("ids") ids: List<UUID>): List<MemberCount>
    fun lockCollege(@Param("id") id: UUID): College?
    fun lockMajor(@Param("id") id: UUID): Major?
    fun lockSubject(@Param("id") id: UUID): Subject?
    fun subjects(@Param("keyword") keyword: String?,@Param("publicOnly") publicOnly: Boolean,@Param("offset") offset: Int,@Param("limit") limit: Int,@Param("userId") userId: UUID?): List<Subject>
    fun subjectCount(@Param("keyword") keyword: String?,@Param("publicOnly") publicOnly: Boolean,@Param("userId") userId: UUID?): Long
    fun publishedSubject(@Param("id") id: UUID,@Param("userId") userId: UUID?): Subject?
    fun userAccess(@Param("id") id: UUID,@Param("offset") offset: Int,@Param("limit") limit: Int): List<SubjectAccessView>
    fun userAccessCount(@Param("id") id: UUID): Long
    fun grant(@Param("id") id: UUID,@Param("userId") userId: UUID,@Param("adminId") adminId: UUID): Int
    fun revoke(@Param("id") id: UUID,@Param("userId") userId: UUID): Int
    fun userExists(@Param("id") id: UUID): Boolean
}
