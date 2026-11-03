package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import qanda.backend.excel.*
import java.util.UUID
import java.io.ByteArrayOutputStream

class ExcelPostgresTest: PostgresFixture() {
    @Test fun `reading workbook supports every child type through preview import and export`() {
        val doc=json.readTree("""{"fileId":"${UUID.randomUUID()}","subject":"阅读课程${UUID.randomUUID()}","bank":{"name":"阅读题库"},"chapters":[],"questions":[{"id":"reading","type":"READING","stem":"阅读题组","passage":"完整材料","subQuestions":[{"id":"single","type":"SINGLE_CHOICE","stem":"单选","options":[{"key":"A","content":"甲"},{"key":"B","content":"乙"}],"correctAnswer":["A"]},{"id":"multiple","type":"MULTIPLE_CHOICE","stem":"多选","options":[{"key":"A","content":"甲"},{"key":"B","content":"乙"},{"key":"C","content":"丙"}],"correctAnswer":["A","C"]},{"id":"judge","type":"TRUE_FALSE","stem":"判断","correctValue":false},{"id":"blank","type":"FILL_BLANK","stem":"填入 {{1}}","blanks":[{"answers":["1","一"]}],"blankMatch":{"ignoreCase":false,"trimWhitespace":true}},{"id":"short","type":"SHORT_ANSWER","stem":"简答","referenceAnswer":"参考","scoringPoints":["要点"]}]}]}""")
        val long="长".repeat(40000)
        (doc["questions"][0]["subQuestions"][4] as com.fasterxml.jackson.databind.node.ObjectNode).put("referenceAnswer",long)
        val options="""{"targets":{"${doc["fileId"].asText()}":{"createSubject":true}}}"""
        val preview=upload("banks","preview",doc,options)
        assertEquals(200,preview.first);assertTrue(preview.second["valid"].asBoolean(),preview.second.toString())
        assertEquals(5,preview.second["count"].asInt())
        val imported=upload("banks","imports",doc,options)
        assertEquals(200,imported.first,imported.second.toString())
        val bank=jdbc.queryForObject("SELECT b.id FROM question_bank b JOIN subject s ON s.id=b.subject_id WHERE s.name=?",UUID::class.java,doc["subject"].asText())!!
        val copy=exported("/admin/question-banks/excel/export?bankId=$bank","banks")
        assertEquals(1,copy["questions"].size());assertEquals(5,copy["questions"][0]["subQuestions"].size())
        val children=copy["questions"][0]["subQuestions"]
        assertEquals(listOf("A","C"),children[1]["correctAnswer"].map { it.asText() })
        assertFalse(children[2]["correctValue"].asBoolean())
        assertEquals(listOf("1","一"),children[3]["blanks"][0]["answers"].map { it.asText() })
        assertEquals(long,children[4]["referenceAnswer"].asText())
    }
    @Test fun `empty draft bank exports its metadata and chapters`() {
        val subject=id(call("POST","/admin/subjects",mapOf("name" to "空题库课程${UUID.randomUUID()}")))
        val bank=id(call("POST","/admin/question-banks",mapOf("subjectId" to subject,"name" to "空白草稿","description" to "保留说明","textbook" to "教材信息")))
        call("POST","/admin/question-banks/$bank/chapters",mapOf("name" to "待补充章节","sortOrder" to 0))
        for(path in listOf("/admin/question-banks/excel/export?bankId=$bank","/admin/question-banks/excel/export?subjectId=$subject")) {
            val doc=exported(path,"banks")
            assertEquals("空白草稿",doc["bank"]["name"].asText())
            assertEquals("保留说明",doc["bank"]["description"].asText())
            assertEquals("教材信息",doc["bank"]["textbook"].asText())
            assertEquals(1,doc["chapters"].size());assertEquals(0,doc["questions"].size())
        }
    }
    private fun exported(path: String,kind: String): com.fasterxml.jackson.databind.JsonNode {
        val response=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI("http://127.0.0.1:$port/api/v1$path")).header("Authorization","Bearer $adminToken").GET().build(),java.net.http.HttpResponse.BodyHandlers.ofByteArray())
        assertEquals(200,response.statusCode(),String(response.body()).take(200))
        val bytes=if(response.headers().firstValue("Content-Type").orElse("").contains("zip")) java.util.zip.ZipInputStream(response.body().inputStream()).use { zip ->
            var entry=zip.nextEntry
            while(entry!=null && !entry.name.endsWith(".xlsx")) entry=zip.nextEntry
            assertNotNull(entry);zip.readAllBytes()
        } else response.body()
        return ExcelWorkbook.read(bytes,kind)
    }
    private fun upload(kind: String,action: String,doc: com.fasterxml.jackson.databind.JsonNode,options: String="{}",token: String?=adminToken,edit: (ByteArray)->ByteArray={ it }): Pair<Int,com.fasterxml.jackson.databind.JsonNode> {
        val boundary="qanda${UUID.randomUUID()}";val bytes=ByteArrayOutputStream()
        val books=if(doc.isArray) doc.toList() else listOf(doc)
        books.forEachIndexed { index,book ->
            bytes.write("--$boundary\r\nContent-Disposition: form-data; name=\"files\"; filename=\"fixture$index.xlsx\"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n".toByteArray())
            bytes.write(edit(ExcelWorkbook.write(book,kind)));bytes.write("\r\n".toByteArray())
            book.path("assets").distinctBy { it.path("path").asText() }.forEach { asset ->
                val png=ByteArrayOutputStream();javax.imageio.ImageIO.write(java.awt.image.BufferedImage(32,32,java.awt.image.BufferedImage.TYPE_INT_RGB),"png",png)
                bytes.write("--$boundary\r\nContent-Disposition: form-data; name=\"files\"; filename=\"${asset["path"].asText()}\"\r\nContent-Type: image/png\r\n\r\n".toByteArray());bytes.write(png.toByteArray());bytes.write("\r\n".toByteArray())
            }
        }
        bytes.write("--$boundary\r\nContent-Disposition: form-data; name=\"options\"\r\n\r\n$options\r\n--$boundary--\r\n".toByteArray())
        val response=raw("POST","/admin/${if(kind=="users") "users" else "question-banks"}/excel/$action",bytes.toByteArray(),token,contentType="multipart/form-data; boundary=$boundary")
        return response.statusCode() to json.readTree(response.body())
    }
    @Test fun `multi file failure rolls back preceding account and receipt writes`() {
        val address="${UUID.randomUUID()}@example.test"
        val batch=json.readTree("""[{"fileId":"${UUID.randomUUID()}","users":[{"id":"1","email":"$address","nickname":"第一份"}]},{"fileId":"${UUID.randomUUID()}","users":[{"id":"2","email":"$address","nickname":"第二份"}]}]""")
        val before=jdbc.queryForObject("SELECT count(*) FROM user_account",Int::class.java)
        assertEquals(422,upload("users","imports",batch).first)
        assertEquals(before,jdbc.queryForObject("SELECT count(*) FROM user_account",Int::class.java))
    }
    @Test fun `attached picture is previewed imported and exported with workbook references`() {
        val doc=json.readTree("""{"fileId":"${UUID.randomUUID()}","subject":"图片课程${UUID.randomUUID()}","bank":{"name":"图片题库"},"chapters":[],"assets":[{"id":"image","path":"image.png"}],"questions":[{"id":"q1","type":"TRUE_FALSE","stem":"图示判断","correctValue":false,"assetIds":["image"]}]}""")
        val options="""{"targets":{"${doc["fileId"].asText()}":{"createSubject":true}}}"""
        assertTrue(upload("banks","preview",doc,options).second["valid"].asBoolean())
        val result=upload("banks","imports",doc,options);assertEquals(200,result.first,result.second.toString())
        val bank=jdbc.queryForObject("SELECT b.id FROM question_bank b JOIN subject s ON s.id=b.subject_id WHERE s.name=?",UUID::class.java,doc["subject"].asText())!!
        val copy=exported("/admin/question-banks/excel/export?bankId=$bank","banks")
        assertEquals(1,copy["questions"][0]["assetIds"].size());assertEquals(1,copy["assets"].size())
    }
    @Test fun `shared attachment ids keep one image and conflicting paths are rejected without writes`() {
        val doc=json.readTree("""{"fileId":"${UUID.randomUUID()}","subject":"共享图片${UUID.randomUUID()}","bank":{"name":"共享题库"},"assets":[{"id":"image","path":"first.png"},{"id":"image","path":"second.png"}],"questions":[{"id":"q1","type":"TRUE_FALSE","stem":"第一题","correctValue":true,"assetIds":["image"]},{"id":"q2","type":"TRUE_FALSE","stem":"第二题","correctValue":false,"assetIds":["image"]}]}""")
        val options="""{"targets":{"${doc["fileId"].asText()}":{"createSubject":true}}}"""
        val conflicting: (ByteArray)->ByteArray={ bytes ->
            org.apache.poi.xssf.usermodel.XSSFWorkbook(bytes.inputStream()).use { book ->
                book.getSheet("附件").getRow(2).getCell(1).setCellValue("second.png")
                ByteArrayOutputStream().also { book.write(it) }.toByteArray()
            }
        }
        val before=jdbc.queryForObject("SELECT count(*) FROM subject",Int::class.java)
        val preview=upload("banks","preview",doc,options,edit=conflicting)
        assertFalse(preview.second["valid"].asBoolean(),preview.second.toString())
        assertEquals("附件",preview.second["issues"][0]["sheet"].asText())
        assertEquals("文件路径",preview.second["issues"][0]["column"].asText())
        assertEquals(422,upload("banks","imports",doc,options,edit=conflicting).first)
        assertEquals(before,jdbc.queryForObject("SELECT count(*) FROM subject",Int::class.java))
        assertTrue(upload("banks","preview",doc,options).second["valid"].asBoolean())
        val result=upload("banks","imports",doc,options);assertEquals(200,result.first,result.second.toString())
        val bank=jdbc.queryForObject("SELECT b.id FROM question_bank b JOIN subject s ON s.id=b.subject_id WHERE s.name=?",UUID::class.java,doc["subject"].asText())!!
        val copy=exported("/admin/question-banks/excel/export?bankId=$bank","banks")
        assertEquals(copy["questions"][0]["assetIds"],copy["questions"][1]["assetIds"])
        assertEquals(1,copy["assets"].map { it["id"].asText() }.distinct().size)
    }
    @Test fun `account workbook preview is read only import is idempotent and code login uses isolated proof`() {
        val address="${UUID.randomUUID()}@example.test"
        val doc=json.readTree("""{"fileId":"${UUID.randomUUID()}","users":[{"id":"s1","email":"$address","nickname":"Excel学生","status":"ACTIVE","registeredAt":"2025-01-01T00:00:00Z"}]}""")
        val before=jdbc.queryForObject("SELECT count(*) FROM user_account",Int::class.java)
        val preview=upload("users","preview",doc);assertEquals(200,preview.first,preview.second.toString());assertTrue(preview.second["valid"].asBoolean(),preview.second.toString())
        assertEquals(before,jdbc.queryForObject("SELECT count(*) FROM user_account",Int::class.java))
        val result=upload("users","imports",doc);assertEquals(200,result.first,result.second.toString())
        assertEquals(result,upload("users","imports",doc));assertFalse(upload("users","preview",doc).second["valid"].asBoolean())
        assertEquals(before!!+1,jdbc.queryForObject("SELECT count(*) FROM user_account",Int::class.java))
        val exported=exported("/admin/users/excel/export?keyword=$address","users")
        assertEquals(1,exported["users"].size());assertEquals(address,exported["users"][0]["email"].asText())
        assertNull(jdbc.queryForObject("SELECT password_hash FROM user_account WHERE email_key=?",String::class.java,address))
        assertEquals(401,upload("users","imports",doc,token=null).first)
        val proof=call("POST","/auth/email-challenges",mapOf("purpose" to "LOGIN","email" to address),null,201)
        val payload=mapOf("challengeId" to id(proof),"code" to code(id(proof)),"deviceId" to UUID.randomUUID())
        val wrong=if(payload["code"]=="000000") "999999" else "000000"
        call("POST","/auth/email-code-sessions",payload+mapOf("code" to wrong),null,409)
        val session=call("POST","/auth/email-code-sessions",payload,null)
        assertEquals(address,call("GET","/me",token=session["accessToken"].asText())["email"].asText())
        call("POST","/auth/email-code-sessions",payload,null,409)
        jdbc.update("UPDATE email_challenge SET created_at=created_at-interval '61 seconds' WHERE email_key=?",address)
        val reset=call("POST","/auth/email-challenges",mapOf("purpose" to "RESET_PASSWORD","email" to address),null,201)
        call("POST","/auth/email-code-sessions",mapOf("challengeId" to id(reset),"code" to code(id(reset)),"deviceId" to UUID.randomUUID()),null,409)
    }
    @Test fun `full bank import preserves identical separate records and rollback rejects bad references`() {
        val doc=json.readTree("""{"fileId":"${UUID.randomUUID()}","subject":"Excel课程${UUID.randomUUID()}","bank":{"name":"Excel题库"},"chapters":[{"id":"c1","name":"第一章"}],"questions":[{"id":"q1","chapterId":"c1","type":"TRUE_FALSE","stem":"相同内容","correctValue":true},{"id":"q2","chapterId":"c1","type":"TRUE_FALSE","stem":"相同内容","correctValue":true}]}""")
        val options="""{"targets":{"${doc["fileId"].asText()}":{"createSubject":true}}}"""
        val preview=upload("banks","preview",doc,options);assertEquals(200,preview.first,preview.second.toString());assertTrue(preview.second["valid"].asBoolean(),preview.second.toString())
        val imported=upload("banks","imports",doc,options);assertEquals(200,imported.first,imported.second.toString());assertEquals(2,imported.second["count"].asInt())
        assertEquals(imported,upload("banks","imports",doc,options))
        val bank=jdbc.queryForObject("SELECT b.id FROM question_bank b JOIN subject s ON s.id=b.subject_id WHERE s.name=?",UUID::class.java,doc["subject"].asText())!!
        assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM question WHERE bank_id=?",Int::class.java,bank))
        assertEquals("DRAFT",jdbc.queryForObject("SELECT publication_status FROM question_bank WHERE id=?",String::class.java,bank))
        val exported=exported("/admin/question-banks/excel/export?bankId=$bank","banks")
        assertEquals(2,exported["questions"].size());assertEquals("相同内容",exported["questions"][0]["stem"].asText())
        val append=doc.deepCopy<com.fasterxml.jackson.databind.node.ObjectNode>().put("fileId",UUID.randomUUID().toString())
        val version=call("GET","/admin/question-banks/$bank")["contentVersion"].asLong()
        val stale="""{"targets":{"${append["fileId"].asText()}":{"bankId":"$bank","expectedContentVersion":${version-1}}}}"""
        assertFalse(upload("banks","preview",append,stale).second["valid"].asBoolean())
        assertEquals(409,upload("banks","imports",append,stale).first)
        val missingVersion="""{"targets":{"${append["fileId"].asText()}":{"bankId":"$bank"}}}"""
        assertEquals(422,upload("banks","imports",append,missingVersion).first)
        val target="""{"targets":{"${append["fileId"].asText()}":{"bankId":"$bank","expectedContentVersion":$version}}}"""
        assertEquals(200,upload("banks","imports",append,target).first)
        assertEquals(4,jdbc.queryForObject("SELECT count(*) FROM question WHERE bank_id=?",Int::class.java,bank))
        val nextVersion=call("GET","/admin/question-banks/$bank")["contentVersion"].asLong()
        val one=doc.deepCopy<com.fasterxml.jackson.databind.node.ObjectNode>().put("fileId",UUID.randomUUID().toString())
        val two=doc.deepCopy<com.fasterxml.jackson.databind.node.ObjectNode>().put("fileId",UUID.randomUUID().toString())
        val batch=json.createArrayNode().add(one).add(two)
        val batchOptions="""{"targets":{"${one["fileId"].asText()}":{"bankId":"$bank","expectedContentVersion":$nextVersion},"${two["fileId"].asText()}":{"bankId":"$bank","expectedContentVersion":$nextVersion}}}"""
        assertTrue(upload("banks","preview",batch,batchOptions).second["valid"].asBoolean())
        assertEquals(200,upload("banks","imports",batch,batchOptions).first)
        assertEquals(8,jdbc.queryForObject("SELECT count(*) FROM question WHERE bank_id=?",Int::class.java,bank))
        assertEquals(200,upload("banks","imports",batch,batchOptions).first)
        assertEquals(8,jdbc.queryForObject("SELECT count(*) FROM question WHERE bank_id=?",Int::class.java,bank))
        val bad=doc.deepCopy<com.fasterxml.jackson.databind.node.ObjectNode>().put("fileId",UUID.randomUUID().toString()).put("subject","坏引用${UUID.randomUUID()}")
        (bad["questions"][1] as com.fasterxml.jackson.databind.node.ObjectNode).put("chapterId","missing")
        val count=jdbc.queryForObject("SELECT count(*) FROM subject",Int::class.java)
        assertEquals(422,upload("banks","imports",bad,"""{"targets":{"${bad["fileId"].asText()}":{"createSubject":true}}}""").first)
        assertEquals(count,jdbc.queryForObject("SELECT count(*) FROM subject",Int::class.java))
    }
}
