package qanda.backend.practice

import qanda.backend.content.QuestionView
import qanda.backend.platform.http.invalid

object AnswerValidation {
    private const val answerWhitespace=" \t\n\r\u000B\u000C\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"
    fun hasInput(answer: AnswerInput?): Boolean = answer!=null && (answer.value!=null || !answer.optionKeys.isNullOrEmpty() || answer.text?.any { it !in answerWhitespace }==true || answer.blanks.orEmpty().any { value -> value.any { it !in answerWhitespace } })
    fun validate(question: QuestionView,answer: AnswerInput?) = validate(question.type,question.options.map { it.key },question.blankCount,answer)
    fun validate(type: String,options: List<String>,blankCount: Int,answer: AnswerInput?) {
        if(answer==null) return
        if(type!="FILL_BLANK" && answer.blanks!=null) invalid("/answer/blanks")
        when(type) {
            "SINGLE_CHOICE","MULTIPLE_CHOICE" -> {
                val keys=answer.optionKeys ?: invalid("/answer/optionKeys")
                if(keys.isEmpty() || keys.distinct().size!=keys.size || keys.any { k -> k !in options } || type=="SINGLE_CHOICE" && keys.size!=1 || answer.value!=null || answer.text!=null) invalid("/answer")
            }
            "TRUE_FALSE" -> if(answer.value==null || answer.optionKeys!=null || answer.text!=null) invalid("/answer")
            "SHORT_ANSWER" -> if(answer.text==null || !hasInput(answer) || answer.text.length>10000 || '\u0000' in answer.text || answer.optionKeys!=null || answer.value!=null) invalid("/answer")
            "FILL_BLANK" -> if(answer.blanks==null || answer.blanks.size!=blankCount || answer.blanks.any { it.length>500 || '\u0000' in it } || answer.optionKeys!=null || answer.value!=null || answer.text!=null) invalid("/answer/blanks")
            else -> invalid("/answer/type")
        }
    }
}
