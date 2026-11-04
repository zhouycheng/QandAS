package qanda.backend.contentsafety

object ContentMutations {
    fun operation(method: String,path: String): String? = when(method to path.removePrefix("/api/v1").substringBefore('?')) {
        "PUT" to "/me/profile" -> "UPDATE_PROFILE"
        "POST" to "/me/question-feedback" -> "SUBMIT_FEEDBACK"
        "POST" to "/me/course-requests" -> "REQUEST_COURSE"
        else -> null
    }
}
