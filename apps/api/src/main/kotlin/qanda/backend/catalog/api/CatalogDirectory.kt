package qanda.backend.catalog.api

import qanda.backend.catalog.CollegeView
import qanda.backend.catalog.MajorView
import qanda.backend.catalog.SubjectView
import java.util.UUID

interface CatalogDirectory {
    fun college(id: UUID?): CollegeView?
    fun major(id: UUID?): MajorView?
    fun subject(id: UUID?): SubjectView?
}
