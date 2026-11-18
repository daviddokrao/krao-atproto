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
}

/** A client when both settings are there, else none (pushes are off) */
export function createPushClient(url?: string, token?: string) {
  return url && token ? new PushClient(url, token) : undefined
}
