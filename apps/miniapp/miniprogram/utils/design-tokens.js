// Shared by WXSS generation, charts and image generators.
const colors = {
  brand: '#2563EB', 'brand-dark': '#1D4ED8', 'brand-soft': '#EFF6FF',
  'text-main': '#1F2937', 'text-sub': '#667085', 'text-muted': '#667085',
  'text-disabled': '#9CA3AF', line: '#E5E7EB', 'control-border': '#667085',
  card: '#FFFFFF', 'page-bg': '#F5F7FA', 'disabled-bg': '#E5E7EB',
  success: '#15803D', 'success-soft': '#F0FDF4', warning: '#B45309',
  'warning-soft': '#FFFBEB', danger: '#B91C1C', 'danger-soft': '#FEF2F2',
  mask: 'rgba(15, 23, 42, 0.45)'
}
// Home tiles use the megaphone's yellow, coral and navy with lighter highlights.
const homeEntryColors = {
  recent: ['#FFE58A', '#E8B323'],
  mock: ['#647CAB', '#263D68'],
  wrong: ['#FF9188', '#F04B40'],
  favorite: ['#8297BE', '#405C8C']
}
const fontSizes = { caption: 11, secondary: 12, body: 14, title: 16, display: 18, metric: 24 }
const lineHeights = { caption: 16, secondary: 18, body: 22, title: 24, display: 26, metric: 32 }
const readingSizes = { small: 14, normal: 18, large: 20, xlarge: 22, xxlarge: 24 }
const spacing = { xs: 8, sm: 16, md: 24, lg: 32, xl: 48 }
const radii = { tag: 16, control: 24, card: 24, overlay: 40 }
const blueScale = ['#E5E7EB', '#DBEAFE', '#93C5FD', '#60A5FA', colors.brand]
const fontFamily = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif'
module.exports = { colors, homeEntryColors, fontSizes, lineHeights, readingSizes, spacing, radii, blueScale, fontFamily }
