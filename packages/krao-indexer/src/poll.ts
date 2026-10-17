import { AtUri } from '@atproto/syntax'
import { type EvmRpc, parseAssetId } from './chain.js'
import {
  type Database,
  type PollMode,
  type PollTable,
  type PollVoteTable,
  visibleDid,
} from './db.js'
import type { HumanCheck } from './human.js'
import { ownedEvmAddresses } from './wallets.js'

/*
 * Polls (net.krao.poll.*). A poll record sits next to its post (same repo,
 * same rkey by convention) and is never changed once indexed: options or
 * rules edited after votes came in would change what people voted for.
 *
 * Votes are records in the voters' repos, so they are public. One vote per
 * account counts: the first valid one in firehose order. Times come from the
 * firehose (when the PDS published the record), not from the record, so a
 * backdated vote is still late. Votes cannot be changed: a later vote is
 * ignored, and deleting a counted vote takes it out of the results but keeps
 * its place.
 *
 * Modes: 'account' (one vote each), 'verified' (phone or KYC, asked of the
 * rewards service when the vote is indexed) and 'token' (each vote weighs the
 * voter's balance of the asset at the snapshot block: the latest block when
 * the indexer first saw the poll, summed over the wallets the voter owns; a
 * wallet weighs one vote per poll, so moving it to another account does not
 * count its balance twice).
 */

export const POLL_COLLECTION = 'net.krao.poll.poll'
export const VOTE_COLLECTION = 'net.krao.poll.vote'

/** The longest a poll may run */
export const POLL_MAX_MS = 30 * 24 * 60 * 60 * 1000
const MODES: PollMode[] = ['account', 'verified', 'token']
const segmenter = new Intl.Segmenter()
const graphemes = (s: string) => [...segmenter.segment(s)].length

export type PollChecks = {
  rpcs: Map<string, EvmRpc>
  human?: HumanCheck
}

const isoDate = (value: unknown): string | null =>
  typeof value === 'string' && !isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null

/**
 * A poll row, or null for a poll that breaks the rules (2 to 4 options of at
 * most 80 characters, at most 30 days, an asset on an indexed chain for token
 * polls). `time` is when the record was published.
 */
export function pollRowFromRecord(
  uri: string,
  did: string,
  record: unknown,
  time: string,
  rpcs: Map<string, EvmRpc>,
): Omit<PollTable, 'snapshotBlock'> | null {
  const value = (record ?? {}) as Record<string, unknown>
  const ref = (value.post ?? {}) as { uri?: unknown }
  let post: AtUri
  try {
    post = new AtUri(String(ref.uri))
  } catch {
    return null
  }
  if (post.host !== did || post.collection !== 'app.bsky.feed.post') {
    return null
  }
  const options = Array.isArray(value.options) ? value.options : []
  if (
    options.length < 2 ||
    options.length > 4 ||
    !options.every(
      (o) =>
        typeof o === 'string' &&
        o.trim() !== '' &&
        o.length <= 800 &&
        graphemes(o) <= 80,
    )
  ) {
    return null
  }
  const published = isoDate(time) ?? new Date().toISOString()
  const createdAt = isoDate(value.createdAt) ?? published
  const startsAt = createdAt < published ? createdAt : published
  const endsAt = isoDate(value.endsAt)
  if (
    !endsAt ||
    endsAt <= startsAt ||
    // A minute of slack for clocks
    Date.parse(endsAt) - Date.parse(startsAt) > POLL_MAX_MS + 60_000
  ) {
    return null
  }
  const mode = value.mode as PollMode
  if (!MODES.includes(mode)) return null
  let asset: string | null = null
  if (mode === 'token') {
    const parsed =
      typeof value.asset === 'string' ? parseAssetId(value.asset) : null
    if (!parsed || !rpcs.has(parsed.chainId)) return null
    asset = value.asset as string
  }
  return {
    uri,
    did,
    post: post.toString(),
    question:
      typeof value.question === 'string' && value.question.trim()
        ? value.question.slice(0, 3000)
        : null,
    options: JSON.stringify(options),
    startsAt,
    endsAt,
    mode,
    asset,
    resultsVisibility:
      value.resultsVisibility === 'afterEnd' ? 'afterEnd' : 'always',
    createdAt,
    indexedAt: new Date().toISOString(),
  }
}

