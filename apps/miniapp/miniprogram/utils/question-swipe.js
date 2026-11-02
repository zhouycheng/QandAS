// Direction is shared by touch navigation and its boundary tests.
function swipeDirection(start, end) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (end.at - start.at >= 400 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return 0
  return dx < 0 ? 1 : -1
}
module.exports = { swipeDirection }
