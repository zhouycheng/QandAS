package qanda.backend.catalog

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.platform.http.*
import java.time.Instant
import java.util.UUID

@Service
@Transactional
class CatalogService(private val colleges: CollegeMapper,private val majors: MajorMapper,private val subjects: SubjectMapper,private val sql: CatalogQueries) {
    fun userAccess(id: UUID,p: PageSpec): Page<SubjectAccessView> {
        subjects.selectById(id) ?: missing()
        return Page(sql.userAccess(id,p.offset,p.pageSize),sql.userAccessCount(id),p.page,p.pageSize)
    }
    fun access(id: UUID,userId: UUID,expectedVersion: Long,adminId: UUID,enabled: Boolean): MutationResult {
        val row=sql.lockSubject(id) ?: missing();requireVersion(expectedVersion,row.version)
        if(!sql.userExists(userId)) invalid("/userId")
        val changed=if(enabled) sql.grant(id,userId,adminId) else sql.revoke(id,userId)
        if(changed>0) { row.version++;row.updatedAt=Instant.now();subjects.updateById(row) }
        return MutationResult(id,row.version)
    }
    fun collegeView(it: College)=CollegeView(it.id!!,it.name,it.code,it.status,it.version)
    fun college(id: UUID)=collegeView(colleges.selectById(id) ?: missing())
    fun major(id: UUID)=majorView(majors.selectById(id) ?: missing())
    fun majorView(it: Major)=MajorView(it.id!!,it.collegeId!!,it.name,it.code,it.status,it.version)
    fun subjectView(it: Subject)=SubjectView(it.id!!,it.name,it.description,it.status,it.version)
    fun directory(collegeId: UUID?,majorId: UUID?): DirectorySummary {
        val grades=sql.gradeCounts(collegeId,majorId).associateBy { it.grade }
        return DirectorySummary(colleges.selectCount(null),majors.selectCount(QueryWrapper<Major>().eq(collegeId!=null,"college_id",collegeId)),grades.values.sumOf { it.studentCount },(1..5).map { grades[it] ?: GradeCount(it,0) })
    }
    fun colleges(p: PageSpec,admin: Boolean,keyword: String?=null,status: String?=null): Page<CollegeView> {
        if(status!=null) activeStatus(status)
        val result=colleges.selectPage(com.baomidou.mybatisplus.extension.plugins.pagination.Page(p.page.toLong(),p.pageSize.toLong()),QueryWrapper<College>().eq(!admin,"status","ACTIVE").eq(admin && status!=null,"status",status).like(!keyword.isNullOrBlank(),"name",keyword).orderByAsc("name").orderByAsc("id"))
        val counts=if(admin && result.records.isNotEmpty()) sql.memberCounts("college",result.records.map { it.id!! }).associateBy { it.id } else emptyMap()
        return Page(result.records.map { collegeView(it).copy(studentCount=if(admin) counts[it.id]?.studentCount ?: 0 else null) },result.total,p.page,p.pageSize)
    }
    fun majors(collegeId: UUID?,p: PageSpec,admin: Boolean,keyword: String?=null,status: String?=null): Page<MajorView> {
        if(collegeId!=null) { val college=colleges.selectById(collegeId) ?: missing();if(!admin && college.status!="ACTIVE") missing() }
        if(status!=null) activeStatus(status)
        val result=majors.selectPage(com.baomidou.mybatisplus.extension.plugins.pagination.Page(p.page.toLong(),p.pageSize.toLong()),QueryWrapper<Major>().eq(collegeId!=null,"college_id",collegeId).eq(!admin,"status","ACTIVE").eq(admin && status!=null,"status",status).like(!keyword.isNullOrBlank(),"name",keyword).orderByAsc("name").orderByAsc("id"))
        val counts=if(admin && result.records.isNotEmpty()) sql.memberCounts("major",result.records.map { it.id!! }).associateBy { it.id } else emptyMap()
        return Page(result.records.map { majorView(it).copy(studentCount=if(admin) counts[it.id]?.studentCount ?: 0 else null) },result.total,p.page,p.pageSize)
    }
    fun subjects(p: PageSpec,keyword: String?,publicOnly: Boolean,userId: UUID?=null,includeProgress: Boolean=false): Page<SubjectView> {
        val rows=sql.subjects(keyword,publicOnly,p.offset,p.pageSize,userId).map(::subjectView)
        val facts=if(userId!=null && includeProgress && rows.isNotEmpty()) sql.subjectListFacts(rows.map { it.id },userId).associateBy { it.subjectId } else emptyMap()
        return Page(rows.map { row -> facts[row.id]?.let { row.copy(bankCount=it.bankCount,questionCount=it.questionCount,progress=qanda.backend.platform.queries.BankProgressView(it.answeredCount,it.correctCount,it.wrongCount)) } ?: row },sql.subjectCount(keyword,publicOnly,userId),p.page,p.pageSize)
    }
    fun subject(id: UUID,publicOnly: Boolean,userId: UUID?=null,includeProgress: Boolean=false): SubjectView {
        val row=subjectView((if(publicOnly) sql.publishedSubject(id,userId) else subjects.selectById(id)) ?: missing())
        val facts=if(userId!=null && includeProgress) sql.subjectListFacts(listOf(id),userId).firstOrNull() else null
        return facts?.let { row.copy(bankCount=it.bankCount,questionCount=it.questionCount,progress=qanda.backend.platform.queries.BankProgressView(it.answeredCount,it.correctCount,it.wrongCount)) } ?: row
    }
    fun college(id: UUID?,input: CollegeInput): MutationResult {
        val row=id?.let { sql.lockCollege(it) ?: missing() } ?: College().apply { this.id=UUID.randomUUID() }
        if(id!=null) requireVersion(input.expectedVersion ?: invalid("/expectedVersion"),row.version)
        row.name=name(input.name,80);row.code=name(input.code,40);row.status=activeStatus(input.status);row.updatedAt=Instant.now()
        if(id==null) colleges.insert(row) else { row.version++;colleges.updateById(row) }
        return MutationResult(row.id!!,row.version)
    }
    fun major(id: UUID?,input: MajorInput): MutationResult {
        if(colleges.selectById(input.collegeId)?.status!="ACTIVE") invalid("/collegeId")
        val row=id?.let { sql.lockMajor(it) ?: missing() } ?: Major().apply { this.id=UUID.randomUUID();collegeId=input.collegeId }
        if(id!=null) { requireVersion(input.expectedVersion ?: invalid("/expectedVersion"),row.version);if(row.collegeId!=input.collegeId) invalid("/collegeId","IMMUTABLE_PARENT","专业所属学院不可变更") }
        row.name=name(input.name,80);row.code=name(input.code,40);row.status=activeStatus(input.status);row.updatedAt=Instant.now()
        if(id==null) majors.insert(row) else { row.version++;majors.updateById(row) }
        return MutationResult(row.id!!,row.version)
    }
    fun subject(id: UUID?,input: SubjectInput): MutationResult {
        val row=id?.let { sql.lockSubject(it) ?: missing() } ?: Subject().apply { this.id=UUID.randomUUID() }
        if(id!=null) requireVersion(input.expectedVersion ?: invalid("/expectedVersion"),row.version)
        row.name=name(input.name);row.description=text(input.description,2000);row.status=activeStatus(input.status);row.updatedAt=Instant.now()
        if(id==null) subjects.insert(row) else { row.version++;subjects.updateById(row) }
        return MutationResult(row.id!!,row.version)
    }
}
