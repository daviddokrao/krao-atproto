import { InvalidRequestError } from '@atproto/xrpc-server'
import { sql } from 'kysely'
import { countGraphemes } from 'unicode-segmenter/grapheme'
import type { Appview, AppviewProfile } from './appview.js'
import { isChatDisabled } from './moderation.js'
import type {
  ConvoTable,
  Database,
  MemberStatus,
  MemberTable,
  MessageTable,
  ReactionTable,
} from './db.js'
import type { PushClient } from './push-client.js'
import { currentRev, nextRev, randomId } from './rev.js'

/* The views below are plain JSON in the shapes of the chat.bsky lexicons */
type Json = Record<string, unknown>

const T = {
  messageView: 'chat.bsky.convo.defs#messageView',
  deletedMessageView: 'chat.bsky.convo.defs#deletedMessageView',
  systemMessageView: 'chat.bsky.convo.defs#systemMessageView',
  beforeJoined: 'chat.bsky.convo.defs#messageBeforeUserJoinedGroupView',
  messageAndReactionView: 'chat.bsky.convo.defs#messageAndReactionView',
  directConvo: 'chat.bsky.convo.defs#directConvo',
  groupConvo: 'chat.bsky.convo.defs#groupConvo',
  directMember: 'chat.bsky.actor.defs#directConvoMember',
  groupMember: 'chat.bsky.actor.defs#groupConvoMember',
  pastGroupMember: 'chat.bsky.actor.defs#pastGroupConvoMember',
  log: (name: string) => `chat.bsky.convo.defs#${name}`,
}

export const GROUP_MEMBER_LIMIT = 50
/** Distinct reactions one account may put on one message */
const REACTION_LIMIT = 5

export type MessageInput = {
  text: string
  facets?: unknown[]
  embed?: Json
  replyTo?: { messageId: string }
}

export class ChatService {
  /** Tells members about new messages when set */
  push?: PushClient

  constructor(
    public db: Database,
    public appview: Appview,
  ) {}

  /**
   * Run `fn` with a copy of this service whose database is a transaction.
   * Keep network calls (AppView) out of `fn`: SQLite has one connection, so
   * the transaction holds up every other query until it ends.
   */
  async transact<T>(fn: (svc: this) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return fn(this)
    return this.db.transaction().execute((trx) => {
      const svc = Object.create(this) as this
      svc.db = trx
      return fn(svc)
    })
  }

  /*
   * Members and convos
   */

  async getMember(convoId: string, did: string) {
    return this.db
      .selectFrom('member')
      .selectAll()
      .where('convoId', '=', convoId)
      .where('did', '=', did)
      .executeTakeFirst()
  }

  /** The convo and the viewer's membership, or InvalidConvo */
  async getConvoForViewer(convoId: string, viewer: string) {
    const convo = await this.db
      .selectFrom('convo')
      .selectAll()
      .where('id', '=', convoId)
      .executeTakeFirst()
    const member = convo && (await this.getMember(convoId, viewer))
    if (!convo || !member || member.state !== 'active') {
      throw new InvalidRequestError('Convo not found', 'InvalidConvo')
    }
    return { convo, member }
  }

  async listMembers(convoId: string) {
    return this.db
      .selectFrom('member')
      .selectAll()
      .where('convoId', '=', convoId)
      .execute()
  }

  async touchConvo(convoId: string, rev: string) {
    await this.db
      .updateTable('convo')
      .set({ rev })
      .where('id', '=', convoId)
      .execute()
  }

  /** Appends a log entry for each of `dids`; returns the entries' revs */
  async log(dids: string[], convoId: string, entry: (rev: string) => Json) {
    for (const did of new Set(dids)) {
      const rev = nextRev()
      const { rev: _rev, ...data } = entry(rev)
      await this.db
        .insertInto('log')
        .values({ rev, did, convoId, data: JSON.stringify(data) })
        .execute()
    }
  }

  activeDids(members: MemberTable[]) {
    return members.filter((m) => m.state === 'active').map((m) => m.did)
  }

  /*
   * Who may message whom
   */

  /**
   * Throws if `sender` may not start or continue a direct chat with
   * `recipient`: unknown account, a block either way, or the recipient's chat
   * settings (allowIncoming: all, following (default) or none).
   */
  async assertCanMessage(
    sender: string,
    recipient: string,
    opts: { recipientAccepted?: boolean } = {},
  ) {
    const profile = await this.appview.getProfile(recipient)
    if (!profile) {
      throw new InvalidRequestError('Recipient not found', 'RecipientNotFound')
    }
    const rel = (await this.appview.getRelationships(sender, [recipient])).get(
      recipient,
    )
    if (rel?.blocking) {
      throw new InvalidRequestError(
        'You have blocked this account',
        'BlockedActor',
      )
    }
    if (rel?.blockedBy) {
      throw new InvalidRequestError(
        'This account has blocked you',
        'BlockedSubject',
      )
    }
    if (opts.recipientAccepted) return
    const allow = profile.associated?.chat?.allowIncoming ?? 'following'
    if (allow === 'none') {
      throw new InvalidRequestError(
        'This account does not accept messages',
        'MessagesDisabled',
      )
    }
    if (allow === 'following' && !rel?.followedBy) {
      throw new InvalidRequestError(
        'This account only accepts messages from people it follows',
        'NotFollowedBySender',
      )
    }
  }

