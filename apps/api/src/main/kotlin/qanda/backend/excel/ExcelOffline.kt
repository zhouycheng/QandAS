package qanda.backend.excel

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import java.nio.file.*
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.util.UUID

/** Offline delivery builder. Called before Spring starts; never obtains a datasource. */
object ExcelOffline {
    fun run(args: Array<String>) {
        require(args.size==2) { "excel-pack SOURCE_PACKAGE OUTPUT_DIRECTORY" }
        val source=Path.of(args[0]);val output=Path.of(args[1]);require(!Files.exists(output)) { "输出目录已存在" }
        Files.createDirectories(output);Files.setPosixFilePermissions(output,PosixFilePermissions.fromString("rwx------"))
        val j=ExcelWorkbook.json;val reports=mutableListOf<Map<String,Any>>()
        fun save(name: String,doc: JsonNode,kind: String) {
            val bytes=ExcelWorkbook.write(doc,kind);val restored=ExcelWorkbook.read(bytes,kind)
            fun compare(a: JsonNode,b: JsonNode) {
                for(key in listOf("id","type","stem","correctAnswer","correctValue","referenceAnswer","explanation","passage","options","blanks","blankMatch","scoringPoints","contentFormat","presentation")) if(a.has(key)) require(a[key]==b[key]) { "往返核对失败：$name / $key" }
                require(a.path("subQuestions").size()==b.path("subQuestions").size())
                a.path("subQuestions").forEachIndexed { i,c -> compare(c,b.path("subQuestions")[i]) }
            }
            if(kind=="users") require(doc["users"]==restored["users"]) { "用户往返核对失败" }
            else { require(doc.path("questions").size()==restored.path("questions").size());doc.path("questions").forEachIndexed { i,q -> compare(q,restored.path("questions")[i]) };require(doc.path("chapters").map { it.path("name").asText() }==restored.path("chapters").map { it.path("name").asText() }) }
            Files.write(output.resolve(name),bytes);Files.setPosixFilePermissions(output.resolve(name),PosixFilePermissions.fromString("rw-------"))
            reports.add(mapOf("file" to name,"bytes" to bytes.size,"roundTrip" to "PASS","sha256" to java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))))
        }
        val users=j.createObjectNode().put("fileId","qanda-students-20261101");val rows=users.putArray("users")
        Files.lines(source.resolve("audit/User.jsonl")).use { lines -> lines.forEach { line -> val u=j.readTree(line);if(u.path("role").asText()=="STUDENT") {
            var date=u.path("createdAt").asText().replace(' ','T');if(!date.endsWith('Z') && !date.contains('+')) date+="Z"
            val code="QA"+UUID.nameUUIDFromBytes(("qanda-excel-account:"+u.path("id").asText()).toByteArray()).toString().replace("-","").take(10).uppercase()
            rows.addObject().put("id",u.path("id").asText()).put("email",u.path("email").asText().trim()).put("nickname",u.path("nickname").asText().ifBlank { u.path("username").asText() }).put("accountCode",code).put("status",if(u.path("isActive").asBoolean()) "ACTIVE" else "DISABLED").put("registeredAt",java.time.Instant.parse(date).toString()).put("college","").put("major","").put("currentGrade","").put("systemId","")
        } } }
        require(rows.size()==2000 && rows.map { it.path("email").asText().lowercase() }.distinct().size==2000 && rows.map { it.path("accountCode").asText() }.distinct().size==2000)
        save("用户导入.xlsx",users,"users")
        var count=0;var chapters=0;var groups=0
        Files.list(source.resolve("banks")).use { list -> list.sorted().filter { it.toString().endsWith(".json") }.forEach { path ->
            val doc=j.readTree(Files.readAllBytes(path)) as ObjectNode
            doc.put("fileId","qanda-bank-"+path.fileName.toString().substringBefore('-'));doc.put("subject",doc.path("bank").path("name").asText())
            chapters+=doc.path("chapters").size();doc.path("questions").forEach { if(it.path("type").asText()=="READING") { groups++;count+=it.path("subQuestions").size() } else count++ }
            save(path.fileName.toString().removeSuffix(".json")+".xlsx",doc,"banks")
        } }
        require(count==4627 && chapters==120 && groups==6)
        for(kind in listOf("users","banks")) {
            val template=j.createObjectNode().put("fileId",UUID.randomUUID().toString());template.putArray(if(kind=="users") "users" else "questions");template.putArray("chapters");template.putObject("bank")
            val name=if(kind=="users") "用户空白模板.xlsx" else "题库空白模板.xlsx"
            Files.write(output.resolve(name),ExcelWorkbook.write(template,kind))
        }
        val report=mapOf("state" to "PREPARED_NOT_IMPORTED","users" to rows.size(),"banks" to 12,"chapters" to chapters,"answerableQuestions" to count,"readingGroups" to groups,"sourceSha256" to j.readTree(Files.readAllBytes(source.resolve("manifest.json"))).path("sourceSha256").asText(),"files" to reports)
        Files.writeString(output.resolve("核对清单.json"),j.writerWithDefaultPrettyPrinter().writeValueAsString(report))
        println("Excel 离线往返核对通过：2000 个学生、12 个题库、120 个章节、4627 道作答题、6 个阅读题组。")
    }
}
