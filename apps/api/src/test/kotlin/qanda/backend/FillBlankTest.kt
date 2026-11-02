package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import qanda.backend.content.*
import qanda.backend.practice.*
import qanda.backend.platform.http.ApiException
import java.util.UUID

class FillBlankTest {
    @Test fun `shared objective fixtures agree with offline clients`() {
        val json=com.fasterxml.jackson.module.kotlin.jacksonObjectMapper()
        val root=java.nio.file.Path.of("../../packages/content-format/fixtures")
        json.readTree(root.resolve("blank-grading.json").toFile()).forEach { row ->
            val q=question(BlankMatch(row["ignoreCase"].asBoolean(),row["trimWhitespace"].asBoolean())).copy(blankCount=1,blanks=listOf(BlankInput(row["answers"].map { it.asText() })))
            assertEquals(if(row["correct"].asBoolean()) "CORRECT" else "WRONG",Grading.outcome(q,AnswerInput(blanks=listOf(row["value"].asText()))),row["name"].asText())
        }
        json.readTree(root.resolve("scoring.json").toFile()).forEach { row ->
            val metrics=objectiveMetrics(row["objective"].asInt(),row["correct"].asInt(),row["wrong"].asInt())
            assertEquals(row["score"].takeUnless { it.isNull }?.asInt(),metrics.score)
            assertEquals(row["accuracy"].takeUnless { it.isNull }?.asDouble(),metrics.accuracy)
        }
    }

    @Test fun `empty drafts use the same whitespace as JavaScript`() {
        assertFalse(Grading.hasInput(AnswerInput(blanks=listOf("\uFEFF\u00A0", " "))))
        assertFalse(Grading.hasInput(AnswerInput(text="\uFEFF\t")))
        assertTrue(Grading.hasInput(AnswerInput(blanks=listOf("A", ""))))
        assertTrue(Grading.hasInput(AnswerInput(value=false)))
    }

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
