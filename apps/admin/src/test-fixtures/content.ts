import { collegeFixtures } from './colleges'
import { majorFixtures } from './majors'
import { questionBankFixtures } from './question-banks'
import { questionFixtures } from './questions'
import { subjectFixtures } from './subjects'
import { userFixtures } from './operations'
export function contentFixture() {
  return structuredClone({ colleges: collegeFixtures, majors: majorFixtures, questionBanks: questionBankFixtures,
    questions: questionFixtures, subjects: subjectFixtures, users: userFixtures })
}
