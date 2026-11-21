import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const root = new URL('../../../', import.meta.url)
const requireShared = createRequire(new URL('packages/content-format/package.json', root))
const { build } = requireShared('esbuild')
const validator = await build({
  entryPoints: [fileURLToPath(new URL('skill-validator.ts', import.meta.url))],
  write: false, bundle: true, platform: 'node', format: 'cjs', target: 'node20',
})
const author = 'qanda-question-bank'
const operator = 'qanda-question-bank-mcp'
const files = {}
for (const name of [author, operator, 'qanda-system-admin-mcp']) {
  files[name + '/SKILL.md'] = await readFile(new URL('.agents/skills/' + name + '/SKILL.md', root))
}
async function includeDirectory(prefix) {
  const directory = new URL('.agents/skills/' + prefix + '/', root)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + '/' + entry.name
    if (entry.isDirectory()) await includeDirectory(path)
    else if (entry.isFile() && !entry.name.startsWith('.')) files[path] = await readFile(new URL(entry.name, directory))
  }
}
files[author + '/references/content.md'] = await readFile(new URL('.agents/skills/' + author + '/references/content.md', root))
files[author + '/references/explanations.md'] = await readFile(new URL('.agents/skills/' + author + '/references/explanations.md', root))
await includeDirectory(author + '/references/writing')
await includeDirectory(operator + '/references')
for (const name of ['schema.json', 'examples/six-types.json']) {
  files[author + '/' + name] = await readFile(new URL('docs/question-bank-import/' + name, root))
}
files[author + '/scripts/validate.cjs'] = validator.outputFiles[0].contents
const output = new URL('apps/admin/public/', root)
await mkdir(output, { recursive: true })
await writeFile(new URL('qanda-bank-skills.zip', output), zipSync(files, { mtime: new Date(2000, 0, 1) }))
