package qanda.backend.content

import com.baomidou.mybatisplus.annotation.*
import java.time.Instant
import java.util.UUID

@TableName("question_bank")
class QuestionBank {
    @TableId(type = IdType.INPUT)
    var id: UUID? = null
    var subjectId: UUID? = null
    var name: String = ""
    var description: String = ""
    var textbook: String = ""
    var status: String = "ACTIVE"
    var publicationStatus: String = "DRAFT"
    var version: Long = 1
    var contentVersion: Long = 1
    var createdBy: UUID? = null
    var createdAt: Instant = Instant.now()
    var updatedAt: Instant = Instant.now()
}

@TableName("chapter")
class Chapter {
    @TableId(type = IdType.INPUT)
    var id: UUID? = null
    var bankId: UUID? = null
    var name: String = ""
    var sortOrder: Int = 0
    var version: Long = 1
}

@TableName("question")
class Question {
    @TableId(type = IdType.INPUT)
    var id: UUID? = null
    var bankId: UUID? = null
    var chapterId: UUID? = null
    var readingParentId: UUID? = null
    var readingOrder: Int = 0
    var isGroup: Boolean = false
    var status: String = "ACTIVE"
    var currentRevisionId: UUID? = null
    var version: Long = 1
    var createdAt: Instant = Instant.now()
    var updatedAt: Instant = Instant.now()
}

@TableName("question_revision")
class QuestionRevision {
    @TableId(type = IdType.INPUT)
    var id: UUID? = null
    var questionId: UUID? = null
    var revisionNumber: Int = 1
    var type: String = ""
    var stem: String = ""
    var explanation: String = ""
    var correctValue: Boolean? = null
    var referenceAnswer: String? = null
    var contentData: String = "{}"
    var createdBy: UUID? = null
    var createdAt: Instant = Instant.now()
}

@TableName("question_option")
class QuestionOption {
    var revisionId: UUID? = null
    var optionKey: String = ""
    var content: String = ""
    var isCorrect: Boolean = false
    var sortOrder: Int = 0
}

@TableName("bank_category")
class BankCategory {
    @TableId(type = IdType.INPUT)
    var id: UUID? = null
    var bankId: UUID? = null
    var collegeId: UUID? = null
    var majorId: UUID? = null
    var grade: Int? = null
}
