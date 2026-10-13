export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export interface RetryOptions {
  maxRetries: number;
  onRetry?: (info: RetryInfo) => void;
  shouldRetry?: (error: unknown) => boolean;
  retryAfterMs?: (error: unknown) => number | undefined;
}

export class RetryExhaustedError extends Error {
  constructor(readonly cause: unknown, readonly attempts: number) {
    super(`Failed after ${attempts} attempts: ${cause instanceof Error ? cause.message : "unknown error"}`);
    this.name = "RetryExhaustedError";
  }
}

export function isTransientIoError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" &&
    /^(EAGAIN|EBUSY|EIO|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTCONN)$/.test(error.code);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = { maxRetries: 2 }
): Promise<T> {
  const shouldRetry = options.shouldRetry ?? isTransientIoError;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryAfter = options.retryAfterMs?.(error);
      // Never retry earlier than a server requested, or wait indefinitely.
      if (attempt > options.maxRetries || !shouldRetry(error) || (retryAfter !== undefined && retryAfter > 60000)) {
        throw attempt === 1 ? error : new RetryExhaustedError(error, attempt);
      }
      const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
      const delayMs = Math.max(backoff, retryAfter ?? 0);
      options.onRetry?.({ attempt: attempt + 1, maxAttempts: options.maxRetries + 1, delayMs });
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
