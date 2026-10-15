import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { Database } from './db.js'

/**
 * Where gated media bytes live when they are not kept in the database.
 * Rows in gated_media keep the metadata either way; `store` says where
 * the bytes are.
 */
export interface MediaBlobStore {
  put(id: string, data: Buffer, mimeType: string): Promise<void>
  /** `length` bytes from `start` */
  read(id: string, start: number, length: number): Promise<Buffer>
  delete(ids: string[]): Promise<void>
}

export type S3MediaConfig = {
  bucket: string
  region?: string
  /** For S3-compatible stores (R2, MinIO, ...) */
  endpoint?: string
  forcePathStyle?: boolean
  /** Key prefix, default `gate-media/` */
  prefix?: string
}

/**
 * Gated media in an S3 bucket. The bucket must be private: the gate checks
 * wallets and then serves the bytes itself, so objects are never linked to.
 * Credentials come from the usual AWS environment variables.
 */
export class S3MediaStore implements MediaBlobStore {
  private client: S3Client
  private prefix: string

  constructor(private cfg: S3MediaConfig) {
    this.client = new S3Client({
      region: cfg.region ?? 'auto',
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
    })
    this.prefix = cfg.prefix ?? 'gate-media/'
  }

  private key(id: string) {
    return `${this.prefix}${id}`
  }

  async put(id: string, data: Buffer, mimeType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(id),
        Body: data,
        ContentType: mimeType,
      }),
    )
  }

  async read(id: string, start: number, length: number) {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.key(id),
        Range: `bytes=${start}-${start + length - 1}`,
      }),
    )
    if (!res.Body) throw new Error('Empty S3 response')
    return Buffer.from(await res.Body.transformToByteArray())
  }

  async delete(ids: string[]) {
    // At most 1000 keys per request
    for (let i = 0; i < ids.length; i += 1000) {
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.cfg.bucket,
          Delete: {
            Objects: ids.slice(i, i + 1000).map((id) => ({ Key: this.key(id) })),
            Quiet: true,
          },
        }),
      )
      if (res.Errors?.length) {
        throw new Error(
          `S3 delete failed for ${res.Errors.length} objects: ${res.Errors[0].Message}`,
        )
      }
    }
  }
}

/**
 * Deletes the bytes of gated media whose rows are gone. A database trigger
 * queues every deleted S3-backed row in gated_media_trash, so all the places
 * that delete rows need not know about S3, and a crash only delays this.
 * Returns how many objects were removed.
 */
export async function purgeMediaTrash(
  db: Database,
  blobs: MediaBlobStore | undefined,
  batch = 500,
): Promise<number> {
  if (!blobs) return 0
  let purged = 0
  for (;;) {
    const rows = await db
      .selectFrom('gated_media_trash')
      .select('id')
      .orderBy('deletedAt')
      .limit(batch)
      .execute()
    if (!rows.length) return purged
    const ids = rows.map((r) => r.id)
    await blobs.delete(ids)
    await db.deleteFrom('gated_media_trash').where('id', 'in', ids).execute()
    purged += ids.length
    if (rows.length < batch) return purged
  }
}

/** An in-memory store, for tests */
export class MemoryMediaStore implements MediaBlobStore {
  objects = new Map<string, Buffer>()

  async put(id: string, data: Buffer) {
    this.objects.set(id, Buffer.from(data))
  }

  async read(id: string, start: number, length: number) {
    const data = this.objects.get(id)
    if (!data) throw new Error('NoSuchKey')
    return data.subarray(start, start + length)
  }

  async delete(ids: string[]) {
    for (const id of ids) this.objects.delete(id)
  }
}
