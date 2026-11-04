package qanda.backend.catalog

import java.util.UUID
import qanda.backend.catalog.api.CatalogDirectory
import qanda.backend.platform.http.invalid

data class CategoryFilter(val collegeId: UUID?=null,val majorId: UUID?=null,val grade: Int?=null) {
    fun validate(directory: CatalogDirectory) {
        if(grade!=null && grade !in 1..5) invalid("/grade")
        collegeId?.let { if(directory.college(it)?.status!="ACTIVE") invalid("/collegeId","CATEGORY_UNAVAILABLE","分类已失效，请重新选择") }
        majorId?.let { id ->
            val major=directory.major(id)
            if(major?.status!="ACTIVE" || directory.college(major.collegeId)?.status!="ACTIVE") invalid("/majorId","CATEGORY_UNAVAILABLE","分类已失效，请重新选择")
            if(collegeId!=null && major.collegeId!=collegeId) invalid("/majorId")
        }
    }
}
