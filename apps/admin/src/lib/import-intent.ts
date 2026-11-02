import { importBody } from '../gateways/question-wire'
import type { Chapter } from '../types/admin'
import type { ImportQuestionsInput } from '../types/operations'
import { mapImportFile, type ParsedQuestionFile } from './question-bank-file'

export interface MappedImportFile extends ParsedQuestionFile {
  chapterMap: Record<string, string>
  assetMap: Record<string, string>
}
export interface ImportIntent { body: string; input: ImportQuestionsInput; previewed: boolean }

export function matchImportChapters(file: ParsedQuestionFile, chapters: Chapter[]) {
  return Object.fromEntries((file.document?.chapters ?? []).flatMap(local => {
    const matches = chapters.filter(chapter => chapter.name === local.name)
    return matches.length === 1 ? [[local.id, matches[0].id]] : []
  }))
}

export function prepareImportIntent(files: MappedImportFile[], bankId: string, version: number, chapterId: string | undefined, previous?: ImportIntent): ImportIntent {
  const request: ImportQuestionsInput = { questionBankId: bankId, questions: files.flatMap(file => mapImportFile(file, file.chapterMap, file.assetMap, chapterId)), expectedContentVersion: version, idempotencyKey: '' }
  const body = JSON.stringify(importBody(request))
  if (new TextEncoder().encode(body).length > 8 * 1024 * 1024) throw new Error('每批请求最多 8 MiB，请移除部分文件。')
  return previous?.body === body ? previous : { body, input: { ...request, idempotencyKey: crypto.randomUUID() }, previewed: false }
}
