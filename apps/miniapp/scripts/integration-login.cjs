const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const project = path.resolve(__dirname, '..')
const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/qanda/integration/environment.json'), 'utf8'))

function tool(name, args) {
  const result = spawnSync('wechatide', ['-c', 'Codex', name, '--project', project, ...args], { encoding: 'utf8', timeout: 30000 })
  if (result.error || result.status !== 0) throw new Error(`${name} 执行失败`)
  const body = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
  if (!body.ok || body.result?.success === false || body.result?.taskId) throw new Error(`${name} 尚未完成`)
  return body.result
}
try {
  tool('automation_navigate', ['--action', 'reLaunch', '--url', '/page/login/index'])
  tool('automation_element_action', ['--action', 'input', '--selector', 'input[placeholder="请输入邮箱"]', '--value', config.student.email, '--wait-for-selector', '.login-submit'])
  tool('automation_element_action', ['--action', 'input', '--selector', 'input[placeholder="请输入密码"]', '--value', config.student.password])
  const state = tool('automation_page_action', ['--action', 'getData', '--data-path', 'agreed'])
  if (state.data !== true) tool('automation_element_action', ['--action', 'tap', '--selector', '.agree-left'])
  tool('automation_element_action', ['--action', 'tap', '--selector', '.login-submit'])
  const current = tool('automation_runtime_info', ['--action', 'currentPage'])
  console.log(JSON.stringify({ currentPage: current.currentPage?.path }))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
