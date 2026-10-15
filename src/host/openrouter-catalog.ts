import { OPENROUTER_MODELS_URL, parseOpenRouterModels } from './pricing.js'
import { fetchWithRetry, readJsonBounded } from './net.js'

/** Public, read-only price lookup. No credentials, inference, ledger or config writes. */
export function createOpenRouterCatalog({ fetchImpl, now = Date.now, timeoutMs = 15000 }: { fetchImpl?: any; now?: () => number; timeoutMs?: number } = {}) {
  // TODO(types): fetchImpl 是注入用的 fetch 实现(测试/宿主),保持 any。
  let active = true, pending: Promise<any> | null = null, controller: AbortController | null = null, checkedAt = -Infinity
  let snapshot: { models: any[]; fetchedAt: string; stale: boolean; error: string } = { models: [], fetchedAt: '', stale: true, error: '' }
  const read = () => {
    if (!active) return Promise.reject(new Error('OpenRouter catalog disposed'))
    if (pending) return pending
    // Share requests across tabs, including a brief backoff after failures.
    if (now() - checkedAt < 15000) return Promise.resolve(snapshot)
    controller = new AbortController()
    const signal = controller.signal
    const timer = setTimeout(() => controller?.abort(new Error('OpenRouter catalog timed out')), timeoutMs)
    timer.unref?.()
    pending = (async () => {
      try {
        const response = await fetchWithRetry(OPENROUTER_MODELS_URL, {
          method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-cache', signal,
          headers: { 'user-agent': 'dsh-cost-meter (public price lookup)' },
        }, { attempts: 1, fetchImpl })
        if (!response.ok) {
          try { await response.body?.cancel?.() } catch {}
          throw new Error(`HTTP ${response.status}`)
        }
        const json = await readJsonBounded(response, 4 * 1024 * 1024)
        const prices = parseOpenRouterModels(json).models
        const details = new Map<string, any>(json.data.filter((row: any) => row && typeof row.id === 'string').map((row: any) => [row.id.trim(), row] as [string, any]))
        const models = Object.entries(prices).map(([id, price]) => {
          const row: any = details.get(id)
          return {
            id, name: typeof row?.name === 'string' ? row.name : id,
            contextLength: Number.isSafeInteger(row?.context_length) && row.context_length >= 0 ? row.context_length : null,
            input: price.input, output: price.output,
            cachedInput: price.cachedInput ?? null, cacheWrite: price.cacheWrite ?? null,
          }
        })
        signal.throwIfAborted()
        if (!active) throw new Error('OpenRouter catalog disposed')
        snapshot = { models, fetchedAt: new Date(now()).toISOString(), stale: false, error: '' }
      } catch (error: any) {
        if (!active) throw error
        snapshot = { ...snapshot, stale: true, error: String(error?.message ?? error) }
      }
      checkedAt = now()
      return snapshot
    })().finally(() => { clearTimeout(timer); pending = null; controller = null })
    return pending
  }
  return { read, dispose() { active = false; controller?.abort(new Error('OpenRouter catalog disposed')) } }
}