  /** Whether `recipient` follows `sender`, which accepts the chat up front */
  async follows(recipient: string, sender: string) {
    const rel = (await this.appview.getRelationships(recipient, [sender])).get(
      sender,
    )
    return !!rel?.following
  }

  /*
   * Direct convos
   */

  async findDirectConvo(a: string, b: string) {
    return this.db
      .selectFrom('convo')
      .selectAll()
      .where('directKey', '=', [a, b].sort().join(' '))
      .executeTakeFirst()
  }

  /**
   * Creates the direct convo between the two accounts and returns its id. If
   * a concurrent request created it first, returns that one instead.
   */
  async createDirectConvo(creator: string, other: string) {
    const directKey = [creator, other].sort().join(' ')
    const otherStatus: MemberStatus = (await this.follows(other, creator))
      ? 'accepted'
      : 'request'
    const id = randomId()
    try {
      await this.transact(async (svc) => {
        const rev = nextRev()
        await svc.db
          .insertInto('convo')
          .values({
            id,
            kind: 'direct',
            name: null,
            ownerDid: null,
            directKey,
            lockStatus: 'unlocked',
            memberLimit: 2,
            createdAt: new Date().toISOString(),
            rev,
          })
          .execute()
        for (const [did, status] of [
          [creator, 'accepted'],
          [other, otherStatus],
        ] as const) {
          await svc.db
            .insertInto('member')
            .values({
              convoId: id,
              did,
              role: null,
              status,
              state: 'active',
              muted: 0,
              addedBy: null,
              joinedRev: '',
              lastReadRev: rev,
            })
            .execute()
        }
        await svc.log([creator], id, (r) => ({
          $type: T.log('logBeginConvo'),
          rev: r,
          convoId: id,
        }))
      })
    } catch (err) {
      const existing = isUniqueViolation(err)
        ? await this.findDirectConvo(creator, other)
        : undefined
      if (!existing) throw err
      return existing.id
    }
    return id
  }

  /*
   * Messages
   */

  async getMessage(convoId: string, messageId: string) {
    return this.db
      .selectFrom('message')
      .selectAll()
      .where('id', '=', messageId)
      .where('convoId', '=', convoId)
      .executeTakeFirst()
  }

  async isHidden(messageId: string, did: string) {
    const row = await this.db
      .selectFrom('hidden_message')
      .select('did')
      .where('messageId', '=', messageId)
      .where('did', '=', did)
      .executeTakeFirst()
    return !!row
  }

  /** Stores a user message and logs it to every active member */
  async sendMessage(convoId: string, sender: string, input: MessageInput) {
    const { convo, member } = await this.getConvoForViewer(convoId, sender)
    if (await isChatDisabled(this.db, sender)) {
      throw new InvalidRequestError(
        'A moderator has disabled chat for this account',
        'ChatDisabled',
      )
    }
    if (convo.lockStatus !== 'unlocked') {
      throw new InvalidRequestError('This convo is locked', 'ConvoLocked')
    }
    const members = await this.listMembers(convoId)
    let reopen: string | undefined
    if (convo.kind === 'direct') {
      const other = members.find((m) => m.did !== sender)
      if (other) {
        await this.assertCanMessage(sender, other.did, {
          recipientAccepted: other.status === 'accepted',
        })
        // A member who left a direct convo gets it back, as a request
        if (other.state !== 'active') {
          reopen = other.did
          other.state = 'active'
          other.status = 'request'
        }
      }
    }
    if (input.replyTo) {
      const target = await this.getMessage(convoId, input.replyTo.messageId)
      if (!target || target.rev < member.joinedRev) {
        throw new InvalidRequestError(
          'Reply target not found',
          'ReplyTargetNotFound',
        )
      }
    }
    const row: MessageTable = {
      id: '',
      convoId,
      senderDid: sender,
      text: input.text,
      facets: input.facets?.length ? JSON.stringify(input.facets) : null,
      embed: input.embed ? JSON.stringify(input.embed) : null,
      replyTo: input.replyTo?.messageId ?? null,
      system: null,
      sentAt: new Date().toISOString(),
      rev: '',
    }
    // Before any write: embeds may need the AppView. The rev is only taken
    // in the transaction, so a slow lookup cannot leave it behind newer revs.
    const [view] = await this.messageViews([row], sender)
    await this.transact(async (svc) => {
      if (reopen) {
        await svc.db
          .updateTable('member')
          .set({ state: 'active', status: 'request' })
          .where('convoId', '=', convoId)
          .where('did', '=', reopen)
          .execute()
      }
      // Replying to a request accepts it
      if (member.status === 'request') {
        await svc.acceptConvo(convoId, sender)
      }
      const rev = nextRev()
      row.id = row.rev = rev
      view.id = view.rev = rev
      await svc.db.insertInto('message').values(row).execute()
      await svc.touchConvo(convoId, rev)
      // The sender has read their own message
      await svc.db
        .updateTable('member')
        .set({ lastReadRev: rev })
        .where('convoId', '=', convoId)
        .where('did', '=', sender)
        .execute()
      await svc.log(svc.activeDids(members), convoId, (r) => ({
        $type: T.log('logCreateMessage'),
        rev: r,
        convoId,
        message: view,
      }))
    })
    void this.pushMessage(convo, members, sender, row.id, input.text).catch(
      (err: unknown) => console.error('Krao chat: push failed', err),
    )
    return view
  }