/**
 * Indexes a poll the first time it is seen (later versions are ignored).
 * Token polls take the latest block as their snapshot; when the chain does
 * not answer this throws, so the event is retried. Votes that came before
 * the poll (kept as 'UnknownPoll') are then counted, in the order they were
 * published.
 */
export async function indexPoll(
  db: Database,
  checks: PollChecks,
  row: Omit<PollTable, 'snapshotBlock'>,
) {
  const existing = await db
    .selectFrom('poll')
    .select('uri')
    .where('uri', '=', row.uri)
    .executeTakeFirst()
  if (!existing) {
    let snapshotBlock: string | null = null
    if (row.mode === 'token' && row.asset) {
      const asset = parseAssetId(row.asset)
      const rpc = asset && checks.rpcs.get(asset.chainId)
      if (!rpc) return
      snapshotBlock = (await rpc.blockNumber()).toString()
    }
    await db
      .insertInto('poll')
      .values({ ...row, snapshotBlock })
      .onConflict((oc) => oc.column('uri').doNothing())
      .execute()
  }
  // Also when the poll is known: a retried event finishes the job
  await evaluateEarlyVotes(db, checks, row.uri)
}

/** Counts (or ignores with a reason) the votes that came before their poll */
async function evaluateEarlyVotes(
  db: Database,
  checks: PollChecks,
  pollUri: string,
) {
  const poll = await db
    .selectFrom('poll')
    .selectAll()
    .where('uri', '=', pollUri)
    .executeTakeFirst()
  if (!poll) return
  const early = await db
    .selectFrom('poll_vote')
    .selectAll()
    .where('poll', '=', pollUri)
    .where('status', '=', 'ignored')
    .where('reason', '=', 'UnknownPoll')
    .orderBy('votedAt', 'asc')
    .orderBy('uri', 'asc')
    .limit(10_000)
    .execute()
  for (const vote of early) {
    const row: PollVoteTable = { ...vote, reason: null }
    const wallets = await decideVote(db, checks, poll, row)
    await storeVote(db, row, wallets, true)
  }
}

/** A deleted poll takes its votes with it */
export async function deletePoll(db: Database, uri: string) {
  await db.deleteFrom('poll').where('uri', '=', uri).execute()
  await db.deleteFrom('poll_vote').where('poll', '=', uri).execute()
  await db.deleteFrom('poll_vote_wallet').where('poll', '=', uri).execute()
}

/** A deleted post takes its polls with it */
export async function deletePollsForPost(db: Database, post: string) {
  const polls = await db
    .selectFrom('poll')
    .select('uri')
    .where('post', '=', post)
    .execute()
  for (const { uri } of polls) await deletePoll(db, uri)
}

type VoteRecord = { poll: string; option: number }

function voteFromRecord(record: unknown): VoteRecord | null {
  const value = (record ?? {}) as Record<string, unknown>
  const ref = (value.poll ?? {}) as { uri?: unknown }
  if (typeof ref.uri !== 'string') return null
  try {
    if (new AtUri(ref.uri).collection !== POLL_COLLECTION) return null
  } catch {
    return null
  }
  if (typeof value.option !== 'number' || !Number.isInteger(value.option)) {
    return null
  }
  return { poll: ref.uri, option: value.option }
}

/**
 * Indexes a vote published at `time` (the firehose event time): counted, or
 * kept as ignored with the reason (shown to the voter). Votes never change
 * once indexed. Throws when the rewards service or the chain cannot answer,
 * so the event is retried.
 */
