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
        val course=call("GET","/admin/subjects/${generic.subject}")
        call("PUT","/admin/subjects/${generic.subject}",mapOf("name" to course["name"].asText(),"expectedVersion" to course["version"].asLong(),"categories" to listOf(mapOf("collegeId" to a.first))))
        assertEquals(1,count(generic,"&majorId="+a.second))
        assertEquals(0,count(generic,"&majorId="+b.second))
        val user=student()
        assertEquals(categorized.bank.toString(),call("GET","/question-banks/"+categorized.bank,token=user.token)["id"].asText())
        assertFalse(call("GET","/me",token=user.token).has("profileSetupSeen"))
        call("GET","/subjects?collegeId="+UUID.randomUUID(),token=null,status=422)
        call("GET","/subjects?grade=6",token=null,status=422)
    }

    @Test fun `legacy classifications do not split a subject's public catalog`() {
        val first=fixture()
        val subject=first.subject
        val second=id(call("POST","/admin/question-banks",mapOf("subjectId" to subject,"name" to "第二题库")))
        call("POST","/admin/questions",question(second,"TRUE_FALSE"))
        val bankPath="/admin/question-banks/$second"
        call("PUT","$bankPath/publication",mapOf("expectedVersion" to call("GET",bankPath)["version"].asLong(),"status" to "PUBLISHED"))
        jdbc.update("INSERT INTO bank_category(id,bank_id,grade) VALUES(gen_random_uuid(),?,1),(gen_random_uuid(),?,2)",first.bank,second)
        val subjectPath="/admin/subjects/$subject"
        val initial=call("GET",subjectPath)
        assertTrue(initial["categories"].isEmpty)
        fun banks(grade: Int)=call("GET","/question-banks?subjectId=$subject&grade=$grade",token=null)["items"].map { it["id"].asText() }.toSet()
        val both=setOf(first.bank.toString(),second.toString())
        assertEquals(both,banks(3))
        val majorCollege=id(call("POST","/admin/colleges",mapOf("name" to "院"+UUID.randomUUID(),"code" to UUID.randomUUID().toString())))
        val major=id(call("POST","/admin/majors",mapOf("name" to "专业","collegeId" to majorCollege,"code" to "M")))
        val update=mapOf("name" to initial["name"].asText(),"expectedVersion" to initial["version"].asLong(),"categories" to listOf(mapOf("majorId" to major,"grade" to 1)))
        call("PUT",subjectPath,update)
        call("PUT",subjectPath,update,status=409)
        call("PUT",bankPath,mapOf("subjectId" to subject,"name" to "第二题库","expectedVersion" to call("GET",bankPath)["version"].asLong(),"categories" to listOf(mapOf("grade" to 4))))
        assertEquals(major.toString(),call("GET",subjectPath)["categories"][0]["majorId"].asText())
        val term=initial["name"].asText()
        val listing=call("GET","/subjects?keyword=$term&majorId=$major&grade=1",token=null)
        assertEquals(1,listing["total"].asInt())
        assertEquals(2,listing["items"][0]["bankCount"].asInt())
        assertEquals(5,listing["items"][0]["questionCount"].asInt())
        assertEquals(0,call("GET","/subjects?keyword=$term&grade=2",token=null)["total"].asInt())
        fun search(grade: Int)=call("GET","/search?keyword=第二题库&kind=BANK&grade=$grade",token=null)["items"].map { it["id"].asText() }
        assertTrue(second.toString() in search(1))
        assertFalse(second.toString() in search(2))
        assertEquals(both,banks(1))
        assertTrue(banks(2).isEmpty())
        assertEquals(2,call("GET","/question-banks?subjectId=$subject&majorId=$major",token=null)["total"].asInt())
        call("GET","/subjects/$subject?grade=2",token=null,status=404)
        assertEquals(subject.toString(),call("GET","/subjects/$subject",token=null)["id"].asText())
        assertEquals(second.toString(),call("GET","/question-banks/$second",token=null)["id"].asText())
    }
}
