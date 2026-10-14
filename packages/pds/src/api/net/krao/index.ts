import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../../context.js'
import server from './server/index.js'

/** Krao (net.krao.*) endpoints hosted by the PDS */
export default function (xrpcServer: Server, ctx: AppContext) {
  server(xrpcServer, ctx)
}
