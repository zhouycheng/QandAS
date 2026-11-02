import type { CreateQuestionInput, QuestionContent } from '../types/admin'

export function questionToWire(input: QuestionContent & Partial<Pick<CreateQuestionInput, 'questionBankId' | 'chapterId' | 'status'>> & { expectedVersion?: number }): Record<string, unknown> {
  const { contentFormat, presentation, codeLanguage, stem, type, explanation, blanks, blankMatch, referenceAnswer, scoringPoints, assetIds, passage, questionBankId, chapterId, status, expectedVersion, correctAnswer, options, subQuestions } = input
  return {
    contentFormat, presentation, codeLanguage, stem, type, explanation, assetIds, questionBankId, chapterId, status, expectedVersion,
    options: ['SINGLE_CHOICE', 'MULTIPLE_CHOICE'].includes(type) ? options : [],
    correctAnswer: ['SINGLE_CHOICE', 'MULTIPLE_CHOICE'].includes(type) ? correctAnswer : [],
    ...(type === 'TRUE_FALSE' ? { correctValue: correctAnswer[0] === 'TRUE' } : {}),
    ...(type === 'FILL_BLANK' ? { blanks, blankMatch: blankMatch ?? { ignoreCase: true, trimWhitespace: true } } : {}),
    ...(type === 'SHORT_ANSWER' ? { referenceAnswer, scoringPoints: scoringPoints ?? [] } : {}),
    ...(type === 'READING' ? { passage, subQuestions: subQuestions?.map(sub => ({ ...questionToWire(sub), id: sub.id })) } : {}),
  }
}
export function questionFromWire<T extends QuestionContent & { correctValue?: boolean }>(value: T): T {
  return {
    ...value,
    options: value.type === 'TRUE_FALSE' ? [{ key: 'TRUE', content: '正确' }, { key: 'FALSE', content: '错误' }] : value.options ?? [],
    correctAnswer: value.type === 'TRUE_FALSE' ? [value.correctValue ? 'TRUE' : 'FALSE'] : value.correctAnswer ?? [],
    explanation: value.explanation ?? '',
    subQuestions: value.subQuestions?.map(sub => questionFromWire(sub)),
  }
}
export function importBody(input: { questions: CreateQuestionInput[]; expectedContentVersion: number }) {
  return { questions: input.questions.map(questionToWire), expectedContentVersion: input.expectedContentVersion }
}
