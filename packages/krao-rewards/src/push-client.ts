/**
 * Posts events to Krao's push service (packages/krao-push), which turns them
 * into notifications on the recipients' devices. Never in the way: a push
 * that fails is logged and dropped.
 */
export class PushClient {
  constructor(
    private url: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /** Each event needs an `id` unique to it, so a retry pushes once */
  notify(event: { kind: string; id: string; [key: string]: unknown }): void {
    void this.fetchFn(`${this.url}/internal/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => {
        if (!res.ok) console.error(`Krao push: ${event.kind} got ${res.status}`)
      })
      .catch((err: unknown) => {
        console.error(`Krao push: ${event.kind} failed`, err)
      })
  }

  /**
   * The account's devices as the push service knows them, by platform only
   * (for data exports: the push service is not public)
   */
  async devices(
    did: string,
  ): Promise<{ count: number; platforms: Record<string, number> }> {
    const url = new URL('/internal/devices', this.url)
    url.searchParams.set('did', did)
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`Krao push: devices got ${res.status}`)
    return (await res.json()) as {
      count: number
      platforms: Record<string, number>
      language?: string
    }
  }

  /**
   * Sets the language of the account's pushes (the push service is not
   * public, so the app sets it here); returns the language pushes use
   */
  async setLanguage(did: string, language: string): Promise<string> {
    const res = await this.fetchFn(`${this.url}/internal/language`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ did, language }),
      signal: AbortSignal.timeout(5_000),
    })
    if (res.status === 400) throw new PushRequestError('Invalid language')
    if (!res.ok) throw new Error(`Krao push: language got ${res.status}`)
    return ((await res.json()) as { language: string }).language
  }
}

/** The push service refused the request as malformed */
export class PushRequestError extends Error {}

/** A client when both settings are there, else none (pushes are off) */
export function createPushClient(url?: string, token?: string) {
  return url && token ? new PushClient(url, token) : undefined
}
