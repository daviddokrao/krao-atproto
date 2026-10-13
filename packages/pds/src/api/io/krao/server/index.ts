import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../../../context.js'
import createWalletSession from './createWalletSession.js'
import getWalletChallenge from './getWalletChallenge.js'

export default function (server: Server, ctx: AppContext) {
  getWalletChallenge(server, ctx)
  createWalletSession(server, ctx)
}
