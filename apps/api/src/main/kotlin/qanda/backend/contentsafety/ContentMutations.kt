package qanda.backend.contentsafety

import java.util.UUID

object ContentMutations {
    fun operation(method: String,path: String,contentType: String?=null): String? {
        val route=path.removePrefix("/api/v1").substringBefore('?')
        if(method=="PUT" && route=="/me/profile") return "UPDATE_PROFILE"
        if(method=="POST" && route=="/me/question-feedback") return "SUBMIT_FEEDBACK"
        if(method=="POST" && route=="/me/course-requests") return "REQUEST_COURSE"
        if(method=="PUT" && route=="/admin/community/group") return "COMMUNITY_GROUP"
        val parts=route.trim('/').split('/')
        if(parts.firstOrNull()!="admin") return null
        val kind=when(parts.getOrNull(1)) {
            "colleges" -> "COLLEGE";"majors" -> "MAJOR";"subjects" -> "SUBJECT";"question-banks" -> "BANK"
            "questions" -> "QUESTION";"announcements" -> "ANNOUNCEMENT";"users" -> "USER_PROFILE"
            "question-feedback" -> "FEEDBACK";"course-requests" -> "REQUEST";else -> return null
        }
        if(method=="POST" && parts.size==2 && kind !in setOf("USER_PROFILE","FEEDBACK","REQUEST")) return "CREATE_$kind"
        val id=parts.getOrNull(2)?.let { runCatching { UUID.fromString(it).toString() }.getOrNull() } ?: return null
        if(method=="PUT" && parts.size==3) return (if(kind in setOf("FEEDBACK","REQUEST")) "HANDLE_" else "UPDATE_")+kind+":"+id
        if(kind=="BANK") {
            if(method=="PUT" && parts.size==4 && parts[3]=="publication") return "PUBLISH_BANK:$id"
            if(method=="POST" && parts.size==4 && parts[3]=="imports") return "IMPORT_QUESTIONS:$id"
            if(method=="POST" && parts.size==4 && parts[3]=="images") return "UPLOAD_IMAGE:$id:"+(contentType ?: return null).substringBefore(';').trim().lowercase()
            if(method=="POST" && parts.size==4 && parts[3]=="chapters") return "CREATE_CHAPTER:$id"
            if(method=="PUT" && parts.size==5 && parts[3]=="chapters") return "UPDATE_CHAPTER:"+(runCatching { UUID.fromString(parts[4]).toString() }.getOrNull() ?: return null)
        }
        return null
    }
}
