export class ApiError extends Error {
  constructor(message: string, readonly code = 'VALIDATION_FAILED', readonly status = 422, readonly requestId: string = crypto.randomUUID(), readonly retryAfterSeconds?: number) { super(message) }
}