  /**
   * Pushes a new message to the members who want it: active, the convo not
   * muted, and their chat notification settings (chat, or chatRequest while
   * the convo is a request to them) allowing it.
   */
  private async pushMessage(
    convo: ConvoTable,
    members: MemberTable[],
    sender: string,
    messageId: string,
    text: string | undefined,
  ) {
    if (!this.push) return
    const candidates = members.filter(
      (m) => m.did !== sender && m.state === 'active' && !m.muted,
    )
    if (!candidates.length) return
    const prefRows = await this.db
      .selectFrom('prefs')
      .select(['did', 'prefs'])
      .where(
        'did',
        'in',
        candidates.map((m) => m.did),
      )
      .execute()
    const prefsOf = new Map(prefRows.map((r) => [r.did, r.prefs]))
    const wanted: { did: string; followsOnly: boolean }[] = []
    for (const m of candidates) {
      let pref: { include?: string; push?: boolean } | undefined
      try {
        const all = JSON.parse(prefsOf.get(m.did) ?? '{}')
        pref = m.status === 'request' ? all.chatRequest : all.chat
      } catch {
        pref = undefined
      }
      if (pref?.push === false) continue
      wanted.push({ did: m.did, followsOnly: pref?.include === 'follows' })
    }
    if (!wanted.length) return
    let recipients = wanted.map((w) => w.did)
    if (wanted.some((w) => w.followsOnly)) {
      // followedBy: the member follows the sender
      const rels = await this.appview.getRelationships(sender, recipients)
      recipients = wanted
        .filter((w) => !w.followsOnly || rels.get(w.did)?.followedBy)
        .map((w) => w.did)
    }
    if (!recipients.length) return
    this.push.notify({
      kind: 'chat',
      id: `${convo.id}:${messageId}`,
      recipientDids: recipients,
      senderDid: sender,
      convoId: convo.id,
      messageId,
      text: text ?? '',
      ...(convo.kind === 'group' && convo.name
        ? { groupName: convo.name }
        : {}),
    })
  }

  /** Stores a system message (group events) and logs it to `dids` */
  async systemMessage(
    convoId: string,
    data: Json,
    dids: string[],
    logType: string,
  ) {
    const rev = nextRev()
    const row: MessageTable = {
      id: rev,
      convoId,
      senderDid: null,
      text: null,
      facets: null,
      embed: null,
      replyTo: null,
      system: JSON.stringify(data),
      sentAt: new Date().toISOString(),
      rev,
    }
    await this.db.insertInto('message').values(row).execute()
    await this.touchConvo(convoId, rev)
    const view = this.systemView(row)
    const profiles = await this.referredProfiles(data)
    await this.log(dids, convoId, (r) => ({
      $type: T.log(logType),
      rev: r,
      convoId,
      message: view,
      ...(profiles ? { relatedProfiles: profiles } : {}),
    }))
    return view
  }

  async acceptConvo(convoId: string, did: string) {
    await this.db
      .updateTable('member')
      .set({ status: 'accepted' })
      .where('convoId', '=', convoId)
      .where('did', '=', did)
      .execute()
    let rev = ''
    await this.log([did], convoId, (r) => {
      rev = r
      return { $type: T.log('logAcceptConvo'), rev: r, convoId }
    })
    return rev
  }

  /**
   * Leaves a convo. A direct convo just leaves the member's lists (it comes
   * back if the other member writes); leaving a group tells the others.
   */
  async leaveConvo(convoId: string, did: string) {
    const { convo } = await this.getConvoForViewer(convoId, did)
    if (convo.kind === 'group' && convo.ownerDid === did) {
      throw new InvalidRequestError(
        'The owner cannot leave the group',
        'OwnerCannotLeave',
      )
    }
    const members = await this.listMembers(convoId)
    await this.db
      .updateTable('member')
      .set({ state: 'left' })
      .where('convoId', '=', convoId)
      .where('did', '=', did)
      .execute()
    if (convo.kind === 'group') {
      await this.systemMessage(
        convoId,
        {
          $type: 'chat.bsky.convo.defs#systemMessageDataMemberLeave',
          member: { did },
        },
        this.activeDids(members).filter((d) => d !== did),
        'logMemberLeave',
      )
    }
    let rev = ''
    await this.log([did], convoId, (r) => {
      rev = r
      return { $type: T.log('logLeaveConvo'), rev: r, convoId }
    })
    return rev
  }

  /** Removes the account's chat data: memberships, messages, settings */
  async deleteAccount(did: string) {
    const memberships = await this.db
      .selectFrom('member')
      .select('convoId')
      .where('did', '=', did)
      .execute()
    for (const { convoId } of memberships) {
      await this.leaveConvo(convoId, did).catch(() => {})
    }
    await this.db
      .updateTable('message')
      .set({ text: '', facets: null, embed: null })
      .where('senderDid', '=', did)
      .execute()
    await this.db.deleteFrom('reaction').where('did', '=', did).execute()
    await this.db.deleteFrom('join_request').where('did', '=', did).execute()
    await this.db.deleteFrom('prefs').where('did', '=', did).execute()
    await this.db.deleteFrom('log').where('did', '=', did).execute()
  }

