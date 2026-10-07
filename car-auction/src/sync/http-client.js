// عميل HTTP للمصادر الخارجية: مهلة لكل طلب، إعادة محاولة بتراجع أُسّي مع
// تشويش عشوائي (jitter)، احترام Retry-After عند 429، وعدم إعادة المحاولة على أخطاء 4xx.

export class SourceError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, { token, timeoutMs = 15_000, retries = 4, baseDelayMs = 500, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new SourceError('استجابة ليست JSON صالحًا', { status: res.status, retryable: false });
        }
      }
      const retryable = res.status === 429 || res.status >= 500;
      const err = new SourceError(`HTTP ${res.status} من المصدر`, { status: res.status, retryable });
      if (!retryable) throw err;
      lastErr = err;
      const ra = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt, baseDelayMs);
      onRetry?.(attempt + 1, err, delay);
      if (attempt < retries) await sleep(delay);
    } catch (e) {
      if (e instanceof SourceError && !e.retryable) throw e;
      lastErr = e instanceof SourceError ? e : new SourceError(`فشل الاتصال: ${e.message}`, { retryable: true });
      if (!(e instanceof SourceError)) {
        const delay = backoff(attempt, baseDelayMs);
        onRetry?.(attempt + 1, lastErr, delay);
        if (attempt < retries) await sleep(delay);
      }
    }
  }
  throw lastErr;
}

export function backoff(attempt, base = 500, cap = 30_000) {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
}
