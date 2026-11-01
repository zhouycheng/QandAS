import type { CreateQuestionInput, QuestionContent } from '../types/admin'

export function questionToWire(input: QuestionContent & Partial<Pick<CreateQuestionInput, 'questionBankId' | 'chapterId' | 'status'>> & { expectedVersion?: number }): Record<string, unknown> {
  const { stem, type, explanation, blanks, blankMatch, referenceAnswer, scoringPoints, assetIds, passage, questionBankId, chapterId, status, expectedVersion, correctAnswer, options, subQuestions } = input
  return {
    stem, type, explanation, blanks, blankMatch, referenceAnswer, scoringPoints, assetIds, passage, questionBankId, chapterId, status, expectedVersion,
    options: input.type === 'TRUE_FALSE' ? [] : options,
    correctAnswer: input.type === 'TRUE_FALSE' ? [] : correctAnswer,
    ...(input.type === 'TRUE_FALSE' ? { correctValue: correctAnswer[0] === 'TRUE' } : {}),
    subQuestions: subQuestions?.map(sub => ({ ...questionToWire(sub), id: sub.id })),
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
