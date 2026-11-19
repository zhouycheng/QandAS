import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import './build-bank-skills.mjs'

const inputs = process.argv.slice(2)
if (!inputs.length) throw new Error('请提供 bank.json 路径')
const zip = unzipSync(await readFile(new URL('../public/qanda-bank-skills.zip', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'qanda-validator-'))
try {
  const validator = join(dir, 'validate.cjs')
  await writeFile(validator, zip['qanda-question-bank/scripts/validate.cjs'])
  for (const input of inputs) execFileSync(process.execPath, [validator, resolve(process.env.INIT_CWD || process.cwd(), input)], { stdio: 'inherit' })
} finally {
  await rm(dir, { recursive: true, force: true })
}
