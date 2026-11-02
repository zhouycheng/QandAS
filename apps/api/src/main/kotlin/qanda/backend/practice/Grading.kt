package qanda.backend.practice

import qanda.backend.content.QuestionView
import qanda.backend.platform.http.invalid

object Grading {
    private const val answerWhitespace=" \t\n\r\u000B\u000C\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"
    fun hasInput(answer: AnswerInput?): Boolean = answer!=null && (answer.value!=null || !answer.optionKeys.isNullOrEmpty() || answer.text?.any { it !in answerWhitespace }==true || answer.blanks.orEmpty().any { value -> value.any { it !in answerWhitespace } })
    fun validate(question: QuestionView,answer: AnswerInput?) {
        if(answer==null) return
        if(question.type!="FILL_BLANK" && answer.blanks!=null) invalid("/answer/blanks")
        when(question.type) {
            "SINGLE_CHOICE","MULTIPLE_CHOICE" -> {
                val keys=answer.optionKeys ?: invalid("/answer/optionKeys")
                if(keys.isEmpty() || keys.distinct().size!=keys.size || keys.any { k -> question.options.none { it.key==k } } || question.type=="SINGLE_CHOICE" && keys.size!=1 || answer.value!=null || answer.text!=null) invalid("/answer")
            }
            "TRUE_FALSE" -> if(answer.value==null || answer.optionKeys!=null || answer.text!=null) invalid("/answer")
            "SHORT_ANSWER" -> if(answer.text==null || !hasInput(answer) || answer.text.length>10000 || '\u0000' in answer.text || answer.optionKeys!=null || answer.value!=null) invalid("/answer")
            "FILL_BLANK" -> if(answer.blanks==null || answer.blanks.size!=question.blankCount || answer.blanks.any { it.length>500 || '\u0000' in it } || answer.optionKeys!=null || answer.value!=null || answer.text!=null) invalid("/answer/blanks")
            else -> invalid("/answer/type")
        }
    }
    fun outcome(question: QuestionView,answer: AnswerInput?): String {
        if(answer==null) return "UNANSWERED"
        return when(question.type) {
            "SHORT_ANSWER" -> "SELF_RATED"
            "TRUE_FALSE" -> if(question.correctValue==answer.value) "CORRECT" else "WRONG"
            "FILL_BLANK" -> {
                val match=question.blankMatch ?: qanda.backend.content.BlankMatch()
                fun normalize(value: String): String {
                    val trimmed=if(match.trimWhitespace) value.trim { it in answerWhitespace } else value
                    return if(match.ignoreCase) trimmed.lowercase(java.util.Locale.ROOT) else trimmed
                }
                if(question.blanks!!.mapIndexed { index,blank -> blank.answers.any { normalize(it)==normalize(answer.blanks!![index]) } }.all { it }) "CORRECT" else "WRONG"
            }
            else -> if(question.correctAnswer!!.toSet()==answer.optionKeys!!.toSet()) "CORRECT" else "WRONG"
        }
    }
}
