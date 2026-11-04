package qanda.backend.catalog

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import java.util.UUID

class SubjectListFacts { var subjectId: UUID?=null;var bankCount: Long=0;var questionCount: Long=0;var answeredCount: Long=0;var correctCount: Long=0;var wrongCount: Long=0;var wrongBookCount: Long=0 }
@Mapper interface CatalogQueries {
    fun subjectListFacts(@Param("ids") ids: List<UUID>,@Param("userId") userId: UUID?,@Param("filter") filter: CategoryFilter=CategoryFilter()): List<SubjectListFacts>

    fun lockCollege(@Param("id") id: UUID): College?
    fun lockMajor(@Param("id") id: UUID): Major?
    fun lockSubject(@Param("id") id: UUID): Subject?
    fun subjects(@Param("keyword") keyword: String?,@Param("publicOnly") publicOnly: Boolean,@Param("offset") offset: Int,@Param("limit") limit: Int,@Param("userId") userId: UUID?,@Param("filter") filter: CategoryFilter=CategoryFilter()): List<Subject>
    fun subjectCount(@Param("keyword") keyword: String?,@Param("publicOnly") publicOnly: Boolean,@Param("userId") userId: UUID?,@Param("filter") filter: CategoryFilter=CategoryFilter()): Long
    fun publishedSubject(@Param("id") id: UUID,@Param("userId") userId: UUID?,@Param("filter") filter: CategoryFilter=CategoryFilter()): Subject?
}
