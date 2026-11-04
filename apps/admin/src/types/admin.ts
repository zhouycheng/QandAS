export type ContentStatus = 'ACTIVE' | 'INACTIVE'
export type AtomicQuestionType = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TRUE_FALSE' | 'FILL_BLANK' | 'SHORT_ANSWER'
export type QuestionType = AtomicQuestionType | 'READING'
export type BankPublicationStatus = 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED' | 'ARCHIVED'
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface PageQuery { page?: number; pageSize?: number }
export interface Versioned { version: number }
export const GRADE_OPTIONS = ['大一', '大二', '大三', '大四', '已毕业'].map((label, index) => ({ label, value: index + 1 }))
export const gradeLabel = (grade?: number) => GRADE_OPTIONS.find(option => option.value === grade)?.label ?? '未填写'
export interface DirectorySummary { collegeCount: number; majorCount: number }
export interface PublicationCheck { label: string; passed: boolean; detail: string }

export interface BankCategory {
  collegeId?: string
  majorId?: string
  grade?: number
}

export interface Chapter extends Versioned {
  id: string
  questionBankId: string
  name: string
  sortOrder: number
  questionCount?: number
}

export interface College extends Versioned {
  id: string
  name: string
  code: string
  status: ContentStatus
  createdAt: string
  updatedAt: string
}

export interface Major extends Versioned {
  id: string
  collegeId: string
  name: string
  code: string
  status: ContentStatus
  createdAt: string
  updatedAt: string
}

export interface Subject extends Versioned {
  id: string
  name: string
  status: ContentStatus
  createdAt: string
  updatedAt: string
}

export interface QuestionBank extends Versioned {
  id: string
  subjectId: string
  name: string
  description: string
  status: ContentStatus
  questionCount: number
  activeQuestionCount?: number
  textbook: string
  maintainerIds: string[]
  contentVersion: number
  publicationStatus: BankPublicationStatus
  categories: BankCategory[]
  createdAt: string
  updatedAt: string
}

export interface QuestionOption {
  key: string
  content: string
}

export interface AtomicQuestionContent {
  contentFormat?: 'PLAIN_TEXT' | 'MARKDOWN'
  presentation?: 'STANDARD' | 'CONCEPT' | 'CODE_ANALYSIS' | 'CODE_WRITING'
  codeLanguage?: string | null
  stem: string
  type: AtomicQuestionType
  options: QuestionOption[]
  correctAnswer: string[]
  explanation: string
  blanks?: { answers: string[] }[]
  blankMatch?: { ignoreCase: boolean; trimWhitespace: boolean }
  referenceAnswer?: string
  scoringPoints?: string[]
  assetIds?: string[]
}

export interface ReadingSubQuestion extends AtomicQuestionContent {
  id: string
}

export interface QuestionContent extends Omit<AtomicQuestionContent, 'type'> {
  type: QuestionType
  passage?: string
  subQuestions?: ReadingSubQuestion[]
}

export interface Question extends QuestionContent, Versioned {
  id: string
  questionBankId: string
  chapterId?: string
  revision?: number
  revisionId?: string
  status: ContentStatus
  createdAt: string
  updatedAt: string
}

export type CreateSubjectInput = Pick<Subject, 'name' | 'status'>
export type UpdateSubjectInput = CreateSubjectInput & { expectedVersion: number }
export type CreateCollegeInput = Pick<College, 'name' | 'code' | 'status'>
export type UpdateCollegeInput = CreateCollegeInput & { expectedVersion: number }
export type CreateMajorInput = Pick<Major, 'collegeId' | 'name' | 'code' | 'status'>
export type UpdateMajorInput = CreateMajorInput & { expectedVersion: number }

export type CreateQuestionBankInput = Pick<QuestionBank, 'subjectId' | 'name' | 'description' | 'status'> &
  Partial<Pick<QuestionBank, 'textbook' | 'maintainerIds' | 'categories'>>
export type UpdateQuestionBankInput = CreateQuestionBankInput & { expectedVersion: number }

export type CreateQuestionInput = QuestionContent & Pick<Question, 'questionBankId' | 'chapterId' | 'status'>
export type UpdateQuestionInput = CreateQuestionInput & { expectedVersion: number }

export interface SubjectQuery extends PageQuery {
  keyword?: string
}

export interface CollegeQuery extends PageQuery {
  keyword?: string
  status?: ContentStatus
}

export interface MajorQuery extends CollegeQuery {
  keyword?: string
  collegeId?: string
}

export interface QuestionBankQuery extends PageQuery {
  keyword?: string
  subjectId?: string
  publicationStatus?: BankPublicationStatus
}

export interface QuestionQuery extends PageQuery {
  keyword?: string
  questionBankId?: string
  chapterId?: string
  unassigned?: boolean
  type?: QuestionType
  status?: ContentStatus
}

export interface DashboardSummary {
  collegeCount: number
  subjectCount: number
  questionBankCount: number
  questionCount: number
  userCount: number
  answeredCount: number
  publishedBankCount: number
  draftBankCount: number
  pendingFeedbackCount: number
  pendingCourseRequestCount: number
  missingExplanationCount: number
  unassignedQuestionCount: number
  emptyBankCount: number
}
