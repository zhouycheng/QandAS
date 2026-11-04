package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

class CategoryFiltersPostgresTest : PostgresFixture() {
    @Test fun `classification conjunction stays within one row and generic banks match every selection`() {
        fun directory(): Pair<UUID,UUID> {
            val college=id(call("POST","/admin/colleges",mapOf("name" to "分类"+UUID.randomUUID(),"code" to UUID.randomUUID().toString())))
            val major=id(call("POST","/admin/majors",mapOf("collegeId" to college,"name" to "专业","code" to "M")))
            return college to major
        }
        val a=directory();val b=directory()
        val categorized=fixture(listOf(mapOf("majorId" to a.second,"grade" to 1),mapOf("majorId" to b.second,"grade" to 2)))
        val generic=fixture()
        fun count(bank: Fixture,query: String)=call("GET","/question-banks?subjectId="+bank.subject+query,token=null)["total"].asInt()
        assertEquals(1,count(categorized,"&collegeId="+a.first+"&grade=1"))
        assertEquals(0,count(categorized,"&collegeId="+a.first+"&grade=2"))
        assertEquals(1,count(categorized,"&majorId="+b.second+"&grade=2"))
        assertEquals(1,count(categorized,""))
        assertEquals(1,count(generic,"&collegeId="+a.first+"&majorId="+a.second+"&grade=5"))
        val user=student()
        assertEquals(categorized.bank.toString(),call("GET","/question-banks/"+categorized.bank,token=user.token)["id"].asText())
        assertFalse(call("GET","/me",token=user.token).has("profileSetupSeen"))
        call("GET","/subjects?collegeId="+UUID.randomUUID(),token=null,status=422)
        call("GET","/subjects?grade=6",token=null,status=422)
    }
}
