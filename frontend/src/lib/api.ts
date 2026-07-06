const SAFEWORD_KEY = 'wrb_safeword'

export function getSafeword(): string {
  return sessionStorage.getItem(SAFEWORD_KEY) ?? ''
}

export function setSafeword(value: string) {
  sessionStorage.setItem(SAFEWORD_KEY, value)
}

export function clearSafeword() {
  sessionStorage.removeItem(SAFEWORD_KEY)
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; safeword?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.safeword) headers['X-Safeword'] = getSafeword()

  const res = await fetch(path, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch { /* not JSON */ }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function qrUrl(data: string): string {
  return `/api/qr.png?data=${encodeURIComponent(data)}`
}
