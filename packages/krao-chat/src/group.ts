import { InvalidRequestError, type Server } from '@atproto/xrpc-server'
import type { ConvoTable, JoinLinkTable, MemberTable } from './db.js'
import { chat } from './lexicons/index.js'
import { nextRev, randomId } from './rev.js'
import { type ChatAuth, json } from './server.js'
import { type ChatService, GROUP_MEMBER_LIMIT } from './service.js'

type Json = Record<string, unknown>

const SYS = (name: string) => `chat.bsky.convo.defs#systemMessageData${name}`

function joinLinkView(link: JoinLinkTable): Json {
  return {
    code: link.code,
    enabledStatus: link.enabled ? 'enabled' : 'disabled',
    requireApproval: !!link.requireApproval,
    joinRule: link.joinRule,
    createdAt: link.createdAt,
  }
}

/**
 * Group chats: creating groups, members, locks, join links and join
 * requests. Groups share the convo tables with direct chats.
 */
export function addGroupRoutes(
  server: Server,
  service: ChatService,
  auth: ChatAuth,
) {
  const { db, appview } = service

  /** The group and the viewer's membership; `owner` requires the owner */
  async function getGroup(convoId: string, viewer: string, owner = false) {
    const { convo, member } = await service.getConvoForViewer(convoId, viewer)
    if (convo.kind !== 'group') {
      throw new InvalidRequestError('Not a group convo', 'InvalidConvo')
    }
    if (owner && convo.ownerDid !== viewer) {
      throw new InvalidRequestError(
        'Only the group owner can do this',
        'InsufficientRole',
      )
    }
    return { convo, member }
  }

  const getJoinLink = (convoId: string) =>
    db
      .selectFrom('join_link')
      .selectAll()
      .where('convoId', '=', convoId)
      .executeTakeFirst()

  const activeMembers = async (convoId: string) =>
    (await service.listMembers(convoId)).filter((m) => m.state === 'active')

  /**
   * Throws unless `adder` may add `did` to a group: the account exists, no
   * block either way, and its allowGroupInvites setting (all, following or
   * none; default: its allowIncoming setting) lets the adder in.
   */
  async function assertCanAdd(adder: string, did: string) {
    const profile = await appview.getProfile(did)
    if (!profile) {
      throw new InvalidRequestError('Account not found', 'RecipientNotFound')
    }
    const rel = (await appview.getRelationships(adder, [did])).get(did)
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
    const chatPrefs = profile.associated?.chat
    const allow =
      chatPrefs?.allowGroupInvites ?? chatPrefs?.allowIncoming ?? 'following'
    if (allow === 'none') {
      throw new InvalidRequestError(
        'This account does not accept group invites',
        'UserForbidsGroups',
      )
    }
    if (allow === 'following' && !rel?.followedBy) {
      throw new InvalidRequestError(
        'This account only accepts invites from people it follows',
        'NotFollowedBySender',
      )
    }
  }

  /** Adds (or re-adds) a member and announces it to the group */
  async function addMember(
    convo: ConvoTable,
    did: string,
    opts: {
      role: 'owner' | 'standard'
      status: 'request' | 'accepted'
      addedBy?: string
      approvedBy?: string
      viaJoinLink?: boolean
    },
  ) {
    const rev = nextRev()
    const row: MemberTable = {
      convoId: convo.id,
      did,
      role: opts.role,
      status: opts.status,
      state: 'active',
      muted: 0,
      addedBy: opts.addedBy ?? null,
      joinedRev: rev,
      lastReadRev: rev,
    }
    await db
      .insertInto('member')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['convoId', 'did']).doUpdateSet({
          role: row.role,
          status: row.status,
          state: 'active',
          addedBy: row.addedBy,
          joinedRev: rev,
          lastReadRev: rev,
        }),
      )
      .execute()
    const dids = (await activeMembers(convo.id)).map((m) => m.did)
    if (opts.role === 'owner') return
    if (opts.viaJoinLink) {
      await service.systemMessage(
        convo.id,
        {
          $type: SYS('MemberJoin'),
          member: { did },
          role: opts.role,
          ...(opts.approvedBy ? { approvedBy: { did: opts.approvedBy } } : {}),
        },
        dids,
        'logMemberJoin',
      )
    } else {
      await service.systemMessage(
        convo.id,
        {
          $type: SYS('AddMember'),
          member: { did },
          role: opts.role,
          addedBy: { did: opts.addedBy ?? convo.ownerDid ?? did },
        },
        dids,
        'logAddMember',
      )
    }
  }

  async function memberCount(convoId: string) {
    return (await activeMembers(convoId)).length
  }

  async function assertRoom(convo: ConvoTable, adding: number) {
    if ((await memberCount(convo.id)) + adding > convo.memberLimit) {
      throw new InvalidRequestError(
        `Groups can have at most ${convo.memberLimit} members`,
        'MemberLimitReached',
      )
    }
  }

  function assertUnlocked(convo: ConvoTable) {
    if (convo.lockStatus !== 'unlocked') {
      throw new InvalidRequestError('This group is locked', 'ConvoLocked')
    }
  }

  async function ownerView(convo: ConvoTable) {
    const owner = convo.ownerDid ?? ''
    return service.profileView(owner, await appview.getProfile(owner))
  }

  /*
   * Views the base service leaves to the group features
   */

  service.groupConvoKind = async (convo, viewer) => {
    const link = await getJoinLink(convo.id)
    const isOwner = convo.ownerDid === viewer.did
    const requests = isOwner
      ? await db
          .selectFrom('join_request')
          .select(['read'])
          .where('convoId', '=', convo.id)
          .execute()
      : []
    return {
      $type: 'chat.bsky.convo.defs#groupConvo',
      createdAt: convo.createdAt,
      ...(link ? { joinLink: joinLinkView(link) } : {}),
      ...(isOwner
        ? {
            joinRequestCount: requests.length,
            unreadJoinRequestCount: requests.filter((r) => !r.read).length,
          }
        : {}),
      lockStatus: convo.lockStatus,
      lockStatusModerationOverride: false,
      memberCount: await memberCount(convo.id),
      memberLimit: convo.memberLimit,
      name: convo.name ?? '',
    }
  }

  service.pendingJoinRequests = async (viewer) => {
    const rows = await db
      .selectFrom('join_request')
      .innerJoin('convo', 'convo.id', 'join_request.convoId')
      .selectAll('convo')
      .select(['join_request.requestedAt'])
      .where('join_request.did', '=', viewer)
      .execute()
    const out: Json[] = []
    for (const row of rows) {
      out.push({
        $type: 'chat.bsky.group.defs#joinRequestConvoView',
        convoId: row.id,
        name: row.name ?? '',
        owner: await ownerView(row),
        memberCount: await memberCount(row.id),
        memberLimit: row.memberLimit,
        viewer: { requestedAt: row.requestedAt },
      })
    }
    return out
  }

  const previewFor = async (code: string, viewer?: string): Promise<Json> => {
    const link = await db
      .selectFrom('join_link')
      .selectAll()
      .where('code', '=', code)
      .executeTakeFirst()
    const convo =
      link &&
      (await db
        .selectFrom('convo')
        .selectAll()
        .where('id', '=', link.convoId)
        .executeTakeFirst())
    if (!link || !convo) {
      return { $type: 'chat.bsky.group.defs#invalidJoinLinkPreviewView', code }
    }
    if (!link.enabled) {
      return { $type: 'chat.bsky.group.defs#disabledJoinLinkPreviewView', code }
    }
    const member = viewer
      ? await service.getMember(convo.id, viewer)
      : undefined
    const request = viewer
      ? await db
          .selectFrom('join_request')
          .select('requestedAt')
          .where('convoId', '=', convo.id)
          .where('did', '=', viewer)
          .executeTakeFirst()
      : undefined
    return {
      $type: 'chat.bsky.group.defs#joinLinkPreviewView',
      convoId: convo.id,
      code,
      name: convo.name ?? '',
      owner: await ownerView(convo),
      memberCount: await memberCount(convo.id),
      memberLimit: convo.memberLimit,
      requireApproval: !!link.requireApproval,
      joinRule: link.joinRule,
      ...(member?.state === 'active'
        ? { convo: await service.convoView(convo, viewer!) }
        : {}),
      ...(request ? { viewer: { requestedAt: request.requestedAt } } : {}),
    }
  }

  service.joinLinkPreviews = (codes) =>
    Promise.all(codes.map((code) => previewFor(code)))

  /*
   * Routes
   */

  const group = chat.bsky.group

  server.add(group.createGroup, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const owner = credentials.did
      const others = [...new Set(input.body.members)].filter((d) => d !== owner)
      if (others.length + 1 > GROUP_MEMBER_LIMIT) {
        throw new InvalidRequestError(
          `Groups can have at most ${GROUP_MEMBER_LIMIT} members`,
          'MemberLimitReached',
        )
      }
      for (const did of others) await assertCanAdd(owner, did)
      const id = randomId()
      const convo: ConvoTable = {
        id,
        kind: 'group',
        name: input.body.name,
        ownerDid: owner,
        directKey: null,
        lockStatus: 'unlocked',
        memberLimit: GROUP_MEMBER_LIMIT,
        createdAt: new Date().toISOString(),
        rev: nextRev(),
      }
      await db.insertInto('convo').values(convo).execute()
      await addMember(convo, owner, { role: 'owner', status: 'accepted' })
      await service.log([owner], id, (rev) => ({
        $type: 'chat.bsky.convo.defs#logBeginConvo',
        rev,
        convoId: id,
      }))
      for (const did of others) {
        await addMember(convo, did, {
          role: 'standard',
          status: 'request',
          addedBy: owner,
        })
      }
      const row = await db
        .selectFrom('convo')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      return json({ convo: await service.convoView(row, owner) })
    },
  })

  server.add(group.addMembers, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convo } = await getGroup(
        input.body.convoId,
        credentials.did,
        true,
      )
      assertUnlocked(convo)
      const current = await service.listMembers(convo.id)
      const newDids = [...new Set(input.body.members)].filter(
        (did) => !current.some((m) => m.did === did && m.state === 'active'),
      )
      await assertRoom(convo, newDids.length)
      // The owner may add back members they removed earlier
      for (const did of newDids) await assertCanAdd(credentials.did, did)
      for (const did of newDids) {
        await addMember(convo, did, {
          role: 'standard',
          status: 'request',
          addedBy: credentials.did,
        })
      }
      const profiles = await appview.getProfiles(newDids)
      return json({
        convo: await service.convoView(convo, credentials.did),
        addedMembers: newDids.map((did) =>
          service.profileView(did, profiles.get(did)),
        ),
      })
    },
  })

  server.add(group.removeMembers, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convo } = await getGroup(
        input.body.convoId,
        credentials.did,
        true,
      )
      const members = await activeMembers(convo.id)
      for (const did of new Set(input.body.members)) {
        if (did === convo.ownerDid) continue
        if (!members.some((m) => m.did === did)) continue
        const dids = (await activeMembers(convo.id)).map((m) => m.did)
        await db
          .updateTable('member')
          .set({ state: 'removed' })
          .where('convoId', '=', convo.id)
          .where('did', '=', did)
          .execute()
        await service.systemMessage(
          convo.id,
          {
            $type: SYS('RemoveMember'),
            member: { did },
            removedBy: { did: credentials.did },
          },
          dids,
          'logRemoveMember',
        )
      }
      return json({ convo: await service.convoView(convo, credentials.did) })
    },
  })

  server.add(group.editGroup, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convo } = await getGroup(
        input.body.convoId,
        credentials.did,
        true,
      )
      assertUnlocked(convo)
      await db
        .updateTable('convo')
        .set({ name: input.body.name })
        .where('id', '=', convo.id)
        .execute()
      await service.systemMessage(
        convo.id,
        {
          $type: SYS('EditGroup'),
          oldName: convo.name ?? '',
          newName: input.body.name,
        },
        (await activeMembers(convo.id)).map((m) => m.did),
        'logEditGroup',
      )
      const row = { ...convo, name: input.body.name }
      return json({ convo: await service.convoView(row, credentials.did) })
    },
  })

  /** Locks or unlocks a group; nobody can post or join while it is locked */
  async function setLock(convoId: string, viewer: string, locked: boolean) {
    const { convo } = await getGroup(convoId, viewer, true)
    if (locked && convo.lockStatus !== 'unlocked') {
      throw new InvalidRequestError(
        'The group is already locked',
        'ConvoLocked',
      )
    }
    if (!locked && convo.lockStatus === 'locked-permanently') {
      throw new InvalidRequestError(
        'The group was locked by moderators',
        'ConvoLockedByModeration',
      )
    }
    const lockStatus = locked ? 'locked' : 'unlocked'
    await db
      .updateTable('convo')
      .set({ lockStatus })
      .where('id', '=', convo.id)
      .execute()
    await service.systemMessage(
      convo.id,
      locked
        ? { $type: SYS('LockConvo'), lockedBy: { did: viewer } }
        : { $type: SYS('UnlockConvo'), unlockedBy: { did: viewer } },
      (await activeMembers(convo.id)).map((m) => m.did),
      locked ? 'logLockConvo' : 'logUnlockConvo',
    )
    return service.convoView({ ...convo, lockStatus }, viewer)
  }

  server.add(chat.bsky.convo.lockConvo, {
    auth,
    handler: async ({ auth: { credentials }, input }) =>
      json({ convo: await setLock(input.body.convoId, credentials.did, true) }),
  })

  server.add(chat.bsky.convo.unlockConvo, {
    auth,
    handler: async ({ auth: { credentials }, input }) =>
      json({
        convo: await setLock(input.body.convoId, credentials.did, false),
      }),
  })

  /*
   * Join links
   */

  async function announceLinkChange(convo: ConvoTable, kind: string) {
    await service.systemMessage(
      convo.id,
      { $type: SYS(kind) },
      (await activeMembers(convo.id)).map((m) => m.did),
      `log${kind}`,
    )
  }

  server.add(group.createJoinLink, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convo } = await getGroup(
        input.body.convoId,
        credentials.did,
        true,
      )
      const existing = await getJoinLink(convo.id)
      if (existing?.enabled) {
        throw new InvalidRequestError(
          'The group already has a join link',
          'EnabledJoinLinkAlreadyExists',
        )
      }
      const link: JoinLinkTable = {
        convoId: convo.id,
        code: randomId(8),
        enabled: 1,
        requireApproval: input.body.requireApproval ? 1 : 0,
        joinRule:
          input.body.joinRule === 'followedByOwner'
            ? 'followedByOwner'
            : 'anyone',
        createdAt: new Date().toISOString(),
      }
      await db.deleteFrom('join_link').where('convoId', '=', convo.id).execute()
      await db.insertInto('join_link').values(link).execute()
      await announceLinkChange(convo, 'CreateJoinLink')
      return json({ joinLink: joinLinkView(link) })
    },
  })

  server.add(group.editJoinLink, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convo } = await getGroup(
        input.body.convoId,
        credentials.did,
        true,
      )
      const link = await getJoinLink(convo.id)
      if (!link) throw new InvalidRequestError('No join link', 'NoJoinLink')
      const updated: JoinLinkTable = {
        ...link,
        ...(input.body.requireApproval !== undefined
          ? { requireApproval: input.body.requireApproval ? 1 : 0 }
          : {}),
        ...(input.body.joinRule
          ? {
              joinRule:
                input.body.joinRule === 'followedByOwner'
                  ? 'followedByOwner'
                  : 'anyone',
            }
          : {}),
      }
      await db
        .updateTable('join_link')
        .set(updated)
        .where('convoId', '=', convo.id)
        .execute()
      await announceLinkChange(convo, 'EditJoinLink')
      return json({ joinLink: joinLinkView(updated) })
    },
  })

  async function setLinkEnabled(
    convoId: string,
    viewer: string,
    enabled: boolean,
  ) {
    const { convo } = await getGroup(convoId, viewer, true)
    const link = await getJoinLink(convo.id)
    if (!link) throw new InvalidRequestError('No join link', 'NoJoinLink')
    if (enabled && link.enabled) {
      throw new InvalidRequestError(
        'The join link is already enabled',
        'LinkAlreadyEnabled',
      )
    }
    await db
      .updateTable('join_link')
      .set({ enabled: enabled ? 1 : 0 })
      .where('convoId', '=', convo.id)
      .execute()
    await announceLinkChange(
      convo,
      enabled ? 'EnableJoinLink' : 'DisableJoinLink',
    )
    return joinLinkView({ ...link, enabled: enabled ? 1 : 0 })
  }

  server.add(group.enableJoinLink, {
    auth,
    handler: async ({ auth: { credentials }, input }) =>
      json({
        joinLink: await setLinkEnabled(
          input.body.convoId,
          credentials.did,
          true,
        ),
      }),
  })

  server.add(group.disableJoinLink, {
    auth,
    handler: async ({ auth: { credentials }, input }) =>
      json({
        joinLink: await setLinkEnabled(
          input.body.convoId,
          credentials.did,
          false,
        ),
      }),
  })

  // Readable signed out too (eg join link previews on the web)
  const optionalAuth: ChatAuth = async (ctx) =>
    ctx.req.headers.authorization ? auth(ctx) : { credentials: { did: '' } }

  server.add(group.getJoinLinkPreviews, {
    auth: optionalAuth,
    handler: async ({ auth: { credentials }, params }) => {
      const joinLinkPreviews = []
      for (const code of params.codes) {
        joinLinkPreviews.push(
          await previewFor(code, credentials.did || undefined),
        )
      }
      return json({ joinLinkPreviews })
    },
  })

  server.add(group.requestJoin, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const viewer = credentials.did
      const link = await db
        .selectFrom('join_link')
        .selectAll()
        .where('code', '=', input.body.code)
        .executeTakeFirst()
      const convo =
        link &&
        (await db
          .selectFrom('convo')
          .selectAll()
          .where('id', '=', link.convoId)
          .executeTakeFirst())
      if (!link || !convo) {
        throw new InvalidRequestError('Invalid join link', 'InvalidCode')
      }
      if (!link.enabled) {
        throw new InvalidRequestError(
          'This join link is disabled',
          'LinkDisabled',
        )
      }
      assertUnlocked(convo)
      const member = await service.getMember(convo.id, viewer)
      if (member?.state === 'active') {
        return json({
          status: 'joined',
          convo: await service.convoView(convo, viewer),
        })
      }
      if (member?.state === 'removed') {
        throw new InvalidRequestError(
          'You were removed from this group',
          'UserKicked',
        )
      }
      await assertRoom(convo, 1)
      if (link.joinRule === 'followedByOwner') {
        const rel = (
          await appview.getRelationships(convo.ownerDid ?? '', [viewer])
        ).get(viewer)
        if (!rel?.following) {
          throw new InvalidRequestError(
            'Only people the owner follows can join',
            'FollowRequired',
          )
        }
      }
      if (link.requireApproval) {
        await db
          .insertInto('join_request')
          .values({
            convoId: convo.id,
            did: viewer,
            requestedAt: new Date().toISOString(),
            read: 0,
          })
          .onConflict((oc) => oc.doNothing())
          .execute()
        const profile = service.profileView(
          viewer,
          await appview.getProfile(viewer),
        )
        await service.log([convo.ownerDid ?? ''], convo.id, (rev) => ({
          $type: 'chat.bsky.convo.defs#logIncomingJoinRequest',
          rev,
          convoId: convo.id,
          member: profile,
        }))
        await service.log([viewer], convo.id, (rev) => ({
          $type: 'chat.bsky.convo.defs#logOutgoingJoinRequest',
          rev,
          convoId: convo.id,
        }))
        return json({ status: 'pending' })
      }
      await addMember(convo, viewer, {
        role: 'standard',
        status: 'accepted',
        viaJoinLink: true,
      })
      return json({
        status: 'joined',
        convo: await service.convoView(convo, viewer),
      })
    },
  })

  async function takeRequest(convoId: string, did: string) {
    const request = await db
      .selectFrom('join_request')
      .selectAll()
      .where('convoId', '=', convoId)
      .where('did', '=', did)
      .executeTakeFirst()
    if (request) {
      await db
        .deleteFrom('join_request')
        .where('convoId', '=', convoId)
        .where('did', '=', did)
        .execute()
    }
    return request
  }

  server.add(group.approveJoinRequest, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convo } = await getGroup(
        input.body.convoId,
        credentials.did,
        true,
      )
      await assertRoom(convo, 1)
      if (await takeRequest(convo.id, input.body.member)) {
        await addMember(convo, input.body.member, {
          role: 'standard',
          status: 'accepted',
          viaJoinLink: true,
          approvedBy: credentials.did,
        })
        const profile = service.profileView(
          input.body.member,
          await appview.getProfile(input.body.member),
        )
        await service.log([credentials.did], convo.id, (rev) => ({
          $type: 'chat.bsky.convo.defs#logApproveJoinRequest',
          rev,
          convoId: convo.id,
          member: profile,
        }))
      }
      return json({ convo: await service.convoView(convo, credentials.did) })
    },
  })

  server.add(group.rejectJoinRequest, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convo } = await getGroup(
        input.body.convoId,
        credentials.did,
        true,
      )
      if (await takeRequest(convo.id, input.body.member)) {
        const profile = service.profileView(
          input.body.member,
          await appview.getProfile(input.body.member),
        )
        await service.log([credentials.did], convo.id, (rev) => ({
          $type: 'chat.bsky.convo.defs#logRejectJoinRequest',
          rev,
          convoId: convo.id,
          member: profile,
        }))
      }
      return json({})
    },
  })

  server.add(group.withdrawJoinRequest, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const viewer = credentials.did
      const request = await takeRequest(input.body.convoId, viewer)
      if (!request) {
        throw new InvalidRequestError(
          'No such join request',
          'InvalidJoinRequest',
        )
      }
      const convo = await db
        .selectFrom('convo')
        .selectAll()
        .where('id', '=', input.body.convoId)
        .executeTakeFirst()
      const profile = service.profileView(
        viewer,
        await appview.getProfile(viewer),
      )
      await service.log([convo?.ownerDid ?? ''], input.body.convoId, (rev) => ({
        $type: 'chat.bsky.convo.defs#logWithdrawIncomingJoinRequest',
        rev,
        convoId: input.body.convoId,
        member: profile,
      }))
      await service.log([viewer], input.body.convoId, (rev) => ({
        $type: 'chat.bsky.convo.defs#logWithdrawOutgoingJoinRequest',
        rev,
        convoId: input.body.convoId,
      }))
      return json({})
    },
  })

  server.add(group.listJoinRequests, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      const { convo } = await getGroup(params.convoId, credentials.did, true)
      let qb = db
        .selectFrom('join_request')
        .selectAll()
        .where('convoId', '=', convo.id)
        .orderBy('requestedAt', 'desc')
        .limit(params.limit ?? 50)
      if (params.cursor) qb = qb.where('requestedAt', '<', params.cursor)
      const rows = await qb.execute()
      const profiles = await appview.getProfiles(rows.map((r) => r.did))
      return json({
        requests: rows.map((r) => ({
          convoId: convo.id,
          requestedBy: service.profileView(r.did, profiles.get(r.did)),
          requestedAt: r.requestedAt,
        })),
        cursor:
          rows.length === (params.limit ?? 50)
            ? rows[rows.length - 1].requestedAt
            : undefined,
      })
    },
  })

  server.add(group.updateJoinRequestsRead, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convo } = await getGroup(
        input.body.convoId,
        credentials.did,
        true,
      )
      await db
        .updateTable('join_request')
        .set({ read: 1 })
        .where('convoId', '=', convo.id)
        .execute()
      await service.log([credentials.did], convo.id, (rev) => ({
        $type: 'chat.bsky.convo.defs#logReadJoinRequests',
        rev,
        convoId: convo.id,
      }))
      return json({})
    },
  })

  server.add(group.listMutualGroups, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      const viewer = credentials.did
      const rows = await db
        .selectFrom('convo')
        .innerJoin('member as me', 'me.convoId', 'convo.id')
        .innerJoin('member as them', 'them.convoId', 'convo.id')
        .selectAll('convo')
        .where('convo.kind', '=', 'group')
        .where('me.did', '=', viewer)
        .where('me.state', '=', 'active')
        .where('them.did', '=', params.subject)
        .where('them.state', '=', 'active')
        .orderBy('convo.rev', 'desc')
        .execute()
      const convos = []
      for (const row of rows) convos.push(await service.convoView(row, viewer))
      return json({ convos })
    },
  })
}
