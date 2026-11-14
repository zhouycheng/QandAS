package qanda.backend.operations

import com.baomidou.mybatisplus.annotation.*
import java.time.Instant
import java.util.UUID

@TableName("question_feedback")
class QuestionFeedback {
    @TableId(type = IdType.INPUT)
    var id: UUID? = null
    var userId: UUID? = null
    var questionId: UUID? = null
    var revisionId: UUID? = null
    var category: String = "OTHER"
    var body: String = ""
    var status: String = "OPEN"
    var response: String = ""
    var version: Long = 1
    var readVersion: Long = 0
    var createdAt: Instant = Instant.now()
    var updatedAt: Instant = Instant.now()
}

@TableName("course_request")
class CourseRequest {
    @TableId(type = IdType.INPUT)
    var id: UUID? = null
    var userId: UUID? = null
    var courseName: String = ""
    var majorId: UUID? = null
    var body: String = ""
    var status: String = "OPEN"
    var response: String = ""
    var version: Long = 1
    var readVersion: Long = 0
    var createdAt: Instant = Instant.now()
    var updatedAt: Instant = Instant.now()
}
