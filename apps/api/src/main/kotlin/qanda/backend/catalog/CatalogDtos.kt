package qanda.backend.catalog

import io.swagger.v3.oas.annotations.media.Schema
import java.util.UUID
import java.time.Instant

data class CollegeInput(val name: String,val code: String,@field:Schema(allowableValues=["ACTIVE","INACTIVE"]) val status: String="ACTIVE",val expectedVersion: Long?=null)
data class MajorInput(val collegeId: UUID,val name: String,val code: String,@field:Schema(allowableValues=["ACTIVE","INACTIVE"]) val status: String="ACTIVE",val expectedVersion: Long?=null)
data class SubjectInput(val name: String,val description: String="",@field:Schema(allowableValues=["ACTIVE","INACTIVE"]) val status: String="ACTIVE",val expectedVersion: Long?=null)
data class CollegeView(val id: UUID,val name: String,val code: String,val status: String,val version: Long,val studentCount: Long?=null)
data class MajorView(val id: UUID,val collegeId: UUID,val name: String,val code: String,val status: String,val version: Long,val studentCount: Long?=null)
data class SubjectView(val id: UUID,val name: String,val description: String,val status: String,val version: Long,
    val bankCount: Long?=null,val questionCount: Long?=null,val progress: qanda.backend.content.BankProgressView?=null)
data class SubjectAccessInput(val userId: UUID,val expectedVersion: Long)
data class SubjectAccessView(val userId: UUID,val nickname: String,val accountCode: String,val createdAt: Instant)
data class DirectorySummary(val collegeCount: Long,val majorCount: Long,val studentCount: Long,val grades: List<GradeCount>)
data class GradeCount(val grade: Int,val studentCount: Long)
data class MemberCount(val id: UUID,val studentCount: Long)
