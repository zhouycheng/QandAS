import { validateTeachingSections } from '@qanda/content-format'
import type { CreateQuestionInput } from '../types/admin'
import { parseQuestionFile } from './content-rules'

export const IMPORT_FORMAT = 'qanda-question-bank'
export const IMPORT_VERSION = '1.0'
export const TEACHING_SECTIONS = ['结论', '核心知识点', '解题过程', '记忆方法', '易错题型']
export interface SourceRef { sourceId: string; location: string }
export interface Provenance {
  origin: 'extracted' | 'authored'
  sourceRefs: SourceRef[]
  ai: { fields: string[]; note: string }
}
export interface PortableQuestion {
  id: string
  chapterId?: string
  provenance: Provenance
  subQuestions?: PortableQuestion[]
  [key: string]: unknown
}
export interface QuestionBankFile {
  format: typeof IMPORT_FORMAT
  version: typeof IMPORT_VERSION
  bank: { name: string; description: string }
  sources: { id: string; name: string; kind: string; uri?: string }[]
  chapters: { id: string; name: string }[]
  assets: { id: string; path: string; sourceRefs: SourceRef[] }[]
  questions: PortableQuestion[]
}
export interface ParsedQuestionFile { questions: CreateQuestionInput[]; document?: QuestionBankFile }

function fail(path: string, message: string): never { throw new Error(`${path}：${message}`) }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '应为对象')
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, names: string[], path: string) {
  const extra = Object.keys(value).find(key => !names.includes(key))
  if (extra) fail(`${path}.${extra}`, '不支持的字段，请检查拼写')
}
function text(value: unknown, path: string, max: number, optional = false): string {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || value.includes('\u0000')) fail(path, `应为${optional ? '' : '非空'}文本，最多 ${max} 字`)
  return value
}
function array(value: unknown, path: string, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min) fail(path, `应为至少 ${min} 项的数组`)
  return value
}
function uniqueId(value: unknown, path: string, ids: Set<string>) {
  const id = text(value, path, 80)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail(path, '标识使用英文字母、数字、点、下划线或短横线')
  if (ids.has(id)) fail(path, `重复标识 ${id}`)
  ids.add(id)
  return id
}
const contentFields = {
  SINGLE_CHOICE: ['options', 'correctAnswer'], MULTIPLE_CHOICE: ['options', 'correctAnswer'],
  TRUE_FALSE: ['correctValue'], FILL_BLANK: ['blanks', 'blankMatch'],
  SHORT_ANSWER: ['referenceAnswer', 'scoringPoints'], READING: ['passage', 'subQuestions'],
}

