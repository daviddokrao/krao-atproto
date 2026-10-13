import type { IncomingMessage } from 'node:http'
import type { IdResolver } from '@atproto/identity'
import {
  AuthRequiredError,
  ForbiddenError,
  verifyJwt,
} from '@atproto/xrpc-server'

/**
 * The PDSes whose accounts may upload, each as the public URL found in DID
 * documents and the URL this service uses to reach it (often the same).
 * Uploads only go to these, so a DID document cannot point the service at an
 * arbitrary host.
 */
export class PdsRegistry {
  private urls = new Map<string, string>()

  /** Entries are `<public url>` or `<public url>=<internal url>` */
  constructor(entries: string[]) {
    for (const entry of entries) {
      const [publicUrl, internalUrl = publicUrl] = entry.split('=')
      this.urls.set(new URL(publicUrl).origin, internalUrl.replace(/\/$/, ''))
    }
  }

  /** The URL to call for a PDS endpoint from a DID document, if allowed */
  internalUrl(publicUrl: string): string | undefined {
    try {
      return this.urls.get(new URL(publicUrl).origin)
    } catch {
      return undefined
    }
  }
}

function bearer(req: IncomingMessage) {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Bearer ')) {
    throw new AuthRequiredError('Service auth token required')
  }
  return header.slice('Bearer '.length)
}

export type Uploader = {
  did: string
  /** The token itself, reused to store the video on the account's PDS */
  token: string
  /** The account's PDS, as this service reaches it */
  pdsUrl: string
}

export class VideoAuth {
  constructor(
    private idResolver: IdResolver,
    private serviceDid: string,
    private pdses: PdsRegistry,
  ) {}

  private getSigningKey = (iss: string, forceRefresh: boolean) =>
    this.idResolver.did.resolveAtprotoKey(iss.split('#')[0], forceRefresh)

  /**
   * Upload calls carry the token the video is later stored on the PDS with: a
   * service auth token for com.atproto.repo.uploadBlob addressed to the
   * account's own PDS (not to this service).
   */
  async uploader(req: IncomingMessage): Promise<Uploader> {
    const token = bearer(req)
    const payload = await verifyJwt(
      token,
      null,
      'com.atproto.repo.uploadBlob',
      this.getSigningKey,
    )
    const did = payload.iss.split('#')[0]
    const data = await this.idResolver.did.resolveAtprotoData(did)
    const pdsUrl = this.pdses.internalUrl(data.pds)
    if (!pdsUrl) {
      throw new ForbiddenError(
        'Video uploads are only available to accounts on Krao',
        'UploadForbidden',
      )
    }
    if (payload.aud !== `did:web:${new URL(data.pds).hostname}`) {
      throw new AuthRequiredError(
        "The token must be addressed to the account's PDS",
        'BadJwtAudience',
      )
    }
    return { did, token, pdsUrl }
  }

  /** getUploadLimits takes a token addressed to this service */
  async limitsReader(req: IncomingMessage): Promise<{ did: string }> {
    const payload = await verifyJwt(
      bearer(req),
      this.serviceDid,
      'app.bsky.video.getUploadLimits',
      this.getSigningKey,
    )
    return { did: payload.iss.split('#')[0] }
  }
}
