/**
 * 图表绘制：把数据折算成 SVG 字符串，再转成 base64 data URI 交给 WXSS 渲染。
 *
 * 为什么不引图表库：小程序运行时是零依赖、零构建的，
 * 而且图表画在 canvas 上时需要 `createSelectorQuery` 拿节点、处理 DPR、监听重绘，
 * 页面一多很容易出错。这里沿用项目已有的做法 ——
 * 内联 SVG 当背景图渲染，尺寸固定、无副作用，纯字符串函数还能在 Node 里直接断言。
 *
 * 图形使用 SVG；日期标签由页面原生文字绘制，保持各屏幕字号一致。
 */

const { colors, blueScale } = require('./design-tokens.js')
const { encodeBase64Utf8 } = require('./base64.js')

const COLORS = { brand: colors.brand, text: colors['text-sub'], muted: colors['text-sub'] }

function round(value, digits) {
  const factor = Math.pow(10, digits === undefined ? 1 : digits)

  return Math.round((Number(value) || 0) * factor) / factor
}

function escapeXml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toDataUri(svg) {
  return `data:image/svg+xml;base64,${encodeBase64Utf8(svg)}`
}

/**
 * 学习活动热力图（设计稿「近半年」那一块）。
 *
 * columns 按周排列，每列 7 个格子；月份标签由页面单独绘制。
 *
 * @param {object} options { columns, cell, gap }
 *   columns: Array<Array<{ level: 0-4, key, answered } | null>>
 */
function buildHeatmapSvg(options) {
  const config = options || {}
  const columns = config.columns || []
  const cell = config.cell || 18
  const gap = config.gap || 5
  const radius = 4

  if (!columns.length) {
    return ''
  }

  const step = cell + gap
  const width = columns.length * step - gap
  const gridHeight = 7 * step - gap
  const height = gridHeight

  // 五档蓝：0 是无记录的浅灰，4 是最深的品牌蓝。档位固定，不随最大值浮动，
  // 否则「同样做了 20 题」在不同周可能显示成不同深浅，看着像数据错了。
  const LEVEL_FILL = blueScale

  const cells = columns
    .map((column, colIndex) => column
      .map((day, rowIndex) => {
        if (!day) {
          return ''
        }

        const level = Math.min(Math.max(Number(day.level) || 0, 0), 4)
        const x = colIndex * step
        const y = rowIndex * step

        return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="${radius}" ` +
          `fill="${LEVEL_FILL[level]}"/>`
      })
      .join(''))
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">` +
    `<g>${cells}</g></svg>`
}

/** Catmull-Rom 转三次贝塞尔，得到「看起来是手绘曲线」而不是折线 */
function smoothPath(coords) {
  if (!coords.length) {
    return ''
  }

  if (coords.length === 1) {
    return `M ${coords[0].x} ${coords[0].y}`
  }

  let path = `M ${round(coords[0].x)} ${round(coords[0].y)}`

  for (let i = 0; i < coords.length - 1; i += 1) {
    const p0 = coords[i - 1] || coords[i]
    const p1 = coords[i]
    const p2 = coords[i + 1]
    const p3 = coords[i + 2] || p2
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6

    path += ` C ${round(cp1x)} ${round(cp1y)}, ${round(cp2x)} ${round(cp2y)}, ` +
      `${round(p2.x)} ${round(p2.y)}`
  }

  return path
}

/**
 * 答题趋势曲线与渐变面积。
 *
 * @param {Array} points [{ value, label }]，label 为空则该点不标
 * @param {object} options { width, height }
 */
function buildAreaTrendSvg(points, options) {
  const list = (points || []).filter((point) => point)
  const config = options || {}
  const width = config.width || 640
  const height = config.height || 240
  const paddingX = 10
  const paddingTop = 18
  const baseline = height - 10
  const plotWidth = width - paddingX * 2

  if (list.length < 2) {
    return ''
  }

  const maxValue = Math.max.apply(null, list.map((point) => Number(point.value) || 0)) || 1
  const step = plotWidth / (list.length - 1)
  const coords = list.map((point, index) => ({
    x: paddingX + step * index,
    y: baseline - ((Number(point.value) || 0) / maxValue) * (baseline - paddingTop)
  }))

  const line = smoothPath(coords)
  const area = `${line} L ${round(coords[coords.length - 1].x)} ${baseline} ` +
    `L ${round(coords[0].x)} ${baseline} Z`
  const last = coords[coords.length - 1]

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">` +
    '<defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">' +
    `<stop offset="0%" stop-color="${COLORS.brand}" stop-opacity="0.28"/>` +
    `<stop offset="100%" stop-color="${COLORS.brand}" stop-opacity="0"/>` +
    '</linearGradient></defs>' +
    `<path d="${area}" fill="url(#areaFill)"/>` +
    `<path d="${line}" fill="none" stroke="${COLORS.brand}" stroke-width="3" ` +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    `<circle cx="${round(last.x)}" cy="${round(last.y)}" r="5" fill="${colors.card}" ` +
    `stroke="${COLORS.brand}" stroke-width="3"/>` +
    '</svg>'
}

module.exports = {
  COLORS,
  buildAreaTrendSvg,
  buildHeatmapSvg,
  escapeXml,
  round,
  toDataUri
}
