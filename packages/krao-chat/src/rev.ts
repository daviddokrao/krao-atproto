import { randomBytes } from 'node:crypto'

let last = 0n

/**
 * A rev: a fixed-width, base-36 timestamp (microseconds) that only ever goes
 * up, so revs compare correctly as strings. Clients keep the last rev they saw
 * as their getLog cursor, and revs keep growing across restarts.
 */
export function nextRev(): string {
  let now = BigInt(Date.now()) * 1000n
  if (now <= last) now = last + 1n
  last = now
  return now.toString(36).padStart(12, '0')
}

/** The rev "now", without taking it: a cursor that only newer events pass */
export function currentRev(): string {
  const now = BigInt(Date.now()) * 1000n
  return (now > last ? now : last).toString(36).padStart(12, '0')
}

/** A random id for convos and join link codes */
export function randomId(length = 16): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bytes = randomBytes(length)
  let id = ''
  for (const b of bytes) id += alphabet[b % 32]
  return id
}