/** Portable identifiers stay in the preview until the administrator maps chapters and images. */
export function parseImportFile(input: string, bankId: string): ParsedQuestionFile {
  if (new TextEncoder().encode(input).length > 8 * 1024 * 1024) fail('$', '每批请求最多 8 MiB')
  const root: unknown = JSON.parse(input.replace(/^\uFEFF/, ''))
  if (Array.isArray(root) || (root && typeof root === 'object' && !('format' in root) && !('version' in root))) return { questions: parseQuestionFile(input, bankId) }
  const doc = object(root, '$')
  fields(doc, ['format', 'version', 'bank', 'sources', 'chapters', 'assets', 'questions'], '$')
  if (doc.format !== IMPORT_FORMAT) fail('$.format', `应为 ${IMPORT_FORMAT}`)
  if (doc.version !== IMPORT_VERSION) fail('$.version', '支持的协议版本为 1.0')
  const bank = object(doc.bank, '$.bank')
  fields(bank, ['name', 'description'], '$.bank'); text(bank.name, '$.bank.name', 120); text(bank.description, '$.bank.description', 10000, true)
  const sourceIds = new Set<string>(), chapterIds = new Set<string>(), assetIds = new Set<string>(), questionIds = new Set<string>()
  array(doc.sources, '$.sources', 1).forEach((value, index) => {
    const p = `$.sources[${index}]`, source = object(value, p)
    fields(source, ['id', 'name', 'kind', 'uri'], p); uniqueId(source.id, `${p}.id`, sourceIds); text(source.name, `${p}.name`, 500)
    if (!['text', 'pdf', 'word', 'slides', 'spreadsheet', 'image', 'web', 'audio', 'video'].includes(String(source.kind))) fail(`${p}.kind`, '来源类型无效')
    if (source.uri !== undefined) text(source.uri, `${p}.uri`, 2000)
  })
  const refs = (value: unknown, p: string) => array(value, p, 1).forEach((ref, i) => {
    const r = object(ref, `${p}[${i}]`); fields(r, ['sourceId', 'location'], `${p}[${i}]`)
    if (!sourceIds.has(String(r.sourceId))) fail(`${p}[${i}].sourceId`, '引用的来源不存在')
    text(r.location, `${p}[${i}].location`, 1000)
  })
  array(doc.chapters, '$.chapters').forEach((value, index) => {
    const p = `$.chapters[${index}]`, chapter = object(value, p)
    fields(chapter, ['id', 'name'], p); uniqueId(chapter.id, `${p}.id`, chapterIds); text(chapter.name, `${p}.name`, 60)
  })
  const assetPaths = new Set<string>()
  array(doc.assets, '$.assets').forEach((value, index) => {
    const p = `$.assets[${index}]`, asset = object(value, p)
    fields(asset, ['id', 'path', 'sourceRefs'], p); uniqueId(asset.id, `${p}.id`, assetIds)
    const assetPath = text(asset.path, `${p}.path`, 500)
    if (!/^assets\/(?:[\w\u4e00-\u9fff .-]+\/)*[\w\u4e00-\u9fff .-]+\.(png|jpe?g|webp)$/i.test(assetPath) || assetPath.split('/').some(part => part === '..' || part === '.') || assetPaths.has(assetPath)) fail(`${p}.path`, '使用 assets/ 下唯一的 PNG、JPEG 或 WebP 相对路径')
    assetPaths.add(assetPath); refs(asset.sourceRefs, `${p}.sourceRefs`)
  })
  const check = (value: unknown, p: string, child = false): Record<string, unknown> => {
    const q = object(value, p), type = String(q.type) as keyof typeof contentFields
    if (!Object.hasOwn(contentFields, type) || (child && type === 'READING')) fail(`${p}.type`, '题型无效，阅读题组不能嵌套')
    fields(q, ['id', 'type', 'contentFormat', 'presentation', 'codeLanguage', 'stem', 'explanation', 'assetIds', 'provenance', ...(!child ? ['chapterId'] : []), ...contentFields[type]], p)
    uniqueId(q.id, `${p}.id`, questionIds)
    text(q.stem, `${p}.stem`, 10000, type === 'READING')
    if (q.chapterId !== undefined && !chapterIds.has(String(q.chapterId))) fail(`${p}.chapterId`, '引用的文件章节不存在')
    if (q.assetIds !== undefined) array(q.assetIds, `${p}.assetIds`).forEach((id, i) => { if (!assetIds.has(String(id))) fail(`${p}.assetIds[${i}]`, '引用的图片不存在') })
    const provenance = object(q.provenance, `${p}.provenance`)
    fields(provenance, ['origin', 'sourceRefs', 'ai'], `${p}.provenance`)
    if (!['extracted', 'authored'].includes(String(provenance.origin))) fail(`${p}.provenance.origin`, '应为 extracted 或 authored')
    refs(provenance.sourceRefs, `${p}.provenance.sourceRefs`)
    const ai = object(provenance.ai, `${p}.provenance.ai`)
    fields(ai, ['fields', 'note'], `${p}.provenance.ai`)
    const aiFields = array(ai.fields, `${p}.provenance.ai.fields`)
    if (new Set(aiFields).size !== aiFields.length || aiFields.some(field => !['stem', 'explanation', 'options', 'correctAnswer', 'correctValue', 'blanks', 'referenceAnswer', 'scoringPoints', 'passage'].includes(String(field)))) fail(`${p}.provenance.ai.fields`, 'AI 字段无效或重复')
    text(ai.note, `${p}.provenance.ai.note`, 2000, !aiFields.length)
    if (type === 'READING') {
      if (q.explanation !== undefined) text(q.explanation, `${p}.explanation`, 10000, true)
      array(q.subQuestions, `${p}.subQuestions`, 1).forEach((sub, i) => check(sub, `${p}.subQuestions[${i}]`, true))
    } else {
      const explanation = text(q.explanation, `${p}.explanation`, 10000)
      if (aiFields.includes('explanation')) {
        if (!validateTeachingSections(explanation, String(q.contentFormat || 'PLAIN_TEXT'))) fail(`${p}.explanation`, 'AI 教学解析需要五个有内容的独立标题：结论、核心知识点、解题过程、记忆方法、易错题型')
      }
    }
    if (type === 'TRUE_FALSE' && typeof q.correctValue !== 'boolean') fail(`${p}.correctValue`, '判断答案必须是布尔值')
    if (type === 'SINGLE_CHOICE' || type === 'MULTIPLE_CHOICE') {
      array(q.options, `${p}.options`, 2).forEach((value, i) => {
        const option = object(value, `${p}.options[${i}]`)
        fields(option, ['key', 'content'], `${p}.options[${i}]`)
        text(option.key, `${p}.options[${i}].key`, 8); text(option.content, `${p}.options[${i}].content`, 4000)
      })
    }
    if (type === 'FILL_BLANK') {
      const match = object(q.blankMatch, `${p}.blankMatch`)
      fields(match, ['ignoreCase', 'trimWhitespace'], `${p}.blankMatch`)
      array(q.blanks, `${p}.blanks`, 1).forEach((value, i) => {
        const blank = object(value, `${p}.blanks[${i}]`)
        fields(blank, ['answers'], `${p}.blanks[${i}]`)
        const answers = array(blank.answers, `${p}.blanks[${i}].answers`, 1)
        if (new Set(answers).size !== answers.length) fail(`${p}.blanks[${i}].answers`, '可接受答案不能重复')
      })
    }
    // The existing content validator owns answer relationships and all question-type limits.
    try { parseQuestionFile(JSON.stringify([q]), bankId) } catch (error) { fail(p, (error as Error).message.replace(/^第 1 题：/, '')) }
    return q
  }
  array(doc.questions, '$.questions', 1).forEach((q, i) => check(q, `$.questions[${i}]`))
  const questions = parseQuestionFile(input, bankId).map(q => ({ ...q, subQuestions: q.subQuestions?.map(sub => ({ ...sub, id: crypto.randomUUID() })) }))
  return { questions, document: doc as unknown as QuestionBankFile }
}

export function mapImportFile(file: ParsedQuestionFile, chapters: Record<string, string>, assets: Record<string, string>, chapterOverride?: string, preview = false): CreateQuestionInput[] {
  if (!file.document) return file.questions.map(q => ({ ...q, chapterId: chapterOverride ?? q.chapterId }))
  const mapAssets = (ids: string[] = []) => ids.flatMap(id => {
    if (assets[id]) return [assets[id]]
    if (preview) return []
    return fail(`assets.${id}`, '请先选择并上传对应图片')
  })
  return file.questions.map(q => {
    const chapterId = chapterOverride ?? (q.chapterId ? chapters[q.chapterId] : undefined)
    if (q.chapterId && !chapterId && !preview) fail(`chapters.${q.chapterId}`, '请先为文件中的章节选择对应的题库章节')
    return { ...q, chapterId, assetIds: mapAssets(q.assetIds), subQuestions: q.subQuestions?.map(sub => ({ ...sub, assetIds: mapAssets(sub.assetIds) })) }
  })
}
