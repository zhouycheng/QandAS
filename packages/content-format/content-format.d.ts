export interface ContentNode { text?: string; tag?: string; children?: ContentNode[]; token?: string; language?: string; raw?: string; href?: string; start?: number; blankIndex?: number }
export function parseContent(source: string, format?: string): ContentNode[]
export function parseBlankContent(source: string, format?: string): ContentNode[]
export function plainText(nodes: ContentNode[]): string
export function codeTokens(source: string, language: string): ContentNode[]
export function containsImage(source: string): boolean
export function validateTeachingSections(source: string, format?: string): boolean
export function blankMarkers(source: string): string[]
export function contentMetadata(input: { type: string; contentFormat?: string; presentation?: string; codeLanguage?: string | null }): { contentFormat: 'PLAIN_TEXT' | 'MARKDOWN'; presentation: 'STANDARD' | 'CONCEPT' | 'CODE_ANALYSIS'; codeLanguage: null }
export const TEACHING_SECTIONS: string[]
export const LANGUAGES: string[]
