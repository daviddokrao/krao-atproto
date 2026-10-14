import { InvalidRequestError } from '@atproto/xrpc-server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Appview, AppviewProfile } from './appview.js'
import { type Database, type MemberTable, createDb, migrateDb } from './db.js'
import { nextRev, randomId } from './rev.js'
import { ChatService } from './service.js'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const CAROL = 'did:plc:carol'

const profiles = new Map<string, AppviewProfile>(
  [ALICE, BOB, CAROL].map((did) => {
    const name = did.slice('did:plc:'.length)
    return [
      did,
      {
        did,
        handle: `${name}.test`,
        displayName: name,
        associated: { chat: { allowIncoming: 'all' } },
      },
    ]
  }),
)

/** An AppView that knows the three accounts and has no follows or blocks */
const fakeAppview = {
  getProfile: async (did: string) => profiles.get(did) ?? null,
  getProfiles: async (dids: string[]) =>
    new Map(dids.map((did) => [did, profiles.get(did) ?? null])),
  getRelationships: async (_actor: string, others: string[]) =>
    new Map(
      others.map((did) => [
        did,
        {
          following: false,
          followedBy: false,
          blocking: false,
          blockedBy: false,
        },
      ]),
    ),
} as unknown as Appview

async function expectError(promise: Promise<unknown>, name: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(InvalidRequestError)
  expect((err as InvalidRequestError).customErrorName).toBe(name)
}

describe('ChatService', () => {
  let db: Database
  let service: ChatService

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    service = new ChatService(db, fakeAppview)
  })

  /** A group as createGroup stores it: the owner plus accepted members */
  async function createGroup(owner: string, others: string[]) {
    const id = randomId()
    await db
      .insertInto('convo')
      .values({
        id,
        kind: 'group',
        name: 'Test group',
        ownerDid: owner,
        directKey: null,
        lockStatus: 'unlocked',
        memberLimit: 50,
        createdAt: new Date().toISOString(),
        rev: nextRev(),
      })
      .execute()
    for (const did of [owner, ...others]) {
      const rev = nextRev()
      const row: MemberTable = {
        convoId: id,
        did,
        role: did === owner ? 'owner' : 'standard',
        status: 'accepted',
        state: 'active',
        muted: 0,
        addedBy: did === owner ? null : owner,
        joinedRev: rev,
        lastReadRev: rev,
      }
      await db.insertInto('member').values(row).execute()
    }
    return id
  }

  async function unreadCount(convoId: string, viewer: string) {
    const { convo } = await service.getConvoForViewer(convoId, viewer)
    return (await service.convoView(convo, viewer)).unreadCount
  }

  describe('direct convos', () => {
    it('makes a message unread for the recipient until they read it', async () => {
      const convoId = await service.createDirectConvo(ALICE, BOB)
      await service.sendMessage(convoId, ALICE, { text: 'hello' })
      await service.sendMessage(convoId, ALICE, { text: 'there?' })

      expect(await unreadCount(convoId, BOB)).toBe(2)
      // The sender has read their own messages
      expect(await unreadCount(convoId, ALICE)).toBe(0)

      await service.markRead(convoId, BOB)
      expect(await unreadCount(convoId, BOB)).toBe(0)

      await service.sendMessage(convoId, ALICE, { text: 'again' })
      expect(await unreadCount(convoId, BOB)).toBe(1)
    })

    it('reuses one convo per pair', async () => {
      const convoId = await service.createDirectConvo(ALICE, BOB)
      const found = await service.findDirectConvo(BOB, ALICE)
      expect(found?.id).toBe(convoId)
    })
  })

  describe('moderation', () => {
    it('refuses messages from an account a moderator cut off from chat', async () => {
      const convoId = await service.createDirectConvo(ALICE, BOB)
      await db
        .insertInto('actor_access')
        .values({
          did: ALICE,
          allowAccess: 0,
          ref: 'report-1',
          updatedAt: new Date().toISOString(),
        })
        .execute()
      await expectError(
        service.sendMessage(convoId, ALICE, { text: 'spam' }),
        'ChatDisabled',
      )
      // The other member is unaffected, and access can be restored
      await service.sendMessage(convoId, BOB, { text: 'hi' })
      await db
        .updateTable('actor_access')
        .set({ allowAccess: 1 })
        .where('did', '=', ALICE)
        .execute()
      await service.sendMessage(convoId, ALICE, { text: 'sorry' })
    })
  })

  describe('groups', () => {
    it('tells the remaining members who left, with the leaver profile', async () => {
      const convoId = await createGroup(ALICE, [BOB, CAROL])
      await service.sendMessage(convoId, BOB, { text: 'hi all' })
      await service.leaveConvo(convoId, CAROL)

      const { messages, relatedProfiles } = await service.getMessages(
        convoId,
        BOB,
        { limit: 50 },
      )
      const left = messages.find(
        (m) =>
          m.$type === 'chat.bsky.convo.defs#systemMessageView' &&
          (m.data as { $type: string }).$type ===
            'chat.bsky.convo.defs#systemMessageDataMemberLeave',
      )
      expect(left).toBeDefined()
      expect((left!.data as { member: { did: string } }).member.did).toBe(CAROL)
      const related = relatedProfiles.map((p) => p.did)
      expect(related).toContain(CAROL)
      expect(related).toContain(BOB)
      expect(relatedProfiles.find((p) => p.did === CAROL)?.handle).toBe(
        'carol.test',
      )
    })

    it('does not let the owner leave', async () => {
      const convoId = await createGroup(ALICE, [BOB])
      await expectError(service.leaveConvo(convoId, ALICE), 'OwnerCannotLeave')
      expect((await service.getMember(convoId, ALICE))?.state).toBe('active')
    })

    it('hides the convo from a member who left', async () => {
      const convoId = await createGroup(ALICE, [BOB, CAROL])
      await service.leaveConvo(convoId, CAROL)
      await expectError(
        service.getMessages(convoId, CAROL, { limit: 10 }),
        'InvalidConvo',
      )
    })

    it('hides the convo from a removed member', async () => {
      const convoId = await createGroup(ALICE, [BOB, CAROL])
      await service.sendMessage(convoId, ALICE, { text: 'secret' })
      await db
        .updateTable('member')
        .set({ state: 'removed' })
        .where('convoId', '=', convoId)
        .where('did', '=', CAROL)
        .execute()

      await expectError(
        service.getMessages(convoId, CAROL, { limit: 10 }),
        'InvalidConvo',
      )
      await expectError(
        service.sendMessage(convoId, CAROL, { text: 'let me in' }),
        'InvalidConvo',
      )
      const { messages } = await service.getMessages(convoId, BOB, {
        limit: 10,
      })
      expect(messages).toHaveLength(1)
    })
  })
})
