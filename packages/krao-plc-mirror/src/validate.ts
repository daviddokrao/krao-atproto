import {
  type CompatibleOpOrTombstone,
  LateRecoveryError,
  MisorderedOperationError,
  assureValidCreationOp,
  assureValidOp,
  assureValidSig,
  def,
  getLastOpWithCid,
  normalizeOp,
} from '@did-plc/lib'

/*
 * The checks a PLC directory makes before taking an operation
 * (@did-plc/lib's assureValidNextOp), with one difference: the 72 hour
 * recovery window is measured from when the source took the recovery, not
 * from now, so history can be replayed later.
 */

export type ChainOp = {
  cid: string
  operation: CompatibleOpOrTombstone
  createdAt: string
}

const RECOVERY_WINDOW_MS = 72 * 60 * 60 * 1000

/** The CID of an operation, as the directory computes it */
export async function opCid(op: unknown): Promise<string> {
  const { cid } = await getLastOpWithCid([op as CompatibleOpOrTombstone])
  return cid.toString()
}

/**
 * Throws unless `proposed` may follow `history` (the DID's operations that
 * are not nullified, oldest first); returns the CIDs it nullifies
 */
export async function validateNextOp(
  did: string,
  history: ChainOp[],
  proposed: unknown,
  proposedAt: string,
): Promise<{ nullified: string[] }> {
  const op = proposed as CompatibleOpOrTombstone
  if (def.createOpV1.safeParse(op).success) {
    await assureValidOp(normalizeOp(op as never))
  } else {
    if (!def.opOrTombstone.safeParse(op).success) {
      throw new MisorderedOperationError()
    }
    await assureValidOp(op as never)
  }
  if (!history.length) {
    await assureValidCreationOp(did, op)
    return { nullified: [] }
  }
  const prev = (op as { prev?: string | null }).prev
  if (!prev) throw new MisorderedOperationError()
  const indexOfPrev = history.findIndex((h) => h.cid === prev)
  if (indexOfPrev < 0) throw new MisorderedOperationError()
  const last = history[indexOfPrev]
  const nullified = history.slice(indexOfPrev + 1)
  if (def.tombstone.safeParse(last.operation).success) {
    throw new MisorderedOperationError()
  }
  const lastNormalized = normalizeOp(last.operation as never)
  const [firstNullified] = nullified
  if (!firstNullified) {
    await assureValidSig(lastNormalized.rotationKeys, op)
    return { nullified: [] }
  }
  // A recovery: signed by a key ranked above the one that signed the
  // operation it undoes, within 72 hours of it
  const disputedSigner = await assureValidSig(
    lastNormalized.rotationKeys,
    firstNullified.operation,
  )
  const signerRank = lastNormalized.rotationKeys.indexOf(disputedSigner)
  await assureValidSig(lastNormalized.rotationKeys.slice(0, signerRank), op)
  const lapsed = Date.parse(proposedAt) - Date.parse(firstNullified.createdAt)
  if (lapsed > RECOVERY_WINDOW_MS) throw new LateRecoveryError(lapsed)
  return { nullified: nullified.map((n) => n.cid) }
}
