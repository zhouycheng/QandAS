package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import javax.imageio.ImageIO

class BankPackagePostgresTest: PostgresFixture() {
    @org.springframework.beans.factory.annotation.Autowired lateinit var excel: qanda.backend.application.ExcelService

    @Test fun `only a missing format uses the plain text compatibility path`() {
        val bank = fixture()
        val question = bank.questions[2]
        fun report() = call("GET","/admin/monitoring/compatibility")
        val initial = report()
        val revision = UUID.randomUUID()
        jdbc.update("""INSERT INTO question_revision(id,question_id,revision_number,type,stem,correct_value,created_by)
            SELECT ?,question_id,revision_number+1,type,stem,correct_value,created_by FROM question_revision
            WHERE id=(SELECT current_revision_id FROM question WHERE id=?)""",revision,question)
        jdbc.update("UPDATE question SET current_revision_id=? WHERE id=?",revision,question)
        val snapshot = createPractice(student(),bank)
        val historical = snapshot["items"].first { it["question"]["id"].asText()==question.toString() }["question"]
        assertEquals("PLAIN_TEXT",historical["contentFormat"].asText())
        val after = report()
        assertEquals(initial["legacyRevisions"].asLong()+1,after["legacyRevisions"].asLong())
        assertEquals(initial["referencedRevisions"].asLong()+1,after["referencedRevisions"].asLong())
        assertTrue(after["stats"].any { it["item"].asText()=="plain-default" && it["week"].asLong()>0 })
    }

