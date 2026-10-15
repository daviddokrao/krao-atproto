import type { AppviewClient } from './appview.js'
import { excerpt, nameOf } from './compose.js'
import type { PushMessage } from './senders.js'
import type { PushService } from './service.js'

/*
 * Events from Krao's own services, posted to /internal/notify. Each carries
 * an `id` that is unique per event, so a retried post pushes once.
 */
export type KraoEvent =
  | {
      kind: 'chat'
      id: string
      recipientDids: string[]
      senderDid: string
      convoId: string
      messageId: string
      text?: string
      /** Set for a group conversation */
      groupName?: string
      /** A reaction to the recipient's message instead of a new message */
      reaction?: string
    }
  | {
      kind: 'tip'
      id: string
      recipientDid: string
      senderDid: string
      /** The post tipped, if any */
      subject?: string
      message?: string
    }
  | { kind: 'points'; id: string; recipientDid: string; points: number }
  | {
      kind: 'kyc'
      id: string
      recipientDid: string
      status: 'approved' | 'rejected'
    }

export function parseKraoEvent(body: unknown): KraoEvent | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const str = (v: unknown, max = 3000) =>
    typeof v === 'string' && v.length > 0 && v.length <= max
  const did = (v: unknown) => str(v, 2048) && (v as string).startsWith('did:')
  if (!str(b.id, 512)) return null
  switch (b.kind) {
    case 'chat':
      if (
        !Array.isArray(b.recipientDids) ||
        b.recipientDids.length > 1000 ||
        !b.recipientDids.every(did) ||
        !did(b.senderDid) ||
        !str(b.convoId, 512) ||
        !str(b.messageId, 512) ||
        (b.text !== undefined && typeof b.text !== 'string') ||
        (b.groupName !== undefined && typeof b.groupName !== 'string') ||
        (b.reaction !== undefined && !str(b.reaction, 64))
      ) {
        return null
      }
      return b as KraoEvent
    case 'tip':
      if (!did(b.recipientDid) || !did(b.senderDid)) return null
      if (b.subject !== undefined && !str(b.subject, 2048)) return null
      if (b.message !== undefined && typeof b.message !== 'string') return null
      return b as KraoEvent
    case 'points':
      if (!did(b.recipientDid) || !Number.isSafeInteger(b.points)) return null
      return b as KraoEvent
    case 'kyc':
      if (!did(b.recipientDid)) return null
      if (b.status !== 'approved' && b.status !== 'rejected') return null
      return b as KraoEvent
    default:
      return null
  }
}

/** Pushes one Krao event; returns how many devices accepted it */
export async function pushKraoEvent(
  push: PushService,
  appview: AppviewClient,
  evt: KraoEvent,
): Promise<number> {
  if (!(await push.claim(`k:${evt.kind}:${evt.id}`))) return 0
  const recipients = evt.kind === 'chat' ? evt.recipientDids : [evt.recipientDid]
  const withDevices = await push.hasDevices(recipients)
  if (!withDevices.size) return 0

  const send = async (did: string, msg: PushMessage) => push.deliver(did, msg)
  let sent = 0
  switch (evt.kind) {
    case 'chat': {
      const sender = (await appview.profiles([evt.senderDid])).get(
        evt.senderDid,
      )
      if (!sender) return 0
      const name = nameOf(sender)
      const title = evt.groupName ? `${name} in ${evt.groupName}` : name
      const body = evt.reaction
        ? `Reacted ${evt.reaction} to your message`
        : excerpt(evt.text) || 'Sent a message'
      for (const did of withDevices) {
        sent += await send(did, {
          title,
          body,
          data: {
            reason: evt.reaction ? 'chat-reaction' : 'chat-message',
            convoId: evt.convoId,
            messageId: evt.messageId,
            // For the iOS notification service extension
            senderDisplayName: name,
            senderHandle: sender.handle,
            convoKind: evt.groupName ? 'group' : 'direct',
            ...(evt.groupName ? { groupName: evt.groupName } : {}),
          },
          threadId: `chat:${evt.convoId}`,
        })
      }
      return sent
    }
    case 'tip': {
      const sender = (await appview.profiles([evt.senderDid])).get(
        evt.senderDid,
      )
      if (!sender) return 0
      return send(evt.recipientDid, {
        title: `${nameOf(sender)} sent you a tip`,
        body: excerpt(evt.message),
        data: {
          reason: 'krao-tip',
          uri: evt.subject ?? `at://${evt.senderDid}`,
          subject: evt.subject ?? '',
        },
        threadId: 'krao-tip',
      })
    }
    case 'points':
      return send(evt.recipientDid, {
        title: 'Your points were approved',
        body: `+${evt.points} points`,
        data: { reason: 'krao-points' },
        threadId: 'krao-rewards',
      })
    case 'kyc':
      return send(evt.recipientDid, {
        title:
          evt.status === 'approved'
            ? 'Your identity is verified'
            : 'Identity verification was not approved',
        body:
          evt.status === 'approved'
            ? 'Pending referral points can now be approved.'
            : 'Open Krao to see what to do next.',
        data: { reason: 'krao-kyc' },
        threadId: 'krao-rewards',
      })
  }
}
