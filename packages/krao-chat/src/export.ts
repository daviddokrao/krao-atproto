import type { Database } from './db.js'

const MAX_MESSAGES = 50_000

/** Drops null and undefined values, which lexicon data leaves out */
export function withoutEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmpty)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, withoutEmpty(v)]),
    )
  }
  return value
}

const parse = (json: string | null) => {
  if (!json) return undefined
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

/**
 * What the chat service holds about an account: its convos (with their
 * members, as DIDs), the messages it sent, its reactions and chat settings.
 * Others' messages are theirs, so they are not part of it.
 */
export async function exportChatData(db: Database, did: string) {
  const memberships = await db
    .selectFrom('member')
    .innerJoin('convo', 'convo.id', 'member.convoId')
    .select([
      'convo.id',
      'convo.kind',
      'convo.name',
      'convo.ownerDid',
      'convo.createdAt',
      'member.status',
      'member.state',
      'member.role',
      'member.muted',
    ])
    .where('member.did', '=', did)
    .orderBy('convo.createdAt', 'desc')
    .execute()
  const convoIds = memberships.map((m) => m.id)
  const members = convoIds.length
    ? await db
        .selectFrom('member')
        .select(['convoId', 'did'])
        .where('convoId', 'in', convoIds)
        .where('state', '=', 'active')
        .execute()
    : []
  const messages = await db
    .selectFrom('message')
    .select(['id', 'convoId', 'text', 'facets', 'embed', 'replyTo', 'sentAt'])
    .where('senderDid', '=', did)
    .where('system', 'is', null)
    .orderBy('rev', 'desc')
    .limit(MAX_MESSAGES)
    .execute()
  const reactions = await db
    .selectFrom('reaction')
    .select(['messageId', 'convoId', 'value', 'createdAt'])
    .where('did', '=', did)
    .execute()
  const prefs = await db
    .selectFrom('prefs')
    .select('prefs')
    .where('did', '=', did)
    .executeTakeFirst()
  return withoutEmpty({
    convos: memberships.map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name ?? undefined,
      owner: m.ownerDid ?? undefined,
      createdAt: m.createdAt,
      status: m.status,
      state: m.state,
      role: m.role ?? undefined,
      muted: !!m.muted,
      members: members.filter((x) => x.convoId === m.id).map((x) => x.did),
    })),
    messages: messages.map((m) => ({
      id: m.id,
      convoId: m.convoId,
      text: m.text ?? '',
      facets: parse(m.facets),
      embed: parse(m.embed),
      replyTo: m.replyTo ?? undefined,
      sentAt: m.sentAt,
    })),
    messagesTruncated: messages.length === MAX_MESSAGES,
    reactions,
    preferences: parse(prefs?.prefs ?? null),
  })
}
