import { InvalidRequestError } from '@atproto/xrpc-server'
import { countGraphemes } from 'unicode-segmenter/grapheme'
import type { Appview, AppviewProfile } from './appview.js'
import type {
  ConvoTable,
  Database,
  MemberStatus,
  MemberTable,
  MessageTable,
} from './db.js'
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
  constructor(
    public db: Database,
    public appview: Appview,
  ) {}

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

  async createDirectConvo(creator: string, other: string) {
    const id = randomId()
    const rev = nextRev()
    await this.db
      .insertInto('convo')
      .values({
        id,
        kind: 'direct',
        name: null,
        ownerDid: null,
        directKey: [creator, other].sort().join(' '),
        lockStatus: 'unlocked',
        memberLimit: 2,
        createdAt: new Date().toISOString(),
        rev,
      })
      .execute()
    const otherStatus: MemberStatus = (await this.follows(other, creator))
      ? 'accepted'
      : 'request'
    for (const [did, status] of [
      [creator, 'accepted'],
      [other, otherStatus],
    ] as const) {
      await this.db
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
    await this.log([creator], id, (r) => ({
      $type: T.log('logBeginConvo'),
      rev: r,
      convoId: id,
    }))
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
    if (convo.lockStatus !== 'unlocked') {
      throw new InvalidRequestError('This convo is locked', 'ConvoLocked')
    }
    const members = await this.listMembers(convoId)
    if (convo.kind === 'direct') {
      const other = members.find((m) => m.did !== sender)
      if (other) {
        await this.assertCanMessage(sender, other.did, {
          recipientAccepted: other.status === 'accepted',
        })
        // A member who left a direct convo gets it back, as a request
        if (other.state !== 'active') {
          await this.db
            .updateTable('member')
            .set({ state: 'active', status: 'request' })
            .where('convoId', '=', convoId)
            .where('did', '=', other.did)
            .execute()
          other.state = 'active'
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
    // Replying to a request accepts it
    if (member.status === 'request') {
      await this.acceptConvo(convoId, sender)
    }
    const rev = nextRev()
    const row: MessageTable = {
      id: rev,
      convoId,
      senderDid: sender,
      text: input.text,
      facets: input.facets?.length ? JSON.stringify(input.facets) : null,
      embed: input.embed ? JSON.stringify(input.embed) : null,
      replyTo: input.replyTo?.messageId ?? null,
      system: null,
      sentAt: new Date().toISOString(),
      rev,
    }
    await this.db.insertInto('message').values(row).execute()
    await this.touchConvo(convoId, rev)
    // The sender has read their own message
    await this.db
      .updateTable('member')
      .set({ lastReadRev: rev })
      .where('convoId', '=', convoId)
      .where('did', '=', sender)
      .execute()
    const [view] = await this.messageViews([row], sender)
    await this.log(this.activeDids(members), convoId, (r) => ({
      $type: T.log('logCreateMessage'),
      rev: r,
      convoId,
      message: view,
    }))
    return view
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
    const rev = nextRev()
    const reaction = {
      value,
      sender: { did },
      createdAt: new Date().toISOString(),
    }
    if (add) {
      const mine = await this.db
        .selectFrom('reaction')
        .select('value')
        .where('messageId', '=', messageId)
        .where('did', '=', did)
        .execute()
      if (mine.some((r) => r.value === value)) {
        const [view] = await this.messageViews([message], did)
        return view
      }
      if (mine.length >= REACTION_LIMIT) {
        throw new InvalidRequestError(
          `At most ${REACTION_LIMIT} reactions per message`,
          'ReactionLimitReached',
        )
      }
      await this.db
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
      await this.db
        .deleteFrom('reaction')
        .where('messageId', '=', messageId)
        .where('did', '=', did)
        .where('value', '=', value)
        .execute()
    }
    await this.touchConvo(convoId, rev)
    const [view] = await this.messageViews([message], did)
    const members = await this.listMembers(convoId)
    await this.log(this.activeDids(members), convoId, (r) => ({
      $type: T.log(add ? 'logAddReaction' : 'logRemoveReaction'),
      rev: r,
      convoId,
      message: view,
      reaction,
    }))
    return view
  }

  /*
   * Views
   */

  profileView(
    did: string,
    profile: AppviewProfile | null | undefined,
    kind?: Json,
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
      chatDisabled: false,
      ...(kind ? { kind } : {}),
    }
  }

  async memberViews(convo: ConvoTable, members: MemberTable[]) {
    const shown =
      convo.kind === 'direct'
        ? members
        : members.filter((m) => m.state === 'active')
    const addedBy = shown.map((m) => m.addedBy).filter((d): d is string => !!d)
    const profiles = await this.appview.getProfiles([
      ...shown.map((m) => m.did),
      ...addedBy,
    ])
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
    const member = await this.getMember(rows[0].convoId, viewer)
    const joinedRev = member?.joinedRev ?? ''
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
        } else if (reply.rev < joinedRev) {
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
    const members = await this.listMembers(convo.id)
    const me = members.find((m) => m.did === viewer)
    if (!me) throw new InvalidRequestError('Convo not found', 'InvalidConvo')
    const last = await this.db
      .selectFrom('message')
      .selectAll()
      .where('convoId', '=', convo.id)
      .where('rev', '>=', me.joinedRev)
      .orderBy('rev', 'desc')
      .limit(1)
      .executeTakeFirst()
    const [lastMessage] = last ? await this.messageViews([last], viewer) : []
    const lastReactionRow = await this.db
      .selectFrom('reaction')
      .selectAll()
      .where('convoId', '=', convo.id)
      .orderBy('rev', 'desc')
      .limit(1)
      .executeTakeFirst()
    let lastReaction: Json | undefined
    if (lastReactionRow && (!last || lastReactionRow.rev > last.rev)) {
      const target = await this.getMessage(convo.id, lastReactionRow.messageId)
      const [message] = target ? await this.messageViews([target], viewer) : []
      if (message?.$type === T.messageView) {
        lastReaction = {
          $type: T.messageAndReactionView,
          message,
          reaction: {
            value: lastReactionRow.value,
            sender: { did: lastReactionRow.did },
            createdAt: lastReactionRow.createdAt,
          },
        }
      }
    }
    return {
      id: convo.id,
      rev: convo.rev,
      members: await this.memberViews(convo, members),
      ...(lastMessage ? { lastMessage } : {}),
      ...(lastReaction ? { lastReaction } : {}),
      muted: !!me.muted,
      status: me.status,
      unreadCount: await this.unreadCount(convo.id, me),
      kind:
        convo.kind === 'direct'
          ? { $type: T.directConvo }
          : await this.groupConvoKind(convo, me),
    }
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
    const convos: Json[] = []
    let cursor: string | undefined
    // Direct convos without messages yet stay out of the lists
    for (const row of await qb.execute()) {
      if (row.kind === 'direct' && !(await this.hasMessages(row.id))) continue
      const view = await this.convoView(row, viewer)
      if (opts.readState === 'unread' && !(view.unreadCount as number)) continue
      convos.push(view)
      cursor = row.rev
      if (convos.length >= opts.limit) break
    }
    return { convos, cursor: convos.length >= opts.limit ? cursor : undefined }
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
