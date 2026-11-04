// Login preview uses the same theme and form styles as the mini program.
const fs = require('node:fs')
const path = require('node:path')
const { readStyles } = require('./preview-styles.cjs')
const root = path.resolve(__dirname, '../miniprogram')
const out = path.resolve(__dirname, '../.tmp-preview')
const css = ['app.wxss', 'page/login/index.wxss'].map(file => readStyles(path.join(root, file))).join('\n')
  .replace(/^page(?=\s*[,\{])/gm, 'body')
  .replace(/(-?\d+(?:\.\d+)?)rpx/g, (_, value) => `${Number(value) / 2}px`)
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>题小搭登录预览</title><style>
${css}
body { margin: 0; background: white; } .preview { max-width: 430px; margin: auto; } .auth-page { min-height: auto; padding: 24px 16px; } input { outline: none; } .nav { padding: 20px 16px; font-size: var(--font-title); font-weight: 600; }
</style><body><main class="preview"><header class="nav">登录</header><div class="auth-page"><div class="auth-brand-area"><div class="brand-name">题小搭</div></div><div class="login-area"><div class="form login-form"><div class="field"><label class="field-label">邮箱</label><input class="field-input" placeholder="请输入邮箱"></div><div class="field"><label class="field-label">邮箱验证码</label><div class="login-code-row"><input class="field-input" placeholder="请输入6位验证码"><button class="q-button login-code-send">获取验证码</button></div></div></div><div class="agree-row"><span class="agree-text">○ 已阅读并同意 <span class="agree-link">用户协议</span> 和 <span class="agree-link">隐私政策</span></span></div><button class="q-button q-button--primary login-submit">登录 / 注册</button><button class="q-button wechat-btn">微信登录</button></div></div></main></body></html>`
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'auth-preview.html'), html)
console.log('登录预览已生成')
