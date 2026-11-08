export function retryDelay(failures, retryAfterSeconds = 0, random = Math.random()) {
  const backoff = Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6));
  const retryAfter = Number(retryAfterSeconds);
  return Math.max(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0, backoff * (0.5 + random * 0.5));
}