export async function indexVote(
  db: Database,
  checks: PollChecks,
  uri: string,
  did: string,
  record: unknown,
  time: string,
) {
  const existing = await db
    .selectFrom('poll_vote')
    .select('uri')
    .where('uri', '=', uri)
    .executeTakeFirst()
  if (existing) return
  const vote = voteFromRecord(record)
  if (!vote) return
  const votedAt = isoDate(time) ?? new Date().toISOString()
  const row: PollVoteTable = {
    uri,
    did,
    poll: vote.poll,
    option: vote.option,
    status: 'ignored',
    weight: '0',
    reason: null,
    votedAt,
    indexedAt: new Date().toISOString(),
  }
  const poll = await db
    .selectFrom('poll')
    .selectAll()
    .where('uri', '=', vote.poll)
    .executeTakeFirst()
  // Not indexed yet: kept until the poll comes (see indexPoll)
  const wallets = poll ? await decideVote(db, checks, poll, row) : []
  if (!poll) row.reason = 'UnknownPoll'
  await storeVote(db, row, wallets, false)
  // The poll came while this vote was looked at: count it now
  if (!poll) await evaluateEarlyVotes(db, checks, row.poll)
}

/**
 * Sets the status, weight and reason of a vote in `poll` (status 'ignored'
 * and weight '0' on entry) and returns the wallets that weigh it. Throws when
 * the rewards service or the chain cannot answer.
 */
async function decideVote(
  db: Database,
  checks: PollChecks,
  poll: PollTable,
  row: PollVoteTable,
): Promise<string[]> {
  const { did } = row
  let wallets: string[] = []
  const ignore = (reason: string) => {
    row.reason = reason
  }
  if (row.votedAt > poll.endsAt) {
    ignore('AfterEnd')
  } else if (
    row.option < 0 ||
    row.option >= (JSON.parse(poll.options) as string[]).length
  ) {
    ignore('InvalidOption')
  } else if (await hasVoted(db, poll.uri, did)) {
    ignore('AlreadyVoted')
  } else if (poll.mode === 'verified') {
    if (!checks.human) {
      ignore('VerificationUnavailable')
    } else if (!(await checks.human.isHuman(did))) {
      ignore('NotVerified')
    } else {
      row.status = 'counted'
      row.weight = '1'
    }
  } else if (poll.mode === 'token') {
    const asset = poll.asset ? parseAssetId(poll.asset) : null
    const rpc = asset && checks.rpcs.get(asset.chainId)
    if (!asset || !rpc || !poll.snapshotBlock) {
      ignore('UnsupportedAsset')
    } else {
      // Wallets that already weighed another vote in this poll do not count
      const used = new Set(
        (
          await db
            .selectFrom('poll_vote_wallet')
            .select('address')
            .where('poll', '=', poll.uri)
            .execute()
        ).map((r) => r.address),
      )
      wallets = [...(await ownedEvmAddresses(db, did))]
        .filter((a) => !used.has(a))
        .sort()
      let weight = 0n
      for (const address of wallets) {
        weight += await rpc.balanceAt(
          asset,
          address,
          BigInt(poll.snapshotBlock),
        )
      }
      row.status = 'counted'
      row.weight = weight.toString()
    }
  } else {
    row.status = 'counted'
    row.weight = '1'
  }
  return wallets
}

/**
 * Stores a decided vote: inserted, or with `early` updated in place (a vote
 * that came before its poll)
 */
async function storeVote(
  db: Database,
  row: PollVoteTable,
  wallets: string[],
  early: boolean,
) {
  const { did, uri } = row
  try {
    await db.transaction().execute(async (tx) => {
      if (early) {
        await tx
          .updateTable('poll_vote')
          .set({ status: row.status, weight: row.weight, reason: row.reason })
          .where('uri', '=', uri)
          .execute()
      } else {
        await tx.insertInto('poll_vote').values(row).execute()
      }
      if (row.status === 'counted' && wallets.length) {
        await tx
          .insertInto('poll_vote_wallet')
          .values(
            wallets.map((address) => ({ poll: row.poll, address, vote: uri })),
          )
          .onConflict((oc) => oc.doNothing())
          .execute()
      }
    })
  } catch (err) {
    // Another vote of the account counted in the meantime
    if (row.status !== 'counted' || !(await hasVoted(db, row.poll, did))) {
      throw err
    }
    const ignored: Pick<PollVoteTable, 'status' | 'weight' | 'reason'> = {
      status: 'ignored',
      weight: '0',
      reason: 'AlreadyVoted',
    }
    if (early) {
      await db
        .updateTable('poll_vote')
        .set(ignored)
        .where('uri', '=', uri)
        .execute()
    } else {
      await db
        .insertInto('poll_vote')
        .values({ ...row, ...ignored })
        .onConflict((oc) => oc.column('uri').doNothing())
        .execute()
    }
  }
}

