// A throwaway PLC directory for rehearsals (in memory): DIDs made here never
// reach plc.directory. Runs in the image's `tools` target.
import { createRequire } from 'node:module'

const require = createRequire('/app/packages/dev-env/package.json')
const plc = await import(require.resolve('@did-plc/server'))
// The in-memory database has no /export: Krao's PLC mirror follows it (M35)
const { enableMockExport } = await import(require.resolve('@krao/plc-mirror'))

const db = plc.Database.mock()
enableMockExport(db)
const server = plc.PlcServer.create({ db, port: 2582 })
await server.start()
console.log('Rehearsal PLC listening on 2582')
