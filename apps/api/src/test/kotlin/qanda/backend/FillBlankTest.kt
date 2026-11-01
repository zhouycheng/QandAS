package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import qanda.backend.content.*
import qanda.backend.practice.*
import qanda.backend.platform.http.ApiException
import java.util.UUID

class FillBlankTest {
    private fun question(match: BlankMatch=BlankMatch()): QuestionView = QuestionView(UUID.randomUUID(),UUID.randomUUID(),null,"ACTIVE",1,UUID.randomUUID(),1,"FILL_BLANK","{{1}} 和 {{2}}",emptyList(),null,null,null,"解析",emptyList(),
        blankCount=2,blanks=listOf(BlankInput(listOf("API","接口")),BlankInput(listOf("HTTP"))),blankMatch=match)
    @Test fun `all blanks must match and options control normalization`() {
        val q=question();val answer=AnswerInput(blanks=listOf(" api ","http"))
        Grading.validate(q,answer);assertEquals("CORRECT",Grading.outcome(q,answer))
        assertEquals("CORRECT",Grading.outcome(q,AnswerInput(blanks=listOf("接口","HTTP"))))
        assertEquals("WRONG",Grading.outcome(q,AnswerInput(blanks=listOf("api",""))))
        assertEquals("WRONG",Grading.outcome(question(BlankMatch(false,true)),answer))
        assertEquals("WRONG",Grading.outcome(question(BlankMatch(true,false)),answer))
        assertThrows(ApiException::class.java) { Grading.validate(q,AnswerInput(blanks=listOf("api"))) }
        assertThrows(ApiException::class.java) { Grading.validate(q,answer.copy(text="混合答案")) }
    }
}
