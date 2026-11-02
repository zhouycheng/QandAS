/**
 * 答题页静态预览：跑真实 PracticeViewModel 拿数据，按真实 WXSS 渲染 402x874 画板。
 *   node scripts/preview-practice.cjs
 * 输出 .tmp-preview/practice-preview.png
 *
 * 并排展示答题、答题卡、结果、长标题与八种题型的布局编辑。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const OUT_DIR = path.join(ROOT, '.tmp-preview')
const STAGE_W = 402
const STAGE_H = 874

const read = (relative) => fs.readFileSync(path.join(MP, relative), 'utf8')

function rpxToPx(css) {
  return css.replace(/(-?\d+(?:\.\d+)?)rpx/g, (_, value) => `${(Number(value) * STAGE_W) / 750}px`)
}

// ---------- 真实数据 ----------

const { PracticeViewModel } = require(path.join(MP, 'viewmodels/practice-viewmodel.js'))
const { PracticeLayoutViewModel } = require(path.join(MP, 'viewmodels/practice-layout-viewmodel.js'))
const { LABELS } = require(path.join(MP, 'utils/practice-layout.js'))
const { getInitialHomeHeaderData } = require(path.join(MP, 'utils/home-header.js'))
const headerLayout = getInitialHomeHeaderData({ statusBarHeight: 44, windowWidth: STAGE_W }, { top: 50, height: 32, left: STAGE_W - 95 })
const escapeHtml = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

const { contentBlocks } = require(path.join(MP, 'utils/rich-content.js'))
function richContent(text, format, language, blanks) {
  const { blocks, links } = contentBlocks(text, format, language, blanks)
  const htmlNodes = nodes => nodes.map(node => node.type === 'text' ? escapeHtml(node.text) : `<${node.name} ${Object.entries(node.attrs || {}).map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(' ')}>${htmlNodes(node.children || [])}</${node.name}>`).join('')
  const renderParts = parts => parts.map(part => part.blankIndex !== undefined ? `<input class="rich-blank" value="${escapeHtml(part.value)}" aria-label="填写空白处" readonly>` : `<span class="rich-inline">${htmlNodes(part.nodes)}</span>`).join('')
  return '<div class="rich-content">' + blocks.map(block => {
    const body = htmlNodes(block.nodes)
    if (block.tag === 'pre') return `<div class="rich-code"><div class="code-bar"><span>${escapeHtml(block.language)}</span><button>复制</button></div><div class="code-scroll" style="overflow-x:auto">${body}</div></div>`
    if (block.rows) return `<div class="table-scroll" style="overflow-x:auto"><div class="rich-fill-table">${block.rows.map(row => `<div class="rich-fill-row">${row.cells.map(cell => `<div class="rich-fill-cell ${cell.header ? 'rich-fill-heading' : ''}">${renderParts(cell.parts)}</div>`).join('')}</div>`).join('')}</div></div>`
    if (block.tag === 'table') return `<div class="table-scroll" style="overflow-x:auto">${body}</div>`
    if (block.parts) return '<div class="rich-fill-line">' + renderParts(block.parts) + '</div>'
    return body
  }).join('') + links.map(link => `<div class="rich-link">复制链接：${escapeHtml(link)}</div>`).join('') + '</div>'
}

function createStorage() {
  const store = {}

  return {
    get: (key) => (store[key] === undefined ? '' : store[key]),
    set: (key, value) => {
      store[key] = value
    },
    keys: () => Object.keys(store),
    remove: (key) => {
      delete store[key]
    }
  }
}

/** elapsedMinutes：把开始时刻往前推，让预览里的用时不是 0:00（设计稿是 20:22） */
function createSession(elapsedMinutes) {
  const vm = new PracticeViewModel({ storage: createStorage() })
  vm.load({ subjectId: 'subject-chinese', bankId: 'chinese-ch001', mode: 'order' })

  if (elapsedMinutes) {
    vm.session.startedAt = Date.now() - elapsedMinutes * 60 * 1000
  }

  return vm
}

