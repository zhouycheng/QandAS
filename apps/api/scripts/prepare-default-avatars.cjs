const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const apiRoot = path.resolve(__dirname, '..')
const sources = [
  ['happy-purple', '开心闪光紫底'],
  ['love-pink', '爱心眼粉底'],
  ['cool-yellow', '墨镜酷黄底'],
  ['sleep-blue', '晚安睡帽蓝底'],
  ['glasses-orange', '圆框眼镜橙底'],
  ['wink-teal', '眨眼星光青底']
]
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qanda-avatars-'))
try {
  const avatars = sources.map(([id, name]) => {
    const output = path.join(temporary, id + '.jpg')
    execFileSync('sips', ['-z', '160', '160', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85',
      path.resolve(apiRoot, '../miniapp/design/app-logo', '题搭Logo ' + name + '.png'), '--out', output], { stdio: 'pipe' })
    const bytes = fs.readFileSync(output)
    assert(bytes.length > 0 && bytes.length <= 65536, name + ' 超过头像大小限制')
    assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8', name + ' 必须为 JPEG')
    return { id, name, avatarUrl: 'data:image/jpeg;base64,' + bytes.toString('base64') }
  })
  const json = JSON.stringify(avatars, null, 2) + '\n'
  fs.writeFileSync(path.join(apiRoot, 'src/main/resources/default-avatars.json'), json)
  console.log('已生成六款注册默认头像：160×160 JPEG，清单共 ' + Buffer.byteLength(json) + ' 字节')
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