  /** Overridden by the group features: the viewer's pending join requests */
  async pendingJoinRequests(_viewer: string): Promise<Json[]> {
    return []
  }

  async setMuted(convoId: string, did: string, muted: boolean) {
    await this.db
      .updateTable('member')
      .set({ muted: muted ? 1 : 0 })
      .where('convoId', '=', convoId)
      .where('did', '=', did)
      .execute()
    await this.log([did], convoId, (r) => ({
      $type: T.log(muted ? 'logMuteConvo' : 'logUnmuteConvo'),
      rev: r,
      convoId,
    }))
  }

  /** Marks the convo read up to `messageId` (default: everything) */
  async markRead(convoId: string, did: string, messageId?: string) {
    const target = messageId
      ? await this.getMessage(convoId, messageId)
      : await this.db
          .selectFrom('message')
          .selectAll()
          .where('convoId', '=', convoId)
          .orderBy('rev', 'desc')
          .limit(1)
          .executeTakeFirst()
    const { convo } = await this.getConvoForViewer(convoId, did)
    const readRev = target?.rev ?? convo.rev
    await this.db
      .updateTable('member')
      .set({ lastReadRev: readRev })
      .where('convoId', '=', convoId)
      .where('did', '=', did)
      .where('lastReadRev', '<', readRev)
      .execute()
    if (target) {
      const [view] = await this.messageViews([target], did)
      await this.log([did], convoId, (r) => ({
        $type: T.log('logReadMessage'),
        rev: r,
        convoId,
        message: view,
      }))
    }
  }

  async deleteForSelf(convoId: string, did: string, messageId: string) {
    await this.getConvoForViewer(convoId, did)
    const message = await this.getMessage(convoId, messageId)
    if (!message || message.senderDid === null) {
      throw new InvalidRequestError(
        'Message cannot be deleted',
        'MessageDeleteNotAllowed',
      )
    }
    await this.db
      .insertInto('hidden_message')
      .values({ messageId, did })
      .onConflict((oc) => oc.doNothing())
      .execute()
    const view = this.deletedView(message)
    await this.log([did], convoId, (r) => ({
      $type: T.log('logDeleteMessage'),
      rev: r,
      convoId,
      message: view,
    }))
    return view
  }

  async react(
    convoId: string,
    did: string,
    messageId: string,
    value: string,
    add: boolean,
  ) {
    const { member } = await this.getConvoForViewer(convoId, did)
    if (countGraphemes(value) !== 1 || /^[\p{L}\p{N}\s]$/u.test(value)) {
      throw new InvalidRequestError(
        'A reaction must be a single emoji',
        'ReactionInvalidValue',
      )
    }
    const message = await this.getMessage(convoId, messageId)
    if (
      !message ||
      message.senderDid === null ||
      message.rev < member.joinedRev
    ) {
      throw new InvalidRequestError(
        'This message cannot be reacted to',
        'ReactionNotAllowed',
      )
    }
    if (await this.isHidden(messageId, did)) {
      throw new InvalidRequestError(
        'This message was deleted',
        'ReactionMessageDeleted',
      )
    }
    const reaction = {
      value,
      sender: { did },
      createdAt: new Date().toISOString(),
    }
    const mine = await this.db
      .selectFrom('reaction')
      .select('value')
      .where('messageId', '=', messageId)
      .where('did', '=', did)
      .execute()
    // Before any write: embeds may need the AppView
    const [before] = await this.messageViews([message], did)
    if (add && mine.some((r) => r.value === value)) return before
    if (add && mine.length >= REACTION_LIMIT) {
      throw new InvalidRequestError(
        `At most ${REACTION_LIMIT} reactions per message`,
        'ReactionLimitReached',
      )
    }
    const others = ((before.reactions ?? []) as Json[]).filter(
      (r) =>
        !(r.value === value && (r.sender as { did?: string })?.did === did),
    )
    const view = { ...before, reactions: add ? [...others, reaction] : others }
    await this.transact(async (svc) => {
      const rev = nextRev()
      if (add) {
        await svc.db
          .insertInto('reaction')
          .values({
            messageId,
            convoId,
            did,
            value,
            createdAt: reaction.createdAt,
            rev,
          })
          .execute()
      } else {
        await svc.db
          .deleteFrom('reaction')
          .where('messageId', '=', messageId)
          .where('did', '=', did)
          .where('value', '=', value)
          .execute()
      }
      await svc.touchConvo(convoId, rev)
      const members = await svc.listMembers(convoId)
      await svc.log(svc.activeDids(members), convoId, (r) => ({
        $type: T.log(add ? 'logAddReaction' : 'logRemoveReaction'),
        rev: r,
        convoId,
        message: view,
        reaction,
      }))
    })
    return view
  }

  /*
   * Views
   */

