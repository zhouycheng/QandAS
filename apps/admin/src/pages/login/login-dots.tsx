import { useEffect, useRef } from 'react'

export function dotOffset(dx: number, dy: number, radius: number, strength: number) {
  const weight = Math.max(0, 1 - Math.hypot(dx, dy) / radius) ** 2 * strength
  return { x: dx * weight * 0.46, y: dy * weight * 0.46, weight }
}

function trackPointer(canvas: HTMLCanvasElement) {
  const page = canvas.parentElement
  const context = canvas.getContext('2d')
  if (!page || !context) return
  const style = getComputedStyle(canvas)
  const spacing = parseFloat(style.getPropertyValue('--dot-spacing'))
  const radius = spacing * 9
  const size = (radius + spacing) * 2
  const scale = Math.min(window.devicePixelRatio, 2)
  canvas.width = canvas.height = Math.round(size * scale)
  canvas.style.width = canvas.style.height = `${size}px`
  context.scale(scale, scale)
  context.fillStyle = style.color

  let target: { x: number; y: number } | null = null
  let centerX = 0, centerY = 0, strength = 0, frame = 0
  const paint = () => {
    frame = 0
    strength += ((target ? 1 : 0) - strength) * 0.22
    if (!target && strength < 0.01) {
      canvas.hidden = true
      strength = 0
      return
    }
    if (target) {
      centerX += (target.x - centerX) * 0.24
      centerY += (target.y - centerY) * 0.24
    }
    const left = Math.round(centerX / spacing) * spacing - size / 2
    const top = Math.round(centerY / spacing) * spacing - size / 2
    canvas.style.transform = `translate(${left}px, ${top}px)`
    canvas.hidden = false
    context.clearRect(0, 0, size, size)
    for (let row = spacing / 2; row < size; row += spacing) {
      for (let column = spacing / 2; column < size; column += spacing) {
        const offset = dotOffset(centerX - left - column, centerY - top - row, radius, strength)
        context.globalAlpha = 0.23 + offset.weight * 0.42
        context.beginPath()
        context.arc(column + offset.x, row + offset.y, 1 + offset.weight * 0.6, 0, 2 * Math.PI)
        context.fill()
      }
    }
    if (!target || 1 - strength > 0.01 || Math.hypot(target.x - centerX, target.y - centerY) > 0.2) {
      frame = requestAnimationFrame(paint)
    }
  }
  const wake = () => { if (!frame) frame = requestAnimationFrame(paint) }
  const move = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    const bounds = page.getBoundingClientRect()
    target = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    if (canvas.hidden) { centerX = target.x; centerY = target.y }
    wake()
  }
  const leave = () => { target = null; wake() }
  page.addEventListener('pointermove', move, { passive: true })
  page.addEventListener('pointerleave', leave)
  window.addEventListener('blur', leave)
  return () => {
    page.removeEventListener('pointermove', move)
    page.removeEventListener('pointerleave', leave)
    window.removeEventListener('blur', leave)
    cancelAnimationFrame(frame)
    canvas.hidden = true
  }
}

export function LoginDots() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const motion = matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)')
    let stop: (() => void) | undefined
    const sync = () => { stop?.(); stop = motion.matches ? trackPointer(canvas) : undefined }
    sync()
    motion.addEventListener('change', sync)
    return () => { stop?.(); motion.removeEventListener('change', sync) }
  }, [])
  return <canvas className="login-dots" ref={ref} aria-hidden="true" hidden />
}