async function hasVoted(db: Database, poll: string, did: string) {
  return !!(await db
    .selectFrom('poll_vote')
    .select('uri')
    .where('poll', '=', poll)
    .where('did', '=', did)
    .where('status', 'in', ['counted', 'deleted'])
    .executeTakeFirst())
}

/**
 * A deleted vote: a counted one leaves the results but keeps its place (the
 * account cannot vote again), others go
 */
export async function deleteVote(db: Database, uri: string) {
  const row = await db
    .selectFrom('poll_vote')
    .select('status')
    .where('uri', '=', uri)
    .executeTakeFirst()
  if (!row) return
  if (row.status === 'counted') {
    await db
      .updateTable('poll_vote')
      .set({ status: 'deleted', weight: '0', reason: 'Deleted' })
      .where('uri', '=', uri)
      .execute()
    await db.deleteFrom('poll_vote_wallet').where('vote', '=', uri).execute()
  } else if (row.status !== 'deleted') {
    await db.deleteFrom('poll_vote').where('uri', '=', uri).execute()
  }
}

/** A deleted account: its polls (with their votes) and its votes */
export async function deletePollDataForDid(db: Database, did: string) {
  const polls = await db
    .selectFrom('poll')
    .select('uri')
    .where('did', '=', did)
    .execute()
  for (const { uri } of polls) await deletePoll(db, uri)
  const votes = await db
    .selectFrom('poll_vote')
    .select('uri')
    .where('did', '=', did)
    .execute()
  for (let i = 0; i < votes.length; i += 500) {
    await db
      .deleteFrom('poll_vote_wallet')
      .where(
        'vote',
        'in',
        votes.slice(i, i + 500).map((v) => v.uri),
      )
      .execute()
  }
  await db.deleteFrom('poll_vote').where('did', '=', did).execute()
}

// Results
// -------

export type PollView = {
  uri: string
  post: string
  question?: string
  options: { index: number; text: string; votes?: number; weight?: string }[]
  endsAt: string
  mode: PollMode
  asset?: string
  snapshotBlock?: string
  resultsVisibility: 'always' | 'afterEnd'
  ended: boolean
  resultsVisible: boolean
  totalVotes?: number
  totalWeight?: string
  viewer?: {
    uri: string
    option: number
    status: 'counted' | 'ignored'
    weight?: string
    reason?: string
  }
}

/** A poll whose author is not hidden */
export async function getPoll(db: Database, uri: string) {
  return db
    .selectFrom('poll')
    .selectAll()
    .where('uri', '=', uri)
    .where(visibleDid('did'))
    .executeTakeFirst()
}

/**
 * The poll of each post, if any (when there are several, the one sharing the
 * post's record key, else the first indexed)
 */
export async function getPollsForPosts(
  db: Database,
  posts: string[],
): Promise<PollTable[]> {
  if (!posts.length) return []
  const rows = await db
    .selectFrom('poll')
    .selectAll()
    .where('post', 'in', posts)
    .where(visibleDid('did'))
    .orderBy('indexedAt', 'asc')
    .execute()
  const best = new Map<string, PollTable>()
  for (const row of rows) {
    const current = best.get(row.post)
    if (!current || (!sameKeyOf(current) && sameKeyOf(row))) {
      best.set(row.post, row)
    }
  }
  return posts.flatMap((p) => best.get(p) ?? [])
}

