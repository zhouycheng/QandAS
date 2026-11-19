package qanda.backend.bankpackage

import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.ContentDisposition
import org.springframework.web.bind.annotation.*
import qanda.backend.identity.Sessions
import java.util.UUID
import jakarta.servlet.http.HttpServletRequest
import qanda.backend.platform.security.*
import qanda.backend.platform.http.invalid

@RestController
@RequestMapping("/api/v1/admin/question-banks/{bankId}/package")
class BankPackageController(private val sessions: Sessions, private val exporter: BankPackageExport, private val uploads: BankUploads, private val importer: BankPackageImport, private val commands: Commands) {
    @GetMapping(produces = ["application/zip"])
    @io.swagger.v3.oas.annotations.Operation(responses=[io.swagger.v3.oas.annotations.responses.ApiResponse(responseCode="200",content=[io.swagger.v3.oas.annotations.media.Content(mediaType="application/zip",schema=io.swagger.v3.oas.annotations.media.Schema(type="string",format="binary"))])])
    fun export(@PathVariable bankId: UUID, response: HttpServletResponse) {
        val actor = sessions.admin()
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("Content-Disposition", ContentDisposition.attachment().filename("question-bank.zip").build().toString())
        response.contentType = "application/zip"
        exporter.write(actor, bankId, response.outputStream)
    }

    @PostMapping(value=["/uploads"],produces=["application/json"])
    fun start(@PathVariable bankId: UUID,@RequestBody input: UploadSize) = uploads.start(sessions.admin(),bankId,input.sizeBytes)

    @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT)
    @PutMapping("/uploads/{id}/{part}",consumes=["application/octet-stream"])
    @io.swagger.v3.oas.annotations.Operation(requestBody=io.swagger.v3.oas.annotations.parameters.RequestBody(required=true,content=[io.swagger.v3.oas.annotations.media.Content(mediaType="application/octet-stream",schema=io.swagger.v3.oas.annotations.media.Schema(type="string",format="binary"))]))
    fun put(@PathVariable bankId: UUID,@PathVariable id: UUID,@PathVariable part: Int,request: HttpServletRequest) {
        val actor=sessions.admin()
        val bytes=request.inputStream.readNBytes(BankUploads.CHUNK+1)
        if(bytes.size>BankUploads.CHUNK) invalid("/part")
        uploads.put(actor,bankId,id,part,bytes)
    }

    @PostMapping(value=["/preview"],produces=["application/json"])
    fun preview(@PathVariable bankId: UUID,@RequestBody input: PackageRequest) = importer.process(sessions.admin(),bankId,input,false)

    @PostMapping(value=["/commit"],produces=["application/json"])
    fun commit(@PathVariable bankId: UUID,@RequestBody input: PackageRequest,@RequestHeader("Idempotency-Key") key: UUID,r: HttpServletRequest): PackageResult {
        val actor=sessions.admin()
        return commands.run(actor,key,"IMPORT_PACKAGE:$bankId",input,PackageResult::class.java,r.requestId()) { importer.process(actor,bankId,input,true) }
    }
}
