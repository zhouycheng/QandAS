import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { parseImportFile } from '../src/lib/question-bank-file'

const filename = resolve(process.argv[2])
const root = realpathSync(dirname(filename))
const { document } = parseImportFile(readFileSync(filename, 'utf8'), 'validation', true)
if (!document) throw new Error('需要完整的 bank.json')
for (const asset of document.assets) {
  if (!asset.path.startsWith('assets/images/')) throw new Error('图片须位于 assets/images/')
  const file = realpathSync(resolve(root, asset.path))
  if (!file.startsWith(root + sep) || statSync(file).size > 5 * 1024 * 1024) throw new Error('图片位置或大小无效')
  const bytes = readFileSync(file)
  const valid = /\.png$/i.test(file) ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : /\.jpe?g$/i.test(file) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!valid) throw new Error('图片内容与扩展名不符：' + asset.path)
}
console.log('题库内容与图片引用校验通过')
