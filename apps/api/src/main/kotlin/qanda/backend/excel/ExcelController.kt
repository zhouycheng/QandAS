package qanda.backend.excel

import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.*
import org.springframework.web.bind.annotation.*
import org.springframework.web.multipart.MultipartFile
import qanda.backend.identity.Sessions
import qanda.backend.application.ExcelService
import qanda.backend.platform.http.invalid
import qanda.backend.platform.security.requestId
import java.util.zip.ZipInputStream

@RestController
@RequestMapping("/api/v1/admin")
class ExcelController(private val service: ExcelService,private val sessions: Sessions,private val json: ObjectMapper) {
    private fun kind(resource: String)=when(resource) { "users" -> "users";"question-banks" -> "banks";else -> invalid("/resource") }
    private fun input(files: List<MultipartFile>): List<ExcelFile> {
        val result=mutableListOf<ExcelFile>();var size=0L
        fun add(name: String,bytes: ByteArray) {
            require(name.isNotBlank() && !name.startsWith('/') && '\\' !in name && name.split('/').none { it==".." || it.isEmpty() }) { "文件路径无效" }
            size+=bytes.size;require(size<=128L*1024*1024 && result.size<1000 && result.none { it.name==name }) { "文件过大、重复或数量过多" }
            require(name.endsWith(".xlsx",true) || name.substringAfterLast('.').lowercase() in setOf("png","jpg","jpeg","webp")) { "仅支持 Excel 和图片附件" }
            result.add(ExcelFile(name,bytes))
        }
        files.forEach { f -> val name=f.originalFilename ?: ""
            if(name.endsWith(".zip",true)) ZipInputStream(f.inputStream).use { zip ->
                var entry=zip.nextEntry
                while(entry!=null) { if(!entry.isDirectory) { val bytes=zip.readNBytes(8*1024*1024+1);require(bytes.size<=8*1024*1024) { "单个文件超过 8 MiB" };add(entry.name,bytes) };entry=zip.nextEntry }
            } else add(name,f.bytes)
        }
        return result
    }
    private fun binary(value: ExcelDownload)=ResponseEntity.ok().cacheControl(CacheControl.noStore()).header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(value.name,Charsets.UTF_8).build().toString()).contentType(MediaType.parseMediaType(value.mediaType)).body(value.bytes)
    @GetMapping(value=["/users/excel/template","/question-banks/excel/template"],produces=["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]) fun template(request: HttpServletRequest): ResponseEntity<ByteArray> {
        val resource=request.requestURI.split('/')[4];sessions.admin();return binary(ExcelDownload("题小搭-${resource}-模板.xlsx",service.template(kind(resource)),"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
    }
    @GetMapping(value=["/users/excel/export","/question-banks/excel/export"],produces=["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/zip"]) fun export(request: HttpServletRequest,@RequestParam query: Map<String,String>): ResponseEntity<ByteArray> = binary(service.export(sessions.admin(),kind(request.requestURI.split('/')[4]),query))
    @PostMapping(value=["/users/excel/preview","/question-banks/excel/preview"],consumes=["multipart/form-data"],produces=["application/json"])
    fun preview(request: HttpServletRequest,@RequestParam files: List<MultipartFile>,@RequestParam(defaultValue="{}") options: String): ExcelPreview {
        val resource=request.requestURI.split('/')[4];val actor=sessions.admin()
        return try { service.preview(actor,kind(resource),input(files),json.readValue(options,ExcelOptions::class.java)) } catch(e: IllegalArgumentException) { ExcelPreview(false,0,emptyList(),listOf(ExcelIssue("上传文件","文件",1,"",e.message ?: "文件无效"))) }
    }
    @PostMapping(value=["/users/excel/imports","/question-banks/excel/imports"],consumes=["multipart/form-data"],produces=["application/json"])
    fun import(@RequestParam files: List<MultipartFile>,@RequestParam(defaultValue="{}") options: String,request: HttpServletRequest): ExcelResult {
        val resource=request.requestURI.split('/')[4];val actor=sessions.admin()
        return try { service.import(actor,kind(resource),input(files),json.readValue(options,ExcelOptions::class.java),request.requestId()) } catch(e: IllegalArgumentException) { invalid("/files","EXCEL_INVALID",e.message ?: "文件无效") }
    }
}
