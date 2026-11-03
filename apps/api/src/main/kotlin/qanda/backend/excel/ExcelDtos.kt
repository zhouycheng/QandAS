package qanda.backend.excel

import java.util.UUID

data class ExcelTarget(val bankId: UUID?=null,val subjectId: UUID?=null,val createSubject: Boolean=false,val expectedContentVersion: Long?=null,val chapterMap: Map<String,UUID> = emptyMap())
data class ExcelOptions(val targets: Map<String,ExcelTarget> = emptyMap())
data class ExcelPreview(val valid: Boolean,val count: Int,val files: List<Map<String,Any?>>,val issues: List<ExcelIssue>)
data class ExcelResult(val count: Int)
data class ExcelFile(val name: String,val bytes: ByteArray)
data class ExcelDownload(val name: String,val bytes: ByteArray,val mediaType: String)
