import type { QueryClient } from '@tanstack/react-query'

export function refreshWorkbench(client: QueryClient) {
  for (const key of ['resource-select', 'scope-college', 'scope-major', 'resource-label', 'bank-detail', 'publication-checks', 'questions', 'question-detail', 'chapters', 'dashboard-summary', 'organization-directory', 'question-banks', 'subjects', 'subject-access']) {
    void client.invalidateQueries({ queryKey: [key] })
  }
}