  profileView(
    did: string,
    profile: AppviewProfile | null | undefined,
    kind?: Json,
    /** A moderator cut the account off from chat */
    chatDisabled = false,
  ): Json {
    return {
      did,
      handle: profile?.handle ?? 'handle.invalid',
      ...(profile?.displayName ? { displayName: profile.displayName } : {}),
      ...(profile?.avatar ? { avatar: profile.avatar } : {}),
      ...(profile?.associated ? { associated: profile.associated } : {}),
      labels: profile?.labels ?? [],
      ...(profile?.createdAt ? { createdAt: profile.createdAt } : {}),
      ...(profile?.verification ? { verification: profile.verification } : {}),
      chatDisabled,
      ...(kind ? { kind } : {}),
    }
  }

  /** Members a convo view lists: everyone in a direct convo, active ones in a group */
  private shownMembers(convo: ConvoTable, members: MemberTable[]) {
    return convo.kind === 'direct'
      ? members
      : members.filter((m) => m.state === 'active')
  }

  /** DIDs among `dids` a moderator cut off from chat */
  private async chatDisabledDids(dids: string[]) {
    if (!dids.length) return new Set<string>()
    const rows = await this.db
      .selectFrom('actor_access')
      .select('did')
      .where('did', 'in', [...new Set(dids)])
      .where('allowAccess', '=', 0)
      .execute()
    return new Set(rows.map((r) => r.did))
  }

  async memberViews(
    convo: ConvoTable,
    members: MemberTable[],
    prefetched?: {
      profiles: Map<string, AppviewProfile | null>
      disabled: Set<string>
    },
  ) {
    const shown = this.shownMembers(convo, members)
    const addedBy = shown.map((m) => m.addedBy).filter((d): d is string => !!d)
    const profiles =
      prefetched?.profiles ??
      (await this.appview.getProfiles([...shown.map((m) => m.did), ...addedBy]))
    const disabled =
      prefetched?.disabled ??
      (await this.chatDisabledDids(shown.map((m) => m.did)))
    return shown.map((m) =>
      this.profileView(
        m.did,
        profiles.get(m.did),
        convo.kind === 'direct'
          ? { $type: T.directMember }
          : {
              $type: T.groupMember,
              role: m.role ?? 'standard',
              ...(m.addedBy
                ? {
                    addedBy: this.profileView(
                      m.addedBy,
                      profiles.get(m.addedBy),
                    ),
                  }
                : {}),
            },
        disabled.has(m.did),
      ),
    )
  }

  deletedView(row: MessageTable): Json {
    return {
      $type: T.deletedMessageView,
      id: row.id,
      rev: row.rev,
      sender: { did: row.senderDid ?? '' },
      sentAt: row.sentAt,
    }
  }

  systemView(row: MessageTable): Json {
    return {
      $type: T.systemMessageView,
      id: row.id,
      rev: row.rev,
      sentAt: row.sentAt,
      data: JSON.parse(row.system ?? '{}'),
    }
  }

  /** Profiles of the users a system message refers to */
  async referredProfiles(data: Json) {
    const dids = new Set(referredDids(data))
    if (!dids.size) return undefined
    const profiles = await this.appview.getProfiles([...dids])
    return [...dids].map((did) => this.profileView(did, profiles.get(did)))
  }

  /** Views of `rows` as `viewer` sees them, with reactions, replies, embeds */
  async messageViews(rows: MessageTable[], viewer: string): Promise<Json[]> {
    if (!rows.length) return []
    const ids = rows.map((r) => r.id)
    const replyIds = rows
      .map((r) => r.replyTo)
      .filter((id): id is string => !!id)
    const hidden = new Set(
      (
        await this.db
          .selectFrom('hidden_message')
          .select('messageId')
          .where('did', '=', viewer)
          .where('messageId', 'in', [...ids, ...replyIds, ''])
          .execute()
      ).map((r) => r.messageId),
    )
    const reactions = await this.db
      .selectFrom('reaction')
      .selectAll()
      .where('messageId', 'in', ids)
      .orderBy('rev', 'asc')
      .execute()
    const replies = new Map(
      (replyIds.length
        ? await this.db
            .selectFrom('message')
            .selectAll()
            .where('id', 'in', replyIds)
            .execute()
        : []
      ).map((r) => [r.id, r]),
    )
    const convoIds = [...new Set(rows.map((r) => r.convoId))]
    const joinedRevs = new Map(
      (
        await this.db
          .selectFrom('member')
          .select(['convoId', 'joinedRev'])
          .where('did', '=', viewer)
          .where('convoId', 'in', convoIds)
          .execute()
      ).map((m) => [m.convoId, m.joinedRev]),
    )
    const embeds = await this.embedViews(
      [...rows, ...replies.values()].map((r) => r.embed),
    )

    const view = (row: MessageTable, withReply: boolean): Json => {
      if (row.system) return this.systemView(row)
      if (hidden.has(row.id)) return this.deletedView(row)
      const reply = row.replyTo ? replies.get(row.replyTo) : undefined
      let replyTo: Json | undefined
      if (withReply && row.replyTo) {
        if (!reply || hidden.has(reply.id)) {
          replyTo = reply ? this.deletedView(reply) : undefined
        } else if (reply.rev < (joinedRevs.get(row.convoId) ?? '')) {
          replyTo = { $type: T.beforeJoined }
        } else {
          replyTo = view(reply, false)
        }
      }
      const embed = row.embed ? embeds.get(row.embed) : undefined
      return {
        $type: T.messageView,
        id: row.id,
        rev: row.rev,
        text: row.text ?? '',
        ...(row.facets ? { facets: JSON.parse(row.facets) } : {}),
        ...(embed ? { embed } : {}),
        reactions: reactions
          .filter((r) => r.messageId === row.id)
          .map((r) => ({
            value: r.value,
            sender: { did: r.did },
            createdAt: r.createdAt,
          })),
        ...(replyTo ? { replyTo } : {}),
        sender: { did: row.senderDid },
        sentAt: row.sentAt,
      }
    }
    return rows.map((row) => view(row, true))
  }

