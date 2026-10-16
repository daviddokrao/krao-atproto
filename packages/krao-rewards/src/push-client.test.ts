import { describe, expect, it } from 'vitest'
import { PushClient, PushRequestError } from './push-client.js'

describe('PushClient.setLanguage', () => {
  it('passes the language on to the push service', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const client = new PushClient('http://push:2593', 'secret', (async (
      url: string,
      init: RequestInit,
    ) => {
      calls.push({ url, init })
      const { language } = JSON.parse(String(init.body)) as {
        language: string
      }
      return language === 'bad'
        ? Response.json({ error: 'InvalidRequest' }, { status: 400 })
        : Response.json({ language: language.startsWith('vi') ? 'vi' : 'en' })
    }) as typeof fetch)

    expect(await client.setLanguage('did:plc:vy', 'vi-VN')).toBe('vi')
    expect(calls[0].url).toBe('http://push:2593/internal/language')
    expect(calls[0].init.headers).toMatchObject({
      authorization: 'Bearer secret',
    })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      did: 'did:plc:vy',
      language: 'vi-VN',
    })
    await expect(
      client.setLanguage('did:plc:vy', 'bad'),
    ).rejects.toBeInstanceOf(PushRequestError)
  })
})
