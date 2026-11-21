package qanda.backend

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import qanda.backend.bankpackage.packageSource
import qanda.backend.platform.http.ApiException

class PackageSourceTest {
    @Test fun `AI explanations accept concise reasoning and legacy sections and require text`() {
        val json = ObjectMapper()
        val sources = json.readTree("""[{"id":"s","name":"练习","kind":"text"}]""")
        val row = json.createObjectNode().put("type", "TRUE_FALSE")
        row.set<com.fasterxml.jackson.databind.JsonNode>("provenance", json.readTree("""
            {"origin":"extracted","sourceRefs":[{"sourceId":"s","location":"第 1 题"}],
             "ai":{"fields":["explanation"],"note":"依据题干补写解析"}}
        """))
        for (body in listOf("正确。断电后 RAM 通常会丢失数据。", listOf("结论","核心知识点","解题过程","记忆方法","易错题型").joinToString("\n") { "### $it\n正文" })) {
            assertNotNull(packageSource(json, row.put("explanation", body), sources))
        }
        assertThrows(ApiException::class.java) { packageSource(json, row.put("explanation", "  "), sources) }
        assertThrows(ApiException::class.java) { packageSource(json, row.putNull("explanation"), sources) }
    }
}