const sameKeyOf = (row: PollTable) =>
  row.uri.split('/').pop() === row.post.split('/').pop()

/**
 * Results of the polls: votes (and weights for token polls) per option, left
 * out while an 'afterEnd' poll is open; plus the viewer's vote. Votes of
 * hidden accounts do not count.
 */
export async function pollViews(
  db: Database,
  polls: PollTable[],
  viewer?: string,
  now = Date.now(),
): Promise<PollView[]> {
  if (!polls.length) return []
  const uris = polls.map((p) => p.uri)
  const counted = await db
    .selectFrom('poll_vote')
    .select(['poll', 'option', 'weight'])
    .where('poll', 'in', uris)
    .where('status', '=', 'counted')
    .where(visibleDid('did'))
    .execute()
  const mine = viewer
    ? await db
        .selectFrom('poll_vote')
        .selectAll()
        .where('poll', 'in', uris)
        .where('did', '=', viewer)
        .orderBy('indexedAt', 'asc')
        .execute()
    : []
  return polls.map((poll) => {
    const options = JSON.parse(poll.options) as string[]
    const ended = now >= Date.parse(poll.endsAt)
    const resultsVisible = poll.resultsVisibility === 'always' || ended
    const token = poll.mode === 'token'
    const votes = options.map(() => 0)
    const weights = options.map(() => 0n)
    for (const v of counted) {
      if (v.poll !== poll.uri || v.option >= options.length) continue
      votes[v.option]++
      weights[v.option] += BigInt(v.weight)
    }
    const view: PollView = {
      uri: poll.uri,
      post: poll.post,
      ...(poll.question ? { question: poll.question } : {}),
      options: options.map((text, index) => ({
        index,
        text,
        ...(resultsVisible ? { votes: votes[index] } : {}),
        ...(resultsVisible && token
          ? { weight: weights[index].toString() }
          : {}),
      })),
      endsAt: poll.endsAt,
      mode: poll.mode,
      ...(poll.asset ? { asset: poll.asset } : {}),
      ...(poll.snapshotBlock ? { snapshotBlock: poll.snapshotBlock } : {}),
      resultsVisibility: poll.resultsVisibility,
      ended,
      resultsVisible,
      ...(resultsVisible
        ? { totalVotes: votes.reduce((a, b) => a + b, 0) }
        : {}),
      ...(resultsVisible && token
        ? { totalWeight: weights.reduce((a, b) => a + b, 0n).toString() }
        : {}),
    }
    // The vote that counts, else the one that holds the place, else the last
    const own = mine.filter((v) => v.poll === poll.uri)
    const shown =
      own.find((v) => v.status === 'counted') ??
      own.find((v) => v.status === 'deleted') ??
      own.at(-1)
    if (shown) {
      view.viewer = {
        uri: shown.uri,
        option: shown.option,
        status: shown.status === 'counted' ? 'counted' : 'ignored',
        ...(shown.status === 'counted' && token
          ? { weight: shown.weight }
          : {}),
        ...(shown.reason ? { reason: shown.reason } : {}),
      }
    }
    return view
  })
}

/** What an account wrote about polls, for its data export */
export async function exportPollData(db: Database, did: string) {
  return {
    polls: await db
      .selectFrom('poll')
      .select([
        'uri',
        'post',
        'question',
        'options',
        'endsAt',
        'mode',
        'asset',
        'snapshotBlock',
        'resultsVisibility',
        'createdAt',
      ])
      .where('did', '=', did)
      .limit(10_000)
      .execute()
      .then((rows) =>
        rows.map((r) => ({
          ...r,
          options: JSON.parse(r.options) as unknown,
        })),
      ),
    pollVotes: await db
      .selectFrom('poll_vote')
      .select([
        'uri',
        'poll',
        'option',
        'status',
        'weight',
        'reason',
        'votedAt',
      ])
      .where('did', '=', did)
      .limit(10_000)
      .execute(),
  }
}