  /** Views of message embeds, keyed by their stored JSON */
  async embedViews(embeds: (string | null)[]): Promise<Map<string, Json>> {
    const out = new Map<string, Json>()
    const records = new Map<string, string>()
    for (const json of new Set(embeds)) {
      if (!json) continue
      const embed = JSON.parse(json) as Json
      if (embed.$type === 'app.bsky.embed.record') {
        const uri = (embed.record as { uri?: string })?.uri
        if (uri) records.set(json, uri)
      } else if (embed.$type === 'chat.bsky.embed.joinLink') {
        const code = embed.code as string
        const [preview] = await this.joinLinkPreviews([code])
        out.set(json, {
          $type: 'chat.bsky.embed.joinLink#view',
          joinLinkPreview: preview,
        })
      }
    }
    if (records.size) {
      const posts = await this.appview
        .getPosts([...new Set(records.values())])
        .catch(() => new Map<string, Json>())
      for (const [json, uri] of records) {
        const post = posts.get(uri)
        out.set(json, {
          $type: 'app.bsky.embed.record#view',
          record: post
            ? {
                $type: 'app.bsky.embed.record#viewRecord',
                uri: post.uri,
                cid: post.cid,
                author: post.author,
                value: post.record,
                labels: post.labels ?? [],
                ...(post.embed ? { embeds: [post.embed] } : {}),
                likeCount: post.likeCount,
                replyCount: post.replyCount,
                repostCount: post.repostCount,
                quoteCount: post.quoteCount,
                indexedAt: post.indexedAt,
              }
            : {
                $type: 'app.bsky.embed.record#viewNotFound',
                uri,
                notFound: true,
              },
        })
      }
    }
    return out
  }

  /** Overridden by the group features, which own join links */
  async joinLinkPreviews(codes: string[]): Promise<Json[]> {
    return codes.map((code) => ({
      $type: 'chat.bsky.group.defs#invalidJoinLinkPreviewView',
      code,
    }))
  }

  /**
   * The viewer's active convos that have unread messages, with their unread
   * count, in one query (for badges and "mark all read").
   */
  async unreadConvos(viewer: string) {
    const rows = await this.db
      .selectFrom('member')
      .innerJoin('convo', 'convo.id', 'member.convoId')
      .innerJoin('message', 'message.convoId', 'member.convoId')
      .select([
        'member.convoId as convoId',
        'member.status as status',
        'member.muted as muted',
        'convo.kind as kind',
      ])
      .select((eb) => eb.fn.countAll<number>().as('unread'))
      .where('member.did', '=', viewer)
      .where('member.state', '=', 'active')
      .whereRef('message.rev', '>', 'member.lastReadRev')
      .whereRef('message.rev', '>=', 'member.joinedRev')
      .where((eb) =>
        eb.or([
          eb('message.senderDid', 'is', null),
          eb('message.senderDid', '!=', viewer),
        ]),
      )
      .where('message.id', 'not in', (qb) =>
        qb
          .selectFrom('hidden_message')
          .select('messageId')
          .where('did', '=', viewer),
      )
      .groupBy([
        'member.convoId',
        'member.status',
        'member.muted',
        'convo.kind',
      ])
      .execute()
    return rows.map((r) => ({ ...r, unread: Number(r.unread) }))
  }

  /** Messages in the convo the member can see, ignoring per-viewer hiding */
  async unreadCount(convoId: string, member: MemberTable) {
    const row = await this.db
      .selectFrom('message')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('convoId', '=', convoId)
      .where('rev', '>', member.lastReadRev)
      .where('rev', '>=', member.joinedRev)
      .where((eb) =>
        eb.or([eb('senderDid', 'is', null), eb('senderDid', '!=', member.did)]),
      )
      .where('id', 'not in', (qb) =>
        qb
          .selectFrom('hidden_message')
          .select('messageId')
          .where('did', '=', member.did),
      )
      .executeTakeFirst()
    return Number(row?.count ?? 0)
  }

  async hasMessages(convoId: string) {
    const row = await this.db
      .selectFrom('message')
      .select('id')
      .where('convoId', '=', convoId)
      .limit(1)
      .executeTakeFirst()
    return !!row
  }

