package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import qanda.backend.excel.ExcelWorkbook
import org.apache.poi.xssf.usermodel.XSSFWorkbook
import java.io.ByteArrayOutputStream

class ExcelWorkbookTest {
    @Test fun `long unicode multiline content and nested answers survive workbook round trip`() {
        val j=ExcelWorkbook.json
        val doc=j.readTree("""{"fileId":"roundtrip","subject":"课程","bank":{"name":"题库"},"chapters":[{"id":"c1","name":"章节"}],"questions":[{"id":"r1","chapterId":"c1","type":"READING","stem":"阅读","passage":"材料","subQuestions":[{"id":"q1","type":"FILL_BLANK","stem":"{{1}}","blanks":[{"answers":["001","A|B"]}],"blankMatch":{"ignoreCase":false,"trimWhitespace":true}}]},{"id":"q2","type":"SHORT_ANSWER","stem":"长资料","referenceAnswer":"temp"}]}""")
        val long=("资料😀\n".repeat(800))+"x".repeat(30000)
        (doc["questions"][1] as com.fasterxml.jackson.databind.node.ObjectNode).put("referenceAnswer",long)
        val read=ExcelWorkbook.read(ExcelWorkbook.write(doc,"banks"),"banks")
        assertEquals(long,read["questions"][1]["referenceAnswer"].asText())
        assertEquals(doc["questions"][0]["subQuestions"][0]["blanks"],read["questions"][0]["subQuestions"][0]["blanks"])
        assertFalse(read["questions"][0]["subQuestions"][0]["blankMatch"]["ignoreCase"].asBoolean())
    }
    @Test fun `formula cells are rejected and exported text stays literal`() {
        val doc=ExcelWorkbook.json.readTree("""{"fileId":"formula","users":[{"id":"001","email":"test@example.test","nickname":"=1+1"}]}""")
        val bytes=ExcelWorkbook.write(doc,"users")
        assertEquals("=1+1",ExcelWorkbook.read(bytes,"users")["users"][0]["nickname"].asText())
        XSSFWorkbook(bytes.inputStream()).use { b -> b.getSheet("用户").getRow(1).getCell(2).cellFormula="1+1";val out=ByteArrayOutputStream();b.write(out);assertThrows(IllegalArgumentException::class.java) { ExcelWorkbook.read(out.toByteArray(),"users") } }
    }
}
