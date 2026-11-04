package qanda.backend.content

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param
import org.springframework.web.bind.annotation.*
import qanda.backend.catalog.CategoryFilter
import qanda.backend.catalog.api.CatalogDirectory
import qanda.backend.identity.Sessions
import qanda.backend.platform.http.*
import java.util.UUID

data class SearchResult(val kind: String,val id: UUID,val subjectId: UUID,val questionBankId: UUID,val chapterId: UUID?,val questionId: UUID?,val title: String,val summary: String,val questionType: String?)
@Mapper interface SearchMapper {
    fun search(@Param("keyword") keyword: String,@Param("kind") kind: String?,@Param("questionType") questionType: String?,@Param("filter") filter: CategoryFilter,@Param("offset") offset: Int,@Param("limit") limit: Int): List<SearchResult>
    fun count(@Param("keyword") keyword: String,@Param("kind") kind: String?,@Param("questionType") questionType: String?,@Param("filter") filter: CategoryFilter): Long
}
@RestController
@RequestMapping("/api/v1",produces=["application/json"])
class SearchController(private val sql: SearchMapper,private val directory: CatalogDirectory,private val sessions: Sessions) {
    @GetMapping("/search")
    fun search(@RequestParam keyword: String,@RequestParam(required=false) kind: String?,@RequestParam(required=false) questionType: String?,@org.springdoc.core.annotations.ParameterObject @ModelAttribute filter: CategoryFilter,
        @RequestParam(defaultValue="1") page: Int,@RequestParam(defaultValue="20") pageSize: Int): Page<SearchResult> {
        sessions.studentOrGuest();filter.validate(directory)
        val term=keyword.trim();if(term.isEmpty() || term.length>100) invalid("/keyword")
        if(kind!=null && kind !in setOf("BANK","CHAPTER","QUESTION")) invalid("/kind")
        if(questionType!=null && questionType !in setOf("SINGLE_CHOICE","MULTIPLE_CHOICE","TRUE_FALSE","FILL_BLANK","SHORT_ANSWER","READING")) invalid("/questionType")
        val p=PageSpec(page,pageSize)
        return Page(sql.search(term,kind,questionType,filter,p.offset,p.pageSize),sql.count(term,kind,questionType,filter),p.page,p.pageSize)
    }
}
