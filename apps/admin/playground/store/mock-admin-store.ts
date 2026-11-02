import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Chapter, College, Major, Question, QuestionBank, Subject } from '../../src/types/admin'
import { getScenarioData, type PlaygroundScenario } from '../scenarios'
import type {
  ActivityRecord,
  ForegroundSession,
  Announcement,
  ManagedUser,
  OperationLog,
  SecuritySettings,
  StoredAdminAccount,
  StudentFeedback,
  UserCourse,
} from '../../src/types/operations'

interface OperationsData {
  chapters: Chapter[]
  feedback: StudentFeedback[]
  userCourses: UserCourse[]
  users: ManagedUser[]
  adminAccounts: StoredAdminAccount[]
  announcements: Announcement[]
  security: SecuritySettings
  activityRecords: ActivityRecord[]
  foregroundSessions: ForegroundSession[]
  operationLogs: OperationLog[]
}

interface MockAdminState extends OperationsData {
  scenario: PlaygroundScenario
  scenarioRevision: number
  colleges: College[]
  majors: Major[]
  subjects: Subject[]
  questionBanks: QuestionBank[]
  questions: Question[]
  setScenario: (scenario: PlaygroundScenario) => void
  setColleges: (colleges: College[]) => void
  setMajors: (majors: Major[]) => void
  setSubjects: (subjects: Subject[]) => void
  setQuestionBanks: (questionBanks: QuestionBank[]) => void
  setQuestions: (questions: Question[]) => void
  setOperations: (patch: Partial<OperationsData>) => void
}

const initialData = getScenarioData('normal')

export const useMockAdminStore = create<MockAdminState>()(
  persist(
    (set) => ({
      scenario: 'normal',
      scenarioRevision: 0,
      ...initialData,
      setScenario: (scenario) =>
        set((state) => ({
          scenario,
          ...getScenarioData(scenario),
          scenarioRevision: state.scenarioRevision + 1,
        })),
      setColleges: (colleges) => set({ colleges }),
      setMajors: (majors) => set({ majors }),
      setSubjects: (subjects) => set({ subjects }),
      setQuestionBanks: (questionBanks) => set({ questionBanks }),
      setQuestions: (questions) => set({ questions }),
      setOperations: (patch) => set(patch),
    }),
    {
      name: 'qanda-admin-playground-v1-contract',
      version: 2,
      migrate: (persisted) => {
        const state = persisted as MockAdminState
        return { ...state, adminAccounts: (state.adminAccounts ?? initialData.adminAccounts).map(account => ({ ...account, role: 'SUPER_ADMIN' as const })) }
      },
    },
  ),
)

export function getMockAdminState() {
  return useMockAdminStore.getState()
}
