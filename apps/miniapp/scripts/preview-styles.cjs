const fs = require('node:fs')
const path = require('node:path')

function readStyles(file, seen = new Set()) {
  const resolved = path.resolve(file)
  if (seen.has(resolved)) return ''
  seen.add(resolved)
  return fs.readFileSync(resolved, 'utf8').replace(/@import\s+["']([^"']+)["'];?/g,
    (_, relative) => readStyles(path.resolve(path.dirname(resolved), relative), seen))
}
module.exports = { readStyles }
