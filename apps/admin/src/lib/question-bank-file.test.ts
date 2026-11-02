import { describe, expect, it } from 'vitest'
import { mapImportFile, parseImportFile } from './question-bank-file'
import { countQuestions } from './question-content'
import { importBody, questionFromWire, questionToWire } from '../gateways/question-wire'
import example from '../../../../docs/question-bank-import/examples/six-types.json'
import { matchImportChapters, prepareImportIntent } from './import-intent'

const document = () => structuredClone(example)
const parse = (value: unknown) => parseImportFile(JSON.stringify(value), 'target-bank')

describe('portable question bank v1.0', () => {
  it('keeps one write intent across retries and renews it when the content version changes', () => {
    const file = { ...parse(document()), chapterMap: { basics: 'chapter-uuid' }, assetMap: {} }
    const first = prepareImportIntent([file], 'target-bank', 1, undefined)
    first.previewed = true
    expect(prepareImportIntent([file], 'target-bank', 1, undefined, first)).toBe(first)
    const changed = prepareImportIntent([file], 'target-bank', 2, undefined, first)
    expect(changed.previewed).toBe(false)
    expect(changed.input.idempotencyKey).not.toBe(first.input.idempotencyKey)
  })
  it('maps only chapter names with a unique match', () => {
    const parsed = parse(document())
    const name = parsed.document!.chapters[0].name
    const chapters = [{ id: 'one', name }, { id: 'two', name }] as Parameters<typeof matchImportChapters>[1]
    expect(matchImportChapters(parsed, chapters)).toEqual({})
    expect(matchImportChapters(parsed, chapters.slice(0, 1))).toEqual({ [parsed.document!.chapters[0].id]: 'one' })
  })
  it('writes a loaded question status without response-only null fields', () => {
    const [question] = parse(document()).questions
    const loaded = questionFromWire({ ...question, blankMatch: null, passage: null, referenceAnswer: null } as unknown as typeof question)
    const wire = questionToWire({ ...loaded, status: 'INACTIVE', expectedVersion: 1 })
    expect(wire.status).toBe('INACTIVE')
    expect(wire).not.toHaveProperty('blankMatch')
    expect(wire).not.toHaveProperty('referenceAnswer')
    expect(wire).not.toHaveProperty('passage')
  })
  it('normalizes all six types and maps local chapters once before writing', () => {
    const parsed = parse(document())
    expect(countQuestions(parsed.questions)).toBe(7)
    expect(parsed.questions[2].correctAnswer).toEqual(['TRUE'])
    expect(parsed.questions[5].subQuestions![0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(() => mapImportFile(parsed, {}, {})).toThrow('chapters.basics')
    const mapped = mapImportFile(parsed, { basics: 'chapter-uuid' }, {})
    expect(mapped.every(q => q.chapterId === 'chapter-uuid')).toBe(true)
    expect(mapImportFile(parsed, { basics: 'chapter-uuid' }, {})).toEqual(mapped)
    const wire = importBody({ questions: mapped, expectedContentVersion: 7 })
    expect(wire.questions[2].correctValue).toBe(true)
    expect(JSON.stringify(wire)).not.toContain('provenance')
    expect(JSON.stringify(wire)).not.toContain('notes')
  })
  it('requires images and maps parent and reading child attachments without leaking local IDs', () => {
    const doc = document() as unknown as Record<string, any>
    doc.assets = [{ id: 'figure', path: 'assets/diagram.png', sourceRefs: [{ sourceId: 'notes', location: '图 1' }] }]
    doc.questions[0].assetIds = ['figure']; doc.questions[5].subQuestions[0].assetIds = ['figure']
    const parsed = parse(doc)
    expect(() => mapImportFile(parsed, {}, {}, 'chapter')).toThrow('assets.figure')
    expect(mapImportFile(parsed, {}, {}, 'chapter', true)[0].assetIds).toEqual([])
    const mapped = mapImportFile(parsed, {}, { figure: 'uploaded-image' }, 'chapter')
    expect(mapped[0].assetIds).toEqual(['uploaded-image'])
    expect(mapped[5].subQuestions![0].assetIds).toEqual(['uploaded-image'])
    doc.assets[0].path = 'assets/../secret.png'
    expect(() => parse(doc)).toThrow('$.assets[0].path')
  })
  it.each([
    ['version', (d: any) => { d.version = '2.0' }, '$.version'],
    ['duplicate', (d: any) => { d.questions[1].id = d.questions[0].id }, '$.questions[1].id'],
    ['child duplicate', (d: any) => { d.questions[5].subQuestions[0].id = d.questions[0].id }, '$.questions[5].subQuestions[0].id'],
    ['source', (d: any) => { d.questions[0].provenance.sourceRefs[0].sourceId = 'missing' }, '.sourceId'],
    ['chapter', (d: any) => { d.questions[0].chapterId = 'missing' }, '.chapterId'],
    ['asset', (d: any) => { d.questions[0].assetIds = ['missing'] }, '.assetIds[0]'],
    ['boolean', (d: any) => { d.questions[2].correctValue = 'true' }, '.correctValue'],
    ['option type', (d: any) => { d.questions[0].options[0].content = 2 }, '.options[0].content'],
    ['answer', (d: any) => { d.questions[0].correctAnswer = ['Z'] }, '正确答案'],
    ['blank marker', (d: any) => { d.questions[3].stem = '{{2}}' }, '空位标记'],
    ['AI explanation', (d: any) => { d.questions[0].explanation = '答案 A' }, '.explanation'],
    ['nested reading', (d: any) => { d.questions[5].subQuestions[0] = structuredClone(d.questions[5]) }, '.subQuestions[0].type'],
    ['typo', (d: any) => { d.questions[0].explnation = 'typo' }, '.explnation'],
  ])('locates invalid %s', (_name, mutate, error) => {
    const doc = document(); mutate(doc); expect(() => parse(doc)).toThrow(error)
  })
  it('enforces 3000 actual items and the byte boundary while retaining simple input', () => {
    const doc = document()
    doc.questions = Array.from({ length: 3000 }, (_, i) => ({ ...doc.questions[2], id: `q${i}` }))
    expect(parse(doc).questions).toHaveLength(3000)
    doc.questions.push({ ...doc.questions[0], id: 'q3000' })
    expect(() => parse(doc)).toThrow('3000')
    expect(() => parseImportFile(' '.repeat(8 * 1024 * 1024 + 1), 'bank')).toThrow('8 MiB')
    expect(parse([{ type: 'judge', stem: '测试', correctValue: false, explanation: '解析' }]).questions[0].correctAnswer).toEqual(['FALSE'])
  })
})
