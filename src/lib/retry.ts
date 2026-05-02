// ============================================================
// RETRY WITH EXPONENTIAL BACKOFF
// ============================================================
// Used for resilient calls to upstream services (Fal, Anthropic).
// Retries transient failures (5xx, network errors), not 4xx
// (those won't get better by trying again).
// ============================================================

export interface RetryOptions {
  /** Max attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Initial delay in ms. Doubled each retry. Default 1000. */
  initialDelayMs?: number;
  /** Cap on delay between retries. Default 30s. */
  maxDelayMs?: number;
  /** Custom predicate to decide if an error is retriable. Default: 5xx + network. */
  isRetriable?: (err: unknown) => boolean;
  /** Optional callback fired before each retry sleep. Useful for logging. */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
  totalElapsedMs: number;
}

/** Default predicate: retry on 5xx HTTP, fetch network errors, timeouts. */
function defaultIsRetriable(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  // Common upstream-error signatures worth retrying
  if (/etimedout|econnreset|econnrefused|socket hang up|network/i.test(msg)) return true;
  if (/\b(5\d\d)\b/.test(msg)) return true;
  if (/timeout|temporarily unavailable|service unavailable/i.test(msg)) return true;
  // Fal's queue can return RATE_LIMITED — retriable with backoff
  if (/rate.?limit/i.test(msg)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` with retry-on-transient-error.
 *
 * Example:
 *   const { result, attempts } = await retryWithBackoff(
 *     () => fal.subscribe("fal-ai/flux-lora", { input }),
 *     { maxAttempts: 3, onRetry: (n, err) => console.warn(`retry ${n}:`, err) }
 *   );
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<RetryResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initialDelayMs = opts.initialDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const isRetriable = opts.isRetriable ?? defaultIsRetriable;

  const startTime = Date.now();
  let lastErr: unknown;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt, totalElapsedMs: Date.now() - startTime };
    } catch (err) {
      lastErr = err;
      const willRetry = attempt < maxAttempts && isRetriable(err);
      if (!willRetry) break;
      const sleepFor = Math.min(delay, maxDelayMs);
      opts.onRetry?.(attempt, err, sleepFor);
      await sleep(sleepFor);
      delay *= 3; // 1s → 3s → 9s by default
    }
  }

  throw lastErr;
}