  /** Extra fields of a group's convo view; set by the group features */
  groupConvoKind: (convo: ConvoTable, viewer: MemberTable) => Promise<Json> =
    async (convo) => ({
      $type: T.groupConvo,
      createdAt: convo.createdAt,
      lockStatus: convo.lockStatus,
      lockStatusModerationOverride: false,
      memberCount: 0,
      memberLimit: convo.memberLimit,
      name: convo.name ?? '',
    })

  async convoView(convo: ConvoTable, viewer: string): Promise<Json> {
    const [view] = await this.convoViews([convo], viewer)
    return view
  }

  /**
   * Views of `convos` for `viewer`, in the same order. One set of queries
   * for the whole page: members, each convo's last message and reaction
   * (window functions), unread counts, and one AppView profile lookup.
   */
  async convoViews(convos: ConvoTable[], viewer: string): Promise<Json[]> {
    if (!convos.length) return []
    const ids = convos.map((c) => c.id)
    const allMembers = await this.db
      .selectFrom('member')
      .selectAll()
      .where('convoId', 'in', ids)
      .execute()
    const membersOf = new Map<string, MemberTable[]>()
    for (const m of allMembers) {
      membersOf.set(m.convoId, [...(membersOf.get(m.convoId) ?? []), m])
    }
    // The latest row per convo: max(rev) is one seek on the (convoId, rev)
    // indexes, where a window function would rank every row
    const lastMessages = new Map(
      (
        await sql<MessageTable>`select * from message m where m."convoId" in (${sql.join(
          ids,
        )}) and m.rev = (select max(rev) from message where "convoId" = m."convoId")`.execute(
          this.db,
        )
      ).rows.map((r) => [r.convoId, r]),
    )
    const lastReactions = new Map(
      (
        await sql<ReactionTable>`select * from reaction r where r."convoId" in (${sql.join(
          ids,
        )}) and r.rev = (select max(rev) from reaction where "convoId" = r."convoId")`.execute(
          this.db,
        )
      ).rows.map((r) => [r.convoId, r]),
    )
    // One convo (most routes): count just that one
    const unread = new Map<string, number>()
    if (convos.length === 1) {
      const me = membersOf.get(ids[0])?.find((m) => m.did === viewer)
      if (me) unread.set(ids[0], await this.unreadCount(ids[0], me))
    } else {
      for (const u of await this.unreadConvos(viewer)) {
        unread.set(u.convoId, u.unread)
      }
    }

    // Each convo's visible last message, and the messages last reacted to
    const lastRows = new Map<string, MessageTable>()
    for (const convo of convos) {
      const me = membersOf.get(convo.id)?.find((m) => m.did === viewer)
      const last = lastMessages.get(convo.id)
      if (me && last && last.rev >= me.joinedRev) lastRows.set(convo.id, last)
    }
    const joinedRevOf = (convoId: string) =>
      membersOf.get(convoId)?.find((m) => m.did === viewer)?.joinedRev ?? ''
    const targetIds = [...lastReactions.values()]
      .filter((r) => {
        const last = lastRows.get(r.convoId)
        return (!last || r.rev > last.rev) && r.rev >= joinedRevOf(r.convoId)
      })
      .map((r) => r.messageId)
    // Not messages from before the viewer joined (a group's history)
    const targets = (
      targetIds.length
        ? await this.db
            .selectFrom('message')
            .selectAll()
            .where('id', 'in', targetIds)
            .execute()
        : []
    ).filter((m) => m.rev >= joinedRevOf(m.convoId))
    const rowsToView = [...lastRows.values(), ...targets]
    const views = new Map(
      (await this.messageViews(rowsToView, viewer)).map((v, i) => [
        rowsToView[i].id,
        v,
      ]),
    )

    // One profile lookup for every member shown on the page
    const shownDids = convos.flatMap((c) =>
      this.shownMembers(c, membersOf.get(c.id) ?? []).flatMap((m) =>
        m.addedBy ? [m.did, m.addedBy] : [m.did],
      ),
    )
    const profiles = await this.appview.getProfiles(shownDids)
    const disabled = await this.chatDisabledDids(shownDids)

    const out: Json[] = []
    for (const convo of convos) {
      const members = membersOf.get(convo.id) ?? []
      const me = members.find((m) => m.did === viewer)
      if (!me) throw new InvalidRequestError('Convo not found', 'InvalidConvo')
      const last = lastRows.get(convo.id)
      const lastMessage = last ? views.get(last.id) : undefined
      const reactionRow = lastReactions.get(convo.id)
      let lastReaction: Json | undefined
      if (reactionRow && (!last || reactionRow.rev > last.rev)) {
        const message = views.get(reactionRow.messageId)
        if (message?.$type === T.messageView) {
          lastReaction = {
            $type: T.messageAndReactionView,
            message,
            reaction: {
              value: reactionRow.value,
              sender: { did: reactionRow.did },
              createdAt: reactionRow.createdAt,
            },
          }
        }
      }
      out.push({
        id: convo.id,
        rev: convo.rev,
        members: await this.memberViews(convo, members, {
          profiles,
          disabled,
        }),
        ...(lastMessage ? { lastMessage } : {}),
        ...(lastReaction ? { lastReaction } : {}),
        muted: !!me.muted,
        status: me.status,
        unreadCount: unread.get(convo.id) ?? 0,
        kind:
          convo.kind === 'direct'
            ? { $type: T.directConvo }
            : await this.groupConvoKind(convo, me),
      })
    }
    return out
  }

