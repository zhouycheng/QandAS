import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { containsImage } from '@qanda/content-format'

const paths = process.argv.slice(2)
if (!paths.length || paths.length > 20) {
  console.error('用法：npm --prefix apps/admin run validate:bank -- <题库.json> [更多文件]；每批最多 20 个文件')
  process.exitCode = 1
} else {
  const server = await createServer({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), configFile: false, ssr: { external: ['@qanda/content-format'] }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' })
  try {
    const { parseImportFile } = await server.ssrLoadModule('/src/lib/question-bank-file.ts')
    const { countQuestions } = await server.ssrLoadModule('/src/lib/question-content.ts')
    let bytes = 0, total = 0
    for (const filename of paths) {
      try {
        const inputPath = resolve(process.env.INIT_CWD ?? process.cwd(), filename)
        const input = await readFile(inputPath)
        bytes += input.byteLength
        if (bytes > 8 * 1024 * 1024) throw new Error('每批 JSON 文件合计最多 8 MiB')
        const file = parseImportFile(new TextDecoder('utf-8', { fatal: true }).decode(input), 'validation-only')
        const warnImages = questions => questions.forEach(question => {
          if (question.contentFormat === 'MARKDOWN' && [question.stem, question.passage, question.referenceAnswer, question.explanation, ...(question.scoringPoints || []), ...question.options.map(option => option.content)].some(text => containsImage(text))) console.warn(`${filename}：正文图片仅显示说明文字，请通过 assets / assetIds 导入图片附件。`)
          warnImages(question.subQuestions || [])
        })
        warnImages(file.questions)
        const base = await realpath(dirname(inputPath))
        for (const asset of file.document?.assets ?? []) {
          const actual = await realpath(resolve(base, asset.path)).catch(() => { throw new Error(`assets.${asset.id}：缺少图片 ${asset.path}`) })
          if (!actual.startsWith(base + sep)) throw new Error(`assets.${asset.id}：图片必须位于导入包目录内`)
          const info = await stat(actual)
          if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error(`assets.${asset.id}：图片必须是 5 MiB 以内的文件`)
          const data = await readFile(actual)
          const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255
          const webp = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
          if (!(png && /\.png$/i.test(actual) || jpeg && /\.jpe?g$/i.test(actual) || webp && /\.webp$/i.test(actual))) throw new Error(`assets.${asset.id}：扩展名与 PNG、JPEG 或 WebP 文件内容不一致`)
        }
        total += countQuestions(file.questions)
        if (total > 3000) throw new Error('每批最多 3000 道实际作答题，阅读题组按小题计数')
        console.log(`${filename}：通过，${countQuestions(file.questions)} 道作答题，${file.document ? '协议 v1.0' : '简式 JSON'}`)
      } catch (error) { console.error(`${filename}：${error.message}`); process.exitCode = 1 }
    }
    if (!process.exitCode) console.log(`整批通过：${paths.length} 个文件，${total} 道作答题，${bytes} 字节。章节和图片在管理端映射后，由后端执行正式导入校验。`)
  } finally { await server.close() }
}
