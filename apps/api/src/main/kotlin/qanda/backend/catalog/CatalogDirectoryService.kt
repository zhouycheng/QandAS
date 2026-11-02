package qanda.backend.catalog

import org.springframework.stereotype.Service
import qanda.backend.catalog.api.CatalogDirectory
import java.util.UUID

@Service
class CatalogDirectoryService(private val colleges: CollegeMapper,private val majors: MajorMapper,private val subjects: SubjectMapper): CatalogDirectory {
    override fun college(id: UUID?)=id?.let { colleges.selectById(it) }?.let { CollegeView(it.id!!,it.name,it.code,it.status,it.version) }
    override fun major(id: UUID?)=id?.let { majors.selectById(it) }?.let { MajorView(it.id!!,it.collegeId!!,it.name,it.code,it.status,it.version) }
    override fun subject(id: UUID?)=id?.let { subjects.selectById(it) }?.let { SubjectView(it.id!!,it.name,it.description,it.status,it.version) }
}
