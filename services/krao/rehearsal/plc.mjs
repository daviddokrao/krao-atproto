// A throwaway PLC directory for rehearsals (in memory): DIDs made here never
// reach plc.directory. Runs in the image's `tools` target.
import { createRequire } from 'node:module'

const require = createRequire('/app/packages/dev-env/package.json')
const plc = await import(require.resolve('@did-plc/server'))

const server = plc.PlcServer.create({ db: plc.Database.mock(), port: 2582 })
await server.start()
console.log('Rehearsal PLC listening on 2582')