  /*
   * Lists
   */

  /** The viewer's active convos, newest activity first */
  async listConvos(
    viewer: string,
    opts: {
      limit: number
      cursor?: string
      status?: string
      readState?: string
      kind?: string
      lockStatus?: string
    },
  ) {
    let qb = this.db
      .selectFrom('convo')
      .innerJoin('member', 'member.convoId', 'convo.id')
      .selectAll('convo')
      .select(['member.status as memberStatus'])
      .where('member.did', '=', viewer)
      .where('member.state', '=', 'active')
      .orderBy('convo.rev', 'desc')
    if (opts.cursor) qb = qb.where('convo.rev', '<', opts.cursor)
    if (opts.status)
      qb = qb.where('member.status', '=', opts.status as MemberStatus)
    if (opts.kind) qb = qb.where('convo.kind', '=', opts.kind as 'direct')
    if (opts.lockStatus) {
      qb = qb.where('convo.lockStatus', '=', opts.lockStatus as 'unlocked')
    }
    // Direct convos without messages yet stay out of the lists
    qb = qb.where((eb) =>
      eb.or([
        eb('convo.kind', '!=', 'direct'),
        eb.exists(
          eb
            .selectFrom('message')
            .select('message.id')
            .whereRef('message.convoId', '=', 'convo.id'),
        ),
      ]),
    )
    if (opts.readState === 'unread') {
      const unread = (await this.unreadConvos(viewer)).map((r) => r.convoId)
      if (!unread.length) return { convos: [], cursor: undefined }
      qb = qb.where('convo.id', 'in', unread)
    }
    const rows = await qb.limit(opts.limit).execute()
    const convos = await this.convoViews(rows, viewer)
    return {
      convos,
      cursor: rows.length >= opts.limit ? rows.at(-1)?.rev : undefined,
    }
  }

  /**
   * Drop log entries older than `maxAgeMs` (90 days). Clients sync from a
   * recent cursor; one that old has long reloaded its convo list.
   */
  async pruneLog(maxAgeMs = 90 * 24 * 60 * 60 * 1000) {
    // Revs are microsecond timestamps in base 36 (see rev.ts)
    const cutoff = (BigInt(Date.now() - maxAgeMs) * 1000n)
      .toString(36)
      .padStart(12, '0')
    await this.db.deleteFrom('log').where('rev', '<', cutoff).execute()
  }

  async getLog(viewer: string, cursor?: string) {
    if (!cursor) return { logs: [], cursor: currentRev() }
    const rows = await this.db
      .selectFrom('log')
      .selectAll()
      .where('did', '=', viewer)
      .where('rev', '>', cursor)
      .orderBy('rev', 'asc')
      .limit(100)
      .execute()
    return {
      logs: rows.map((r) => ({ ...JSON.parse(r.data), rev: r.rev })),
      cursor: rows.length ? rows[rows.length - 1].rev : cursor,
    }
  }

  async getMessages(
    convoId: string,
    viewer: string,
    opts: { limit: number; cursor?: string },
  ) {
    const { member } = await this.getConvoForViewer(convoId, viewer)
    let qb = this.db
      .selectFrom('message')
      .selectAll()
      .where('convoId', '=', convoId)
      .where('rev', '>=', member.joinedRev)
      .orderBy('rev', 'desc')
      .limit(opts.limit)
    if (opts.cursor) qb = qb.where('rev', '<', opts.cursor)
    const rows = await qb.execute()
    const messages = await this.messageViews(rows, viewer)
    return {
      messages,
      relatedProfiles: await this.relatedProfiles(rows, messages),
      cursor:
        rows.length === opts.limit ? rows[rows.length - 1].rev : undefined,
    }
  }

  /**
   * Everyone who authored or reacted to `messages`, plus the users system
   * messages refer to. Former members are included so a "left the group"
   * message in the history can still show their name.
   */
  async relatedProfiles(rows: MessageTable[], messages: Json[]) {
    const dids = new Set<string>()
    for (const row of rows) {
      if (row.senderDid) dids.add(row.senderDid)
      if (row.system) {
        for (const did of referredDids(JSON.parse(row.system))) dids.add(did)
      }
    }
    for (const message of messages) {
      const reactions = (message as { reactions?: unknown }).reactions
      if (!Array.isArray(reactions)) continue
      for (const reaction of reactions) {
        const did = (reaction as { sender?: { did?: unknown } })?.sender?.did
        if (typeof did === 'string') dids.add(did)
      }
    }
    if (!dids.size) return []
    const profiles = await this.appview.getProfiles([...dids])
    return [...dids].map((did) => this.profileView(did, profiles.get(did)))
  }
}

/** DIDs of the users a system message's data refers to, e.g. `{member: {did}}` */
function referredDids(data: Json): string[] {
  const dids: string[] = []
  for (const value of Object.values(data)) {
    const did = (value as { did?: unknown })?.did
    if (typeof did === 'string') dids.push(did)
  }
  return dids
}

function isUniqueViolation(err: unknown) {
  return String((err as { code?: unknown })?.code).startsWith(
    'SQLITE_CONSTRAINT',
  )
}
