package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

class ProfileSetupPostgresTest : PostgresFixture() {
    @Test fun `setup acknowledgement belongs to the account and preserves profile and credentials`() {
        val s=student();val before=call("GET","/me",token=s.token)
        assertFalse(before["profileSetupSeen"].asBoolean())
        val key=UUID.randomUUID()
        val ack=call("POST","/me/profile-setup/acknowledgement",token=s.token,key=key)
        assertEquals(ack,call("POST","/me/profile-setup/acknowledgement",token=s.token,key=key))
        val after=call("GET","/me",token=s.token)
        assertTrue(after["profileSetupSeen"].asBoolean())
        assertEquals(before["version"],after["version"])
        assertEquals(before["nickname"],after["nickname"])
        assertEquals(before["collegeId"],after["collegeId"])
        assertFalse(after["profileComplete"].asBoolean())
        val next=call("POST","/auth/sessions",mapOf("email" to s.email,"password" to studentPassword,"deviceId" to UUID.randomUUID()),token=null)
        assertTrue(call("GET","/me",token=next["accessToken"].asText())["profileSetupSeen"].asBoolean())
        assertFalse(call("GET","/me",token=student().token)["profileSetupSeen"].asBoolean())
        call("POST","/me/profile-setup/acknowledgement",token=null,status=401)
        call("POST","/me/profile-setup/acknowledgement",status=403)
        call("POST","/me/profile-setup/acknowledgement",token=s.token,key=null,status=400)
    }

    @Test fun `bank scope narrows by college major and grade across reads and practice`() {
        val s=student()
        fun college()=id(call("POST","/admin/colleges",mapOf("name" to "学院${UUID.randomUUID()}","code" to UUID.randomUUID().toString())))
        fun major(c: UUID)=id(call("POST","/admin/majors",mapOf("collegeId" to c,"name" to "专业${UUID.randomUUID()}","code" to UUID.randomUUID().toString())))
        val c=college();val otherCollege=college();val m=major(c);val sibling=major(c);val other=major(otherCollege)
        val two=fixture(listOf(mapOf("majorId" to m,"grade" to 2)))
        val three=fixture(listOf(mapOf("majorId" to m,"grade" to 3)))
        val sameCollege=fixture(listOf(mapOf("majorId" to sibling)))
        val elsewhere=fixture(listOf(mapOf("majorId" to other)))
        val common=fixture()
        val banks=listOf(two,three,sameCollege,elsewhere,common)
        fun scope(college: UUID?,major: UUID?,grade: Int?) {
            jdbc.update("UPDATE user_profile SET college_id=?,major_id=?,grade=?,grade_academic_year=CASE WHEN ?::integer IS NULL THEN NULL ELSE academic_year((now() AT TIME ZONE 'Asia/Shanghai')::date) END WHERE user_id=?",college,major,grade,grade,s.id)
        }
        fun visible(expected: Set<UUID>) {
            banks.forEach { f ->
                val allowed=f.bank in expected
                assertEquals(allowed,jdbc.queryForObject("SELECT bank_visible(?,?)",Boolean::class.java,f.bank,s.id),f.bank.toString())
                call("GET","/question-banks/${f.bank}",token=s.token,status=if(allowed) 200 else 404)
                call("GET","/questions/${f.questions.first()}",token=s.token,status=if(allowed) 200 else 404)
                val list=call("GET","/question-banks?subjectId=${f.subject}",token=s.token)
                assertEquals(if(allowed) 1 else 0,list["total"].asInt())
                call("POST","/practice/scope-preview",mapOf("questionBankId" to f.bank,"count" to 4,"order" to "RANDOM"),s.token,status=if(allowed) 200 else 404)
            }
        }
        visible(banks.map { it.bank }.toSet())
        val practice=createPractice(s,elsewhere)
        scope(c,null,3);visible(setOf(two.bank,three.bank,sameCollege.bank,common.bank))
        scope(null,m,null);visible(setOf(two.bank,three.bank,common.bank))
        scope(null,m,2);visible(setOf(two.bank,common.bank))
        call("GET","/practice/sessions/${id(practice)}",token=s.token)
        val version=call("GET","/admin/subjects/${elsewhere.subject}")["version"].asLong()
        call("POST","/admin/subjects/${elsewhere.subject}/user-access",mapOf("userId" to s.id,"expectedVersion" to version))
        visible(setOf(two.bank,elsewhere.bank,common.bank))
        scope(null,null,null)
        jdbc.update("UPDATE question_bank SET publication_status='DRAFT' WHERE id=?",three.bank)
        call("GET","/question-banks/${three.bank}",token=s.token,status=404)
        call("GET","/question-banks/${three.bank}",token=null,status=404)
    }
}
