package qanda.backend.content

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.identity.api.AccountDirectory
import qanda.backend.catalog.api.CatalogDirectory
import qanda.backend.platform.files.FileAssetMapper
import qanda.backend.platform.http.*
import qanda.backend.platform.security.Actor
import java.time.Instant
import java.util.UUID
import qanda.backend.platform.queries.BankProgressView
import com.fasterxml.jackson.databind.ObjectMapper

@Service
@Transactional
class ContentService(private val banks: QuestionBankMapper,private val chapters: ChapterMapper,private val questions: QuestionMapper,
                     private val revisions: QuestionRevisionMapper,private val categories: BankCategoryMapper,private val files: FileAssetMapper,
                     private val accounts: AccountDirectory,private val directory: CatalogDirectory,
                     private val sql: ContentQueries,private val access: ContentAccess,private val json: ObjectMapper,private val reader: QuestionReader,private val cache: ContentCache) {
    fun bankViewsByIds(ids: List<UUID>): List<BankView> = if(ids.isEmpty()) emptyList() else bankViews(banks.selectByIds(ids),false)
    fun bankView(row: QuestionBank,admin: Boolean): BankView = bankViews(listOf(row),admin).first()
    private fun bankViews(rows: List<QuestionBank>,admin: Boolean,userId: UUID?=null): List<BankView> {
        if(rows.isEmpty()) return emptyList()
        val ids=rows.map { it.id!! };val versions=rows.associate { it.id!! to "${it.id}:${it.contentVersion}" }
        val cached=cache.read("bank-counts",versions.values.toList(),CachedBankCounts::class.java)
            .filterValues { it.questionCount>=0 && it.activeQuestionCount in 0..it.questionCount }
        val missing=ids.filter { versions.getValue(it) !in cached }
        val facts=sql.bankListFacts(ids,userId,missing).associateBy { it.bankId }
        cache.put("bank-counts",missing.associate { id -> val fact=facts.getValue(id);versions.getValue(id) to CachedBankCounts(fact.questionCount,fact.activeQuestionCount) })
        val audienceRows=sql.bankCategories(ids).groupBy { it.bankId }
        val maintainers=if(admin) sql.bankMaintainers(ids).groupBy { it.bankId } else emptyMap()
        return rows.map { row -> val f=facts.getValue(row.id);val counts=cached[versions.getValue(row.id!!)] ?: CachedBankCounts(f.questionCount,f.activeQuestionCount)
            BankView(row.id!!,row.subjectId!!,row.name,row.description,row.textbook,row.status,row.publicationStatus,
                audienceRows[row.id].orEmpty().map { CategoryInput(it.collegeId,it.majorId,it.grade) },
                maintainers[row.id].orEmpty().map { it.adminId!! },row.version,row.contentVersion,if(admin) counts.questionCount else counts.activeQuestionCount,counts.activeQuestionCount,row.updatedAt,f.subjectName,
                userId?.let { BankProgressView(f.answeredCount,f.correctCount,f.wrongCount,f.wrongBookCount) })
        }
    }
    fun banks(actor: Actor?,subjectId: UUID?,keyword: String?,p: PageSpec,includeProgress: Boolean=false,publicationStatus: String?=null,filter: qanda.backend.catalog.CategoryFilter=qanda.backend.catalog.CategoryFilter()): Page<BankView> {
        filter.validate(directory)
        if(publicationStatus!=null && publicationStatus !in listOf("DRAFT","PUBLISHED","UNPUBLISHED","ARCHIVED")) invalid("/publicationStatus")
        val publicOnly=actor?.kind!="ADMIN"
        val userId=actor?.takeIf { it.kind=="USER" }?.id
        return Page(bankViews(sql.banks(subjectId,keyword,publicOnly,p.offset,p.pageSize,userId,publicationStatus,filter),!publicOnly,userId?.takeIf { includeProgress }),sql.bankCount(subjectId,keyword,publicOnly,userId,publicationStatus,filter),p.page,p.pageSize)
    }
    fun bank(actor: Actor?,id: UUID)=bankView(access.bank(actor,id),actor?.kind=="ADMIN")
    fun saveBank(actor: Actor,id: UUID?,input: BankInput): MutationResult {
        val row=id?.let { access.bank(actor,it,true) } ?: QuestionBank().apply { this.id=UUID.randomUUID();createdBy=actor.id;subjectId=input.subjectId }
        if(id!=null) { requireVersion(input.expectedVersion ?: invalid("/expectedVersion"),row.version);if(row.subjectId!=input.subjectId) invalid("/subjectId","IMMUTABLE_PARENT","题库所属课程不可变更") }
        if(directory.subject(input.subjectId)==null) invalid("/subjectId")
        if(input.categories.size>100) invalid("/categories")
        val normalized=input.categories.map { normalizeCategory(it) }
        if(normalized.distinct().size!=normalized.size) invalid("/categories")
        input.maintainerIds?.let { ids ->
            if(ids.size>100 || ids.distinct().size!=ids.size) invalid("/maintainerIds")
            ids.forEach { if(!accounts.activeAdmin(it)) invalid("/maintainerIds") }
        }
        row.name=name(input.name);row.description=text(input.description,2000);row.textbook=text(input.textbook,500);row.status=activeStatus(input.status);row.updatedAt=Instant.now()
        if(id==null) banks.insert(row) else { row.version++;banks.updateById(row) }
        sql.clearCategories(row.id!!);normalized.forEach { categories.insert(BankCategory().apply { this.id=UUID.randomUUID();bankId=row.id;collegeId=it.collegeId;majorId=it.majorId;grade=it.grade }) }
        if(input.maintainerIds!=null) { sql.clearMaintainers(row.id!!);input.maintainerIds.forEach { sql.addMaintainer(row.id!!,it) } }
        if(row.publicationStatus=="PUBLISHED" && row.status=="ACTIVE") validatePublication(row)
        return MutationResult(row.id!!,row.version)
    }
    private fun normalizeCategory(input: CategoryInput): CategoryInput {
        val major=input.majorId?.let { directory.major(it) ?: invalid("/categories/majorId") }
        if(major!=null && input.collegeId!=null && major.collegeId!=input.collegeId) invalid("/categories/collegeId")
        if(input.collegeId!=null && directory.college(input.collegeId)==null || major==null && input.collegeId==null && input.grade==null) invalid("/categories")
        if(input.grade!=null && input.grade !in 1..5) invalid("/categories/grade")
        return input.copy(collegeId=if(major==null) input.collegeId else null)
    }
    fun chapters(actor: Actor?,bankId: UUID): List<ChapterView> {
        access.bank(actor,bankId)
        val userId=actor?.takeIf { it.kind=="USER" }?.id
        val counts=sql.chapterCounts(bankId,actor?.kind!="ADMIN",userId).associateBy { it.id }
        return chapters.selectList(QueryWrapper<Chapter>().eq("bank_id",bankId).orderByAsc("sort_order").orderByAsc("id")).map {
            val facts=counts[it.id]
            ChapterView(it.id!!,bankId,it.name,it.sortOrder,it.version,facts?.count ?: 0,
                userId?.let { BankProgressView(facts?.answeredCount ?: 0,facts?.correctCount ?: 0,facts?.wrongCount ?: 0,facts?.wrongBookCount ?: 0) })
        }
    }
    fun saveChapter(actor: Actor,bankId: UUID,id: UUID?,input: ChapterInput): MutationResult {
        access.bank(actor,bankId,true)
        if(input.sortOrder !in 0..10000) invalid("/sortOrder")
        val row=id?.let { chapters.selectById(it) ?: missing() } ?: Chapter().apply { this.id=UUID.randomUUID();this.bankId=bankId }
        if(row.bankId!=bankId) missing()
        if(id!=null) requireVersion(input.expectedVersion ?: invalid("/expectedVersion"),row.version)
        row.name=name(input.name);row.sortOrder=input.sortOrder
        if(id==null) chapters.insert(row) else { row.version++;chapters.updateById(row) };sql.bumpBank(bankId)
        return MutationResult(row.id!!,row.version)
    }
    fun deleteChapter(actor: Actor,bankId: UUID,id: UUID,expectedVersion: Long): MutationResult {
        access.bank(actor,bankId,true);val row=chapters.selectById(id) ?: missing();if(row.bankId!=bankId) missing();requireVersion(expectedVersion,row.version)
        if(sql.chapterQuestions(id)>0) conflict("CHAPTER_NOT_EMPTY","请先将题目移出章节")
        chapters.deleteById(id);sql.bumpBank(bankId);return MutationResult(id,row.version)
    }
    fun reorder(actor: Actor,bankId: UUID,input: ReorderInput): MutationResult {
        val bank=access.bank(actor,bankId,true);requireVersion(input.expectedContentVersion,bank.contentVersion)
        val rows=chapters.selectList(QueryWrapper<Chapter>().eq("bank_id",bankId))
        if(input.ids.size!=rows.size || input.ids.toSet()!=rows.map { it.id }.toSet()) invalid("/ids")
        input.ids.forEachIndexed { i,id -> val row=rows.first { it.id==id };row.sortOrder=i;row.version++;chapters.updateById(row) }
        sql.bumpBank(bankId);return MutationResult(bankId,bank.version+1)
    }
    fun publish(actor: Actor,id: UUID,input: PublicationInput): MutationResult {
        val row=access.bank(actor,id,true);requireVersion(input.expectedVersion,row.version)
        if(input.status !in setOf("DRAFT","PUBLISHED","UNPUBLISHED","ARCHIVED")) invalid("/status")
        if(input.status=="PUBLISHED") validatePublication(row)
        row.publicationStatus=input.status;row.version++;row.updatedAt=Instant.now();banks.updateById(row);return MutationResult(id,row.version)
    }
    private fun validatePublication(row: QuestionBank) {
        if(publicationChecks(row).any { !it.passed }) invalid("/publication","PUBLISH_VALIDATION_FAILED","发布需要启用的课程、题库说明、有效题目、完整解析")
    }
    fun publicationChecks(actor: Actor,id: UUID): List<PublicationCheck> = publicationChecks(access.bank(actor,id))
    private fun publicationChecks(row: QuestionBank): List<PublicationCheck> = listOf(
        PublicationCheck("课程与题库已启用",row.status=="ACTIVE" && directory.subject(row.subjectId)?.status=="ACTIVE","停用的内容不能发布"),
        PublicationCheck("题库说明已填写",row.description.isNotBlank(),"说明题库用途与内容"),
        PublicationCheck("存在有效题目",sql.questionCount(row.id!!,true)>0,"阅读题组按小题计数"),
        PublicationCheck("启用题目解析完整",sql.publicationIssues(row.id!!)==0L,"题型、答案和章节归属在保存时校验")
    )
    fun validate(input: QuestionInput,validateReferences: Boolean=true) {
        if(input.contentFormat !in setOf("PLAIN_TEXT","MARKDOWN")) invalid("/contentFormat")
        if(input.presentation !in setOf("STANDARD","CONCEPT","CODE_ANALYSIS")) invalid("/presentation")
        if(input.presentation in setOf("CONCEPT","CODE_ANALYSIS") && input.type !in setOf("FILL_BLANK","SHORT_ANSWER")) invalid("/presentation")
        if(input.codeLanguage!=null) invalid("/codeLanguage")
        activeStatus(input.status);if(input.type!="READING" && input.stem.isBlank()) invalid("/stem");safeText(input.stem,10000);safeText(input.explanation,10000)
        if(validateReferences && input.chapterId!=null && chapters.selectById(input.chapterId)?.bankId!=input.questionBankId) invalid("/chapterId","CHAPTER_BANK_MISMATCH","章节不属于题库")
        if(input.assetIds.size>20 || input.assetIds.distinct().size!=input.assetIds.size) invalid("/assetIds")
        if(validateReferences) input.assetIds.forEach { if(files.selectById(it)?.bankId!=input.questionBankId) invalid("/assetIds") }
        if(input.type!="FILL_BLANK" && input.blanks.isNotEmpty() || input.type!="SHORT_ANSWER" && input.scoringPoints.isNotEmpty() || input.type!="READING" && (input.passage!=null || input.subQuestions.isNotEmpty())) invalid("/type")
        when(input.type) {
            "SINGLE_CHOICE","MULTIPLE_CHOICE" -> {
                if(input.options.size !in 2..26 || input.options.map { it.key }.distinct().size!=input.options.size) invalid("/options")
                input.options.forEach { if(!it.key.matches(Regex("[A-Z0-9]{1,8}")) || it.content.isBlank()) invalid("/options");safeText(it.content,4000) }
                if(input.correctAnswer.isEmpty() || input.correctAnswer.distinct().size!=input.correctAnswer.size || input.correctAnswer.any { a -> input.options.none { it.key==a } }) invalid("/correctAnswer")
                if(input.type=="SINGLE_CHOICE" && input.correctAnswer.size!=1 || input.type=="MULTIPLE_CHOICE" && input.correctAnswer.size<2 || input.correctValue!=null || input.referenceAnswer!=null) invalid("/correctAnswer")
            }
            "TRUE_FALSE" -> if(input.correctValue==null || input.options.isNotEmpty() || input.correctAnswer.isNotEmpty() || input.referenceAnswer!=null) invalid("/correctValue")
            "SHORT_ANSWER" -> { if(input.referenceAnswer.isNullOrBlank() || input.options.isNotEmpty() || input.correctAnswer.isNotEmpty() || input.correctValue!=null) invalid("/referenceAnswer");safeText(input.referenceAnswer,40000) }
            "FILL_BLANK" -> {
                if(input.blanks.size !in 1..20 || input.options.isNotEmpty() || input.correctAnswer.isNotEmpty() || input.correctValue!=null || input.referenceAnswer!=null) invalid("/blanks")
                input.blanks.forEach { blank ->
                    if(blank.answers.size !in 1..20 || blank.answers.any { it.isBlank() }) invalid("/blanks/answers")
                    blank.answers.forEach { safeText(it,500) }
                }
                val markers=Regex("(?<!\\\\)\\{\\{([^{}]*)}}").findAll(input.stem).map { it.groupValues[1] }.toList()
                if(markers.size!=input.blanks.size || markers.toSet()!=(1..input.blanks.size).map { it.toString() }.toSet()) invalid("/stem","BLANK_MARKERS_INVALID","请按空位顺序使用 {{1}}、{{2}} 等标记，每个空位出现一次")
            }
            "READING" -> {
                if(input.passage.isNullOrBlank() || input.subQuestions.size !in 1..50 || input.options.isNotEmpty() || input.correctAnswer.isNotEmpty() || input.correctValue!=null || input.referenceAnswer!=null) invalid("/subQuestions")
                safeText(input.passage,20000)
                val ids=input.subQuestions.mapNotNull { it.id };if(ids.distinct().size!=ids.size) invalid("/subQuestions/id")
                input.subQuestions.forEach { if(it.type=="READING") invalid("/subQuestions/type");validate(it.question(input),validateReferences) }
            }
            else -> invalid("/type")
        }
        if(input.scoringPoints.size>30 || input.scoringPoints.any { it.isBlank() }) invalid("/scoringPoints")
        input.scoringPoints.forEach { safeText(it,1000) }
    }
    private fun safeText(value: String,maximum: Int) { text(value,maximum) }
    fun materialRevision(question: Question): UUID? = question.readingParentId?.let { questions.selectById(it)?.currentRevisionId }
    fun questionView(question: Question,revisionId: UUID=question.currentRevisionId!!,answers: Boolean=false,materialRevisionId: UUID?=materialRevision(question)): QuestionView =
        reader.read(listOf(qanda.backend.content.api.RevisionReference(question.id!!,revisionId,materialRevisionId)),answers).single()
    fun question(actor: Actor?,id: UUID,includeAnswers: Boolean=false): QuestionView {
        val row=questions.selectById(id) ?: missing();access.bank(actor,row.bankId!!)
        if(actor?.kind!="ADMIN" && (row.status!="ACTIVE" || row.readingParentId?.let { questions.selectById(it)?.status!="ACTIVE" }==true)) missing()
        return questionView(row,answers=includeAnswers || actor?.kind=="ADMIN")
    }
    fun search(actor: Actor?,keyword: String,p: PageSpec,view: String="full"): Page<QuestionView> {
        if(actor!=null && actor.kind!="USER") forbidden()
        val query=keyword.trim()
        if(query.isEmpty() || query.length>200 || '\u0000' in query) invalid("/keyword")
        return Page(listQuestions(sql.search(query,p.offset,p.pageSize,actor?.id),false,view),sql.searchCount(query,actor?.id),p.page,p.pageSize)
    }
    fun questions(actor: Actor?,bankId: UUID,chapterId: UUID?,keyword: String?,p: PageSpec,view: String="full",type: String?=null,status: String?=null,unassigned: Boolean=false): Page<QuestionView> {
        if(type!=null && type !in listOf("SINGLE_CHOICE","MULTIPLE_CHOICE","TRUE_FALSE","FILL_BLANK","SHORT_ANSWER","READING")) invalid("/type")
        if(status!=null) activeStatus(status)
        access.bank(actor,bankId);val activeOnly=actor?.kind!="ADMIN"
        return Page(listQuestions(sql.questions(bankId,chapterId,keyword,activeOnly,p.offset,p.pageSize,type,status,unassigned),!activeOnly,view),sql.filteredQuestionCount(bankId,chapterId,keyword,activeOnly,type,status,unassigned),p.page,p.pageSize)
    }
    private fun listQuestions(rows: List<Question>,answers: Boolean,view: String): List<QuestionView> {
        if(view !in setOf("full","summary")) invalid("/view")
        if(view=="full") return reader.read(rows.map { qanda.backend.content.api.RevisionReference(it.id!!) },answers)
        if(rows.isEmpty()) return emptyList()
        val summaries=sql.questionSummaries(rows.map { it.id!! }).associateBy { it.id }
        return rows.map { row -> val q=summaries.getValue(row.id)
            val metadata=json.readValue(q.contentData,QuestionContentData::class.java)
            QuestionView(q.id!!,q.bankId!!,q.chapterId,q.status,q.version,q.revisionId!!,q.revision,q.type,q.stem,emptyList(),null,null,null,null,emptyList(),q.subjectId,q.subjectName,q.bankName,contentFormat=metadata.contentFormat,presentation=metadata.presentation,codeLanguage=metadata.codeLanguage)
        }
    }
    fun saveQuestion(actor: Actor,id: UUID?,input: QuestionInput): MutationResult {
        val bank=access.bank(actor,input.questionBankId,true);validate(input)
        if(id!=null && questions.selectById(id)?.readingParentId!=null) invalid("/id","QUESTION_GROUP_REQUIRED","请在阅读题组内编辑小题")
        val result=writeQuestion(actor,id,input)
        if(bank.publicationStatus=="PUBLISHED") validatePublication(bank)
        sql.bumpBank(input.questionBankId)
        return result
    }
    private fun writeQuestion(actor: Actor,id: UUID?,input: QuestionInput,parentId: UUID?=null,order: Int=0,allowNew: Boolean=false): MutationResult {
        val existing=id?.let { questions.selectById(it) }
        if(id!=null && existing==null && parentId==null && !allowNew) missing()
        val row=existing ?: Question().apply { this.id=id ?: UUID.randomUUID();bankId=input.questionBankId;readingParentId=parentId;readingOrder=order;isGroup=input.type=="READING" }
        if(row.bankId!=input.questionBankId) invalid("/questionBankId","IMMUTABLE_PARENT","题目所属题库不可变更")
        if(row.readingParentId!=parentId) invalid("/subQuestions/id","QUESTION_GROUP_MISMATCH","小题所属题组不可变更")
        if(existing!=null && parentId==null) requireVersion(input.expectedVersion ?: invalid("/expectedVersion"),row.version)
        val previous=existing?.let { revisions.selectById(it.currentRevisionId) }
        if(previous!=null && previous.type!=input.type) invalid("/type","IMMUTABLE_QUESTION_TYPE","题型变更请新增题目")
        val revision=QuestionRevision().apply { this.id=UUID.randomUUID();questionId=row.id;revisionNumber=(previous?.revisionNumber ?: 0)+1
            type=input.type;stem=input.stem;explanation=input.explanation;correctValue=input.correctValue;referenceAnswer=input.referenceAnswer;createdBy=actor.id }
        if(existing==null) { row.chapterId=input.chapterId;row.status=input.status;row.currentRevisionId=revision.id;questions.insert(row) }
        val children=input.subQuestions.mapIndexed { index,child ->
            val saved=writeQuestion(actor,child.id,child.question(input),row.id,index)
            ReadingChildRef(saved.id,questions.selectById(saved.id).currentRevisionId!!)
        }
        if(input.type=="READING") sql.readingChildren(row.id!!).filter { old -> children.none { it.id==old.id } }.forEach { old -> sql.updateQuestion(old.id!!,old.chapterId,"INACTIVE",old.currentRevisionId!!) }
        revision.contentData=json.writeValueAsString(QuestionContentData(input.blanks,input.blankMatch,input.scoringPoints,input.passage,children,input.contentFormat,input.presentation,input.codeLanguage))
        val changed=previous==null || previous.type!=revision.type || previous.stem!=revision.stem || previous.explanation!=revision.explanation || previous.correctValue!=revision.correctValue || previous.referenceAnswer!=revision.referenceAnswer || previous.contentData!=revision.contentData ||
            sql.options(previous.id!!).map { Triple(it.optionKey,it.content,it.isCorrect) }!=input.options.map { Triple(it.key,it.content,it.key in input.correctAnswer) } || sql.attachments(previous.id!!).toSet()!=input.assetIds.toSet()
        if(changed) {
            revisions.insert(revision)
            input.options.forEachIndexed { i,option -> sql.insertOption(QuestionOption().apply { revisionId=revision.id;optionKey=option.key;content=option.content;isCorrect=option.key in input.correctAnswer;sortOrder=i }) }
            input.assetIds.forEach { sql.attach(revision.id!!,it) }
        }
        if(existing!=null) { sql.updateQuestion(row.id!!,input.chapterId,input.status,if(changed) revision.id!! else previous!!.id!!);sql.readingOrder(row.id!!,order);row.version++ }
        return MutationResult(row.id!!,row.version)
    }
    fun deactivateQuestion(actor: Actor,id: UUID,expectedVersion: Long): MutationResult {
        val question=questions.selectById(id) ?: missing();val bank=access.bank(actor,question.bankId!!,true);requireVersion(expectedVersion,question.version)
        if(question.readingParentId!=null) invalid("/id","QUESTION_GROUP_REQUIRED","请在阅读题组内编辑小题")
        sql.updateQuestion(id,question.chapterId,"INACTIVE",question.currentRevisionId!!)
        sql.readingChildren(id).forEach { sql.updateQuestion(it.id!!,it.chapterId,"INACTIVE",it.currentRevisionId!!) }
        if(bank.publicationStatus=="PUBLISHED") validatePublication(bank)
        sql.bumpBank(question.bankId!!);return MutationResult(id,question.version+1)
    }
    fun validatePublishedQuestion(input: QuestionInput) {
        val incomplete=if(input.type=="READING") input.subQuestions.any { it.explanation.isBlank() } else input.explanation.isBlank()
        if(input.status=="ACTIVE" && incomplete) invalid("/explanation","PUBLISH_VALIDATION_FAILED","已发布题库的有效题目需要填写解析")
    }
    fun preview(actor: Actor,bankId: UUID,input: ImportInput): ImportPreview {
        val bank=access.bank(actor,bankId)
        val count=input.questions.sumOf { if(it.type=="READING") it.subQuestions.size else 1 }
        if(input.questions.size !in 1..3000 || count !in 1..3000) invalid("/questions","IMPORT_LIMIT_EXCEEDED","每批最多导入 3000 道实际作答题")
        val issues=input.questions.mapIndexedNotNull { i,q -> try { if(q.questionBankId!=bankId) invalid("/questionBankId");validate(q);null } catch(e: ApiException) { PreviewIssue(i,e.code,e.message) } }
        val publicationIssues=if(bank.publicationStatus=="PUBLISHED") input.questions.mapIndexedNotNull { i,q ->
            try { validatePublishedQuestion(q);null } catch(e: ApiException) { PreviewIssue(i,e.code,e.message) }
        } else emptyList()
        return ImportPreview(issues.isEmpty() && publicationIssues.isEmpty(),count,issues+publicationIssues)
    }
    fun import(actor: Actor,bankId: UUID,input: ImportInput,recordIds: List<UUID>?=null): ImportView {
        val bank=access.bank(actor,bankId,true);requireVersion(input.expectedContentVersion,bank.contentVersion)
        val preview=preview(actor,bankId,input);if(!preview.valid) invalid("/questions","IMPORT_VALIDATION_FAILED","导入校验失败，请先修正预览中的错误")
        val ids=input.questions.mapIndexed { index,q ->
            val id=recordIds?.get(index)
            if(id!=null && questions.selectById(id)!=null) conflict("EXCEL_RECORD_EXISTS","记录已存在")
            writeQuestion(actor,id,q,allowNew=true).id
        }
        if(bank.publicationStatus=="PUBLISHED") validatePublication(bank)
        sql.bumpBank(bankId)
        return ImportView(ids,banks.selectById(bankId).contentVersion)
    }
}