// ① 练习模式态：还没作答，选项全露、无解析（设计稿面板 1）
const freshVm = createSession(20)
const freshData = freshVm.session.getViewData()

// ② 即时模式态：故意答错并打开解析，顺带把收藏 / 标记两个 pill 的选中态一起渲染出来
//    注意 getViewData 里的 isCorrectOption 在未作答时一律 false，靠题目自带的 answerKeys 反查
const wrongVm = createSession(20)
const wrongKeys = wrongVm.session.state.questions[0].answerKeys || []
const wrongAnswerIndex = wrongVm.session
  .getViewData()
  .currentQuestion.options.findIndex((option) => wrongKeys.indexOf(option.key) < 0)
wrongVm.selectOption(wrongAnswerIndex >= 0 ? wrongAnswerIndex : 0)
wrongVm.session.toggleFavoriteQuestion()
wrongVm.session.toggleMarkQuestion()
const wrongData = wrongVm.session.getViewData()

/** 把整份题库答完；markFirst 给第一题打标记，wrongEvery 每 N 题故意答错一题 */
function answerAll(markFirst, wrongEvery) {
  const vm = createSession(20)

  vm.session.state.questions.forEach((question, index) => {
    const view = vm.session.getViewData().currentQuestion
    const rightIndex = view.options.findIndex((option) => question.answerKeys.indexOf(option.key) >= 0)
    const wrongIndex = view.options.findIndex((option) => question.answerKeys.indexOf(option.key) < 0)
    const shouldWrong = !!wrongEvery && (index + 1) % wrongEvery === 0
    const pick = shouldWrong && wrongIndex >= 0 ? wrongIndex : rightIndex

    vm.selectOption(pick >= 0 ? pick : 0)
    if (markFirst && index === 0) {
      vm.session.toggleMarkQuestion()
    }
    vm.goNext()
  })

  return vm
}

// ④ 答题卡·还有未答：答掉 7 题留 1 题未答，第 1 题打标记
const sheetVm = createSession(20)
const sheetTotal = sheetVm.session.getViewData().total

for (let i = 0; i < Math.min(7, sheetTotal); i += 1) {
  const view = sheetVm.session.getViewData().currentQuestion
  const answerIndex = view.options.findIndex((option) => option.key === (view.answerKeys || [])[0])

  sheetVm.selectOption(answerIndex >= 0 ? answerIndex : 0)
  if (i === 0) {
    sheetVm.session.toggleMarkQuestion()
  }
  sheetVm.goNext()
}

sheetVm.session.jumpToQuestion(6)
const sheetData = sheetVm.session.getViewData()
const sheetItems = sheetVm.session.getOverviewItems(sheetData.answers, 6)

// ⑤ 答题卡·已答完但还有标记（设计稿面板 4）
const markedDoneVm = answerAll(true)
const markedDoneData = markedDoneVm.session.getViewData()
const markedDoneItems = markedDoneVm.session.getOverviewItems(markedDoneData.answers, -1)

// ⑥ 答题卡·已答完且无标记（设计稿面板 5）
const plainDoneVm = answerAll(false)
const plainDoneData = plainDoneVm.session.getViewData()
const plainDoneItems = plainDoneVm.session.getOverviewItems(plainDoneData.answers, -1)

// ⑦ 结果页：全部答完交卷（第一题打标记、每 5 题错一题，让明细网格两种颜色都出现）
const resultVm = answerAll(true, 5)
resultVm.forceSubmit()
const resultData = resultVm.session.getViewData()

// ---------- 渲染 ----------