    @Test fun `legacy Excel and JSON records remain available to guest and signed-in practice`() {
        val f=fixture()
        val actor=sessionService.authenticate(adminToken)
        val file=UUID.randomUUID().toString()
        val doc=json.readTree("""{"fileId":"$file","subject":"旧课程","bank":{"name":"旧库"},"questions":[{"id":"first","type":"TRUE_FALSE","stem":"Excel 原题","correctValue":true,"explanation":"原解析"}]}""")
        val version=call("GET","/admin/question-banks/${f.bank}")["contentVersion"].asLong()
        val workbook=qanda.backend.excel.ExcelFile("legacy.xlsx",qanda.backend.excel.ExcelWorkbook.write(doc,"banks"))
        excel.import(actor,"banks",listOf(workbook),qanda.backend.excel.ExcelOptions(mapOf(file to qanda.backend.excel.ExcelTarget(bankId=f.bank,expectedContentVersion=version))),UUID.randomUUID())
        val legacy=json.treeToValue(json.valueToTree<com.fasterxml.jackson.databind.JsonNode>(question(f.bank,"TRUE_FALSE")+mapOf("stem" to "JSON 原题")),qanda.backend.content.QuestionInput::class.java)
        contentService.import(actor,f.bank,qanda.backend.content.ImportInput(contentService.bank(actor,f.bank).contentVersion,listOf(legacy)))
        jdbc.execute("ALTER TABLE question ALTER COLUMN portable_id DROP NOT NULL")
        jdbc.update("UPDATE question SET portable_id=NULL WHERE bank_id=?",f.bank)
        jdbc.dataSource!!.connection.use { connection ->
            qanda.backend.platform.bootstrap.ProductionSchema.upgradeBankPackages(connection)
            val assigned=jdbc.queryForList("SELECT portable_id FROM question WHERE bank_id=? ORDER BY id",UUID::class.java,f.bank)
            assertEquals(6,assigned.filterNotNull().toSet().size)
            qanda.backend.platform.bootstrap.ProductionSchema.upgradeBankPackages(connection)
            assertEquals(assigned,jdbc.queryForList("SELECT portable_id FROM question WHERE bank_id=? ORDER BY id",UUID::class.java,f.bank))
        }
        val bank=call("GET","/question-banks/${f.bank}",token=null)
        val scope=mapOf("questionBankId" to f.bank,"count" to 6,"order" to "SEQUENTIAL")
        val input=mapOf("scope" to scope,"expectedContentVersion" to bank["contentVersion"],"feedback" to "IMMEDIATE")
        val student=student()
        val guest=call("POST","/practice/trial-snapshots",input,null)
        val device=jdbc.queryForObject("SELECT device_id FROM user_session WHERE id=?",UUID::class.java,sessionService.authenticate(student.token).sessionId)
        val session=call("POST","/practice/sessions",input+mapOf("deviceId" to device),student.token)
        for(snapshot in listOf(guest,session,call("GET","/practice/sessions/"+id(session),token=student.token))) {
            val stems=snapshot["items"].map { it["question"]["stem"].asText() }
            assertTrue(stems.containsAll(listOf("Excel 原题","JSON 原题")),stems.toString())
        }
    }
    @Test fun `image reading group survives cross-bank import revision changes and stale previews`() {
        val f=fixture()
        fun draft()=id(call("POST","/admin/question-banks",mapOf("subjectId" to f.subject,"name" to "图文练习")))
        val bank=draft()
        val other=draft()
        val portable=UUID.randomUUID()
        val childId=UUID.randomUUID()
        val seed=java.util.Random(51)
        val images=(1..3).map {
            val img=BufferedImage(1024,1024,BufferedImage.TYPE_INT_RGB)
            img.setRGB(0,0,1024,1024,IntArray(1024*1024) { seed.nextInt() },0,1024)
            ByteArrayOutputStream().also { ImageIO.write(img,"png",it) }.toByteArray()
        }
        fun archive(stem: String, includeImages: Boolean=true): ByteArray {
            val manifest=mapOf("format" to "qanda-question-bank","version" to "1.0","bank" to mapOf("name" to "导入"),
                "sources" to emptyList<Any>(),"chapters" to listOf(mapOf("id" to "c","name" to "阅读章节")),
                "assets" to images.indices.map { mapOf("id" to "fig$it","path" to "assets/images/$it.png") },
                "questions" to listOf(mapOf("id" to portable,"chapterId" to "c","type" to "READING","contentFormat" to "MARKDOWN","stem" to "题组","passage" to "材料 ![示意图](asset:fig0)",
                    "subQuestions" to listOf(mapOf("id" to childId,"type" to "TRUE_FALSE","stem" to stem,"correctValue" to false,"contentFormat" to "MARKDOWN","explanation" to "解析 ![答案图](asset:fig2)")))))
            return ByteArrayOutputStream().also { out -> ZipOutputStream(out).use { zip ->
                fun entry(name: String,bytes: ByteArray) { zip.putNextEntry(ZipEntry(name));zip.write(bytes);zip.closeEntry() }
                entry("bank.json",json.writeValueAsBytes(manifest))
                if(includeImages) images.forEachIndexed { i,data->entry("assets/images/$i.png",data) }
            } }.toByteArray()
        }
        fun stage(target: UUID,bytes: ByteArray): Map<String,String> {
            val base="/admin/question-banks/$target/package/uploads"
            val upload=call("POST",base,mapOf("sizeBytes" to bytes.size))["uploadId"].asText()
            val chunk=4*1024*1024
            for(start in bytes.indices step chunk) assertEquals(204,raw("PUT","$base/$upload/${start/chunk}",bytes.copyOfRange(start,minOf(start+chunk,bytes.size)),contentType="application/octet-stream").statusCode())
            return mapOf("uploadId" to upload)
        }
        fun preview(target: UUID,upload: Map<String,String>)=call("POST","/admin/question-banks/$target/package/preview",upload)
        fun commit(target: UUID,upload: Map<String,String>,preview: com.fasterxml.jackson.databind.JsonNode,confirmed: Boolean=false,status: Int=200)=
            call("POST","/admin/question-banks/$target/package/commit",upload+mapOf("expectedContentVersion" to preview["contentVersion"],"digest" to preview["digest"],"confirmUpdates" to confirmed),status=status)
        val original=archive("看图判断 ![题图](asset:fig1)")
        assertTrue(original.size>8*1024*1024)
        val first=stage(bank,original)
        val p=preview(bank,first)
        assertEquals("CREATE",p["changes"][0]["action"].asText())
        assertTrue(call("GET","/admin/question-banks/$bank/chapters").isEmpty)
        commit(bank,first,p)
        val parent=call("GET","/admin/question-banks/$bank/questions")["items"][0]
        val v=call("GET","/admin/question-banks/$bank")["version"]
        call("PUT","/admin/question-banks/$bank/publication",mapOf("expectedVersion" to v,"status" to "PUBLISHED"))
        val question="/questions/"+parent["subQuestions"][0]["id"].asText()
        fun fallbackHits() = call("GET","/admin/monitoring/compatibility")["stats"].firstOrNull { it["item"].asText()=="inline-fallback" }?.get("month")?.asLong() ?: 0L
        val before=fallbackHits()
        val legacy=call("GET",question,token=null)
        assertFalse(legacy["stem"].asText().contains("asset:"))
        assertEquals(1,legacy["assetIds"].size())
        assertEquals(2,call("GET","$question?includeAnswers=true",token=null)["assetIds"].size())
        val rich=json.readTree(raw("GET",question,token=null,extraHeaders=mapOf("X-Qanda-Inline-Images" to "1")).body())
        assertTrue(rich["stem"].asText().contains("](asset:"))
        assertTrue(rich["assetIds"].isEmpty)
        assertEquals(before+2,fallbackHits())
        val old=parent["subQuestions"][0]["revisionId"].asText()
        val exported=http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/v1/admin/question-banks/$bank/package")).header("Authorization","Bearer $adminToken").GET().build(),HttpResponse.BodyHandlers.ofByteArray())
        assertEquals(200,exported.statusCode())
        assertEquals("SKIP",preview(bank,stage(bank,exported.body()))["changes"][0]["action"].asText())
        val copy=stage(other,exported.body())
        val copyPreview=preview(other,copy)
        jdbc.execute("CREATE FUNCTION reject_package_test() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''rollback fixture''; END'")
        jdbc.execute("CREATE TRIGGER reject_package_test BEFORE INSERT ON question_revision FOR EACH ROW EXECUTE FUNCTION reject_package_test()")
        try {
            commit(other,copy,copyPreview,status=500)
            assertTrue(call("GET","/admin/question-banks/$other/chapters").isEmpty)
            assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM file_asset WHERE bank_id=?",Int::class.java,other))
            assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM question WHERE bank_id=?",Int::class.java,other))
        } finally {
            jdbc.execute("DROP TRIGGER reject_package_test ON question_revision")
            jdbc.execute("DROP FUNCTION reject_package_test()")
        }
        commit(other,copy,copyPreview)
        assertEquals("SKIP",preview(other,copy)["changes"][0]["action"].asText())
        val edit=stage(bank,archive("修改后的题干"))
        val diff=preview(bank,edit)
        assertEquals("UPDATE",diff["changes"][0]["action"].asText())
        commit(bank,edit,diff,status=422)
        call("POST","/admin/question-banks/$bank/chapters",mapOf("name" to "并发创建","sortOrder" to 2))
        commit(bank,edit,diff,true,409)
        commit(bank,edit,preview(bank,edit),true)
        assertTrue(jdbc.queryForObject("SELECT stem FROM question_revision WHERE id=?",String::class.java,UUID.fromString(old))!!.contains("看图判断"))
        val missing=stage(other,archive("缺图",false))
        call("POST","/admin/question-banks/$other/package/preview",missing,status=422)
    }
}
