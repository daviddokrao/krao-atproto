/*
 * Development only: @did-plc/server's in-memory database (the dev-env's
 * PLC) answers /export with nothing. This gives it the export a real
 * directory has, so the mirror can follow it.
 */

type MockOp = {
  did: string
  operation: unknown
  cid: { toString(): string }
  nullified: boolean
  createdAt: Date
}

type MockDatabase = {
  contents: Record<string, MockOp[]>
  exportOps: (count: number, after?: Date) => Promise<unknown[]>
}

export function enableMockExport(db: unknown): void {
  const mock = db as MockDatabase
  if (!mock || typeof mock.contents !== 'object') return
  mock.exportOps = async (count: number, after?: Date) => {
    const all = Object.values(mock.contents)
      .flat()
      .filter((op) => !after || op.createdAt.getTime() > after.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    return all.slice(0, count).map((op) => ({
      did: op.did,
      operation: op.operation,
      cid: op.cid.toString(),
      nullified: op.nullified,
      createdAt: op.createdAt.toISOString(),
    }))
  }
}