const PREVIEW_BASE = `
.stage { height: ${STAGE_H}px; display: flex; flex-direction: column; position: relative; }
.stage .page.practice-page { flex: 1; min-height: 0; height: auto; }
/* 弹层的 position:fixed 在预览里要相对画板，否则会跑出 .stage */
.stage .overview { position: absolute; }
.stage .pra-body { overflow-y: auto; }
page-header { display: block; flex: none; }
.preview-status { position: absolute; top: 0; left: 16px; right: 16px; height: 44px; display: flex; align-items: center; justify-content: space-between; font: 12px/1 -apple-system, sans-serif; z-index: 80; pointer-events: none; }
.preview-capsule { position: absolute; top: 50px; right: 8px; height: 32px; width: 87px; box-sizing: border-box; border: 1px solid #dedee2; border-radius: 18px; display: flex; align-items: center; justify-content: space-evenly; font: 18px/1 -apple-system, sans-serif; z-index: 80; pointer-events: none; }
`

function buildCss() {
  const app = read('app.wxss').replace(/^page(?=\s*[,\{])/gm, 'body')
  const page = read('styles/practice.wxss') + read('page/practice-layout/index.wxss').replace(/@import[^;]+;/g, '')
  const sheet = read('components/question-overview-sheet/index.wxss')

  return rpxToPx(`
body { margin: 0; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", Arial, sans-serif; }
.stage { width: ${STAGE_W}px; background: #fff; overflow: hidden; }
${app}
${page}
${sheet}
${read('components/page-header/index.wxss')}
${read('components/rich-content/index.wxss')}
${PREVIEW_BASE}
`)
}

/** 固定标题和进度。 */
function head(data) {
  const title = data.isCompleted ? '练习结果' : data.practiceTitle
  const subtitle = data.isCompleted ? `${data.practiceTitle} · ${data.practiceSubtitle}` : data.practiceSubtitle
  return `
  <page-header><div class="nav-header" style="padding-top: ${headerLayout.homeStatusBarHeight}px">
    <div class="nav-bar" style="height: ${headerLayout.homeNavigationBarHeight}px; padding-right: ${headerLayout.homeNavigationRight}px">
      <div class="nav-back"><div class="nav-back-icon"></div></div>
      <div class="nav-caption">
        <span class="nav-title">${escapeHtml(title)}</span>
        <span class="nav-subtitle">${escapeHtml(subtitle)}</span>
      </div>
    </div>
  </div></page-header>
  ${data.isCompleted ? '' : `<div class="pra-progress"><div class="pra-progress-fill" style="width: ${data.progressPercent}%"></div></div>`}`
}

function questionInfo(data) {
  return `
  <div class="pra-meta">
    <span class="pra-meta-index">${data.currentNumber}/${data.total}</span>
    <span class="pra-meta-type">${data.currentQuestion.typeText}</span>
    <span class="pra-meta-timer">${data.elapsedText}</span>
  </div>`
}

function optionList(data) {
  return data.currentQuestion.options
    .map((option) => `
      <div class="pra-option ${option.selected ? 'is-selected' : ''} ${option.isCorrectOption ? 'is-correct' : ''} ${option.isWrongOption ? 'is-wrong' : ''}">
        <span class="pra-option-key">${option.label}</span>
        <div class="pra-option-text">${richContent(option.text, data.currentQuestion.contentFormat)}</div>
      </div>`)
    .join('')
}

function analysis(data, explanationOpen) {
  return `
  <div class="pra-analysis">
    <div class="pra-analysis-head">
      <span class="pra-result-tag ${data.isCurrentAnswerCorrect ? 'ok' : 'no'}">${data.isViewMode ? '参考内容' : data.currentQuestion.isShortAnswer ? '不计分' : data.isCurrentAnswerCorrect ? '答对啦' : '答错了'}</span>
      <div class="pra-analysis-answer">${richContent(data.currentCorrectAnswerText, data.currentQuestion.isShortAnswer ? data.currentQuestion.contentFormat : 'PLAIN_TEXT')}</div>
    </div>
    <div class="pra-explanation ${explanationOpen ? 'is-open' : ''}">
      <span class="pra-side-title">解析</span>
      <div class="pra-explanation-text">${richContent(data.currentExplanation, data.currentQuestion.contentFormat)}</div>
      <div class="pra-explanation-toggle">${explanationOpen ? '收起解析' : '展开全部解析'}</div>
    </div>
  </div>`
}

function tools(data) {
  return `
  <div class="pra-tools">
    <div class="pra-tool ${data.isCurrentQuestionFavorite ? 'on' : ''}">
      <div class="pra-tool-icon icon-star ${data.isCurrentQuestionFavorite ? 'on' : ''}"></div>
      <span class="pra-tool-text">收藏</span>
    </div>
    <div class="pra-tool">
      <div class="pra-tool-icon icon-grid"></div>
      <span class="pra-tool-text">答题卡</span>
    </div>
    <div class="pra-tool ${data.isCurrentQuestionMarked ? 'marked' : ''}">
      <div class="pra-tool-icon icon-pen ${data.isCurrentQuestionMarked ? 'on' : ''}"></div>
      <span class="pra-tool-text">${data.isCurrentQuestionMarked ? '已标记' : '标记'}</span>
    </div>
  </div>`
}

function footer(data) {
  return `
  <div class="pra-footer">
    <div class="pra-actions">
      <div class="pra-btn ${data.currentIndex === 0 ? 'is-disabled' : ''}">上一题</div>
      <div class="pra-btn primary">${data.primaryActionText}</div>
    </div>
  </div>`
}

function questionStage(data, explanationOpen) {
  // 未作答时不能渲染解析区（wxml 里是 wx:if="{{shouldRevealAnswer}}"），
  // 否则预览会摆出一个「未答却写着答错了」的假状态
  return `
  <div class="page practice-page ${data.editLayout ? 'layout-editor' : ''} font-${data.preferences.fontSize}">
    ${head(data)}
    <div class="pra-body">
      ${content(data, explanationOpen)}
      <div class="pra-body-pad"></div>
      ${data.editLayout ? '<div class="layout-reset">恢复默认布局</div>' : ''}
    </div>
    ${footer(data)}
  </div>`
}

function content(data, explanationOpen) {
  const question = data.currentQuestion
  const response = question.isShortAnswer
    ? `<textarea disabled>${escapeHtml(data.answerText)}</textarea>`
    : question.isFillBlank ? '' : `<div class="pra-options">${optionList(data)}</div>`
  const material = question.material ? `<div class="pra-material"><span class="pra-side-title">阅读材料</span>${richContent(question.material.passage, question.material.contentFormat)}</div>` : ''
  const modules = { info: questionInfo(data), stem: `${material}<div class="pra-stem">${richContent(question.stem, question.contentFormat, undefined, question.isFillBlank ? data.blankInputs : undefined)}</div>`, response, analysis: data.shouldRevealAnswer ? analysis(data, explanationOpen) : '', tools: tools(data) }
  return '<div class="pra-content">' + Object.keys(modules).filter(id => id !== 'response' || !question.isFillBlank).map(id => `<div class="pra-module ${data.editLayout ? 'layout-module' : ''}" style="order:${data.layoutRanks[id]}">${data.editLayout ? `<div class="layout-handle" aria-label="拖动${LABELS[id]}调整顺序"><div class="layout-grip" aria-hidden="true"></div></div>` : ''}${modules[id]}</div>`).join('') + '</div>'
}

function sheetStage(data, items) {
  const cells = items
    .map((item) => `
      <div class="cell ${item.isCurrent ? 'cell-current' : ''} ${item.answered ? 'cell-answered' : 'cell-pending'}">
        <span class="cell-number">${item.number}</span>
        ${item.isMarked ? '<div class="cell-mark"></div>' : ''}
      </div>`)
    .join('')

  const answeredCount = items.filter((item) => item.answered).length
  const unansweredCount = items.filter((item) => !item.answered).length
  const markedCount = items.filter((item) => item.isMarked).length

  // 三态按钮，必须和组件 wxml 的 wx:if 分支一一对应
  let actions = ''

  if (unansweredCount > 0) {
    actions = `
      <div class="panel-row">
        <div class="panel-btn danger">确认结束</div>
        <div class="panel-btn primary">继续答题</div>
      </div>`
  } else if (markedCount > 0) {
    actions = `
      <div class="panel-row">
        <div class="panel-btn primary">继续答题</div>
        <div class="panel-btn accent">含标记，前往查看</div>
      </div>
      <div class="panel-btn danger panel-row-single">确认结束</div>`
  } else {
    actions = `
      <div class="panel-row">
        <div class="panel-btn primary">继续答题</div>
        <div class="panel-btn accent">确认结束</div>
      </div>`
  }

  return `
  <div class="page practice-page font-${data.preferences.fontSize}">
    ${head(Object.assign({}, data, { isCompleted: false }))}
    <div class="pra-body">${content(data, false)}</div>
    ${footer(data)}

    <div class="overview">
      <div class="mask"></div>
      <div class="panel">
        <div class="panel-grip"></div>
        <div class="panel-header"><span class="panel-title">答题卡</span></div>
        <div class="panel-stats">
          <div class="stat-item"><div class="stat-dot dot-answered"></div><span class="stat-text">已答 ${answeredCount}题</span></div>
          <span class="stat-sep">·</span>
          <div class="stat-item"><div class="stat-dot dot-pending"></div><span class="stat-text">未答 ${unansweredCount}题</span></div>
          <span class="stat-sep">·</span>
          <div class="stat-item"><div class="stat-dot dot-mark"></div><span class="stat-text">标记 ${markedCount}题</span></div>
        </div>
        <div class="legend">
          <div class="legend-item"><div class="dot dot-answered"></div><span class="legend-text">已答</span></div>
          <div class="legend-item"><div class="dot dot-pending"></div><span class="legend-text">未答</span></div>
          <div class="legend-item"><div class="dot dot-current"></div><span class="legend-text">当前</span></div>
          <div class="legend-item"><div class="dot dot-mark"></div><span class="legend-text">标记</span></div>
        </div>
        <div class="grid-scroll"><div class="grid">${cells}</div></div>
        <div class="panel-actions">${actions}</div>
      </div>
    </div>
  </div>`
}

function resultStage(data) {
  const cells = data.overviewItems
    .map((item) => `
      <div class="res-cell ${item.answered ? (item.unscored ? 'cell-unscored' : item.isCorrect ? 'cell-correct' : 'cell-wrong') : 'cell-pending'}">
        <span class="res-cell-number">${item.number}</span>
        ${item.isMarked ? '<div class="res-cell-mark"></div>' : ''}
      </div>`)
    .join('')

  const answered = data.total - data.unansweredCount

  return `
  <div class="page practice-page font-${data.preferences.fontSize}">
    ${head(data)}
    <div class="pra-result">
      <div class="res-card">
        <div class="res-card-cell"><span class="res-card-value">${data.elapsedText}</span><span class="res-card-label">总用时</span></div>
        <div class="res-card-split"></div>
        <div class="res-card-cell"><span class="res-card-value">${answered}/${data.total}</span><span class="res-card-label">已答/总题</span></div>
        <div class="res-card-split"></div>
        <div class="res-card-cell"><span class="res-card-value">${data.scoreText}</span><span class="res-card-label">${data.objectiveCount ? '客观题得分' : '完成状态'}</span></div>
      </div>

      <div class="res-detail">
        <div class="res-detail-head">
          <span class="res-detail-title">答题明细</span>
          <span class="res-detail-sub">历史最佳 ${data.bestScore}</span>
        </div>
        <div class="res-legend">
          <div class="res-legend-item"><div class="res-dot dot-correct"></div><span class="res-legend-text">答对</span></div>
          <div class="res-legend-item"><div class="res-dot dot-wrong"></div><span class="res-legend-text">答错</span></div>
          <div class="res-legend-item"><div class="res-dot dot-pending"></div><span class="res-legend-text">未答</span></div>
          <div class="res-legend-item"><div class="res-mark-dot"></div><span class="res-legend-text">标记</span></div>
        </div>
        <div class="res-grid">${cells}</div>
      </div>

      <div class="res-actions">
        <div class="pra-btn">返回题库</div>
        <div class="pra-btn primary">再来一次</div>
      </div>
      <div class="pra-body-pad"></div>
    </div>
  </div>`
}

const layoutVm = new PracticeLayoutViewModel({ storage: createStorage() })
const stageDefinitions = [
  { tag: '答题页 · 练习模式（未作答）', body: questionStage(freshData, false) },
  { tag: '答题页 · 即时模式（答错 + 已收藏已标记）', body: questionStage(wrongData, true) },
  { tag: '答题页 · 答题卡（还有未答）', body: sheetStage(sheetData, sheetItems) },
  { tag: '答题页 · 答题卡（已答完 · 有标记）', body: sheetStage(markedDoneData, markedDoneItems) },
  { tag: '答题页 · 答题卡（已答完 · 无标记）', body: sheetStage(plainDoneData, plainDoneItems) },
  { tag: '答题页 · 答题结果', body: resultStage(resultData) },
  { tag: '答题页 · 长题库名', body: questionStage(Object.assign({}, freshData, { practiceTitle: '学习能力与知识迁移综合练习题库：第一单元至第十二单元' }), false) },
  ...Array.from({ length: 8 }, (_, index) => {
    const data = layoutVm.preview(index).data
    return { tag: `自定义布局 · ${data.previewTypes[index]}`, body: questionStage(data, true) }
  })
]
const stages = stageDefinitions.map((stage) => `
    <div class="panel-col">
      <div class="panel-tag">${stage.tag}</div>
      <div class="stage"><style>${buildCss()}</style><div class="preview-status"><span>9:41</span><span>··· ▰</span></div><div class="preview-capsule"><span>•••</span><span>⦿</span></div>${stage.body}</div>
    </div>`)
  .join('')

const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body { margin: 0; background: #e9ebf0; }
  .board { padding: 24px; display: flex; gap: 24px; align-items: flex-start; }
  /* ⚠️ 外层容器不能用 .cell / .row / .tag 这类页面里已有的类名：
     会命中真实样式，把预览整张图撑歪 */
  .panel-col { display: flex; flex-direction: column; }
  .panel-tag { font: 12px/22px Consolas, monospace; color: #55606e; }
</style></head>
<body><div class="board">${stages}</div></body></html>`

fs.mkdirSync(OUT_DIR, { recursive: true })

const htmlPath = path.join(OUT_DIR, 'practice-preview.html')
const pngPath = path.join(OUT_DIR, 'practice-preview.png')

fs.writeFileSync(htmlPath, html)

const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find((file) => fs.existsSync(file))

if (!edge) {
  console.log(`未找到 Edge，HTML 已生成：${htmlPath}`)
  process.exit(0)
}

execFileSync(edge, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--virtual-time-budget=2000',
  `--window-size=${(STAGE_W + 24) * stageDefinitions.length + 24},${STAGE_H + 70}`,
  `--screenshot=${pngPath}`,
  `file:///${htmlPath.replace(/\\/g, '/')}`
], { stdio: 'ignore' })

const count = (items, key) => items.filter((item) => item[key]).length
console.log(`答题卡·未答完：已答 ${count(sheetItems, 'answered')}/${sheetItems.length}，标记 ${count(sheetItems, 'isMarked')}`)
console.log(`答题卡·已答完：标记 ${count(markedDoneItems, 'isMarked')}`)
console.log(`结果页：${resultData.correctCount}/${resultData.total} 正确，${resultData.score}%`)
console.log(`预览已生成：${pngPath}`)
