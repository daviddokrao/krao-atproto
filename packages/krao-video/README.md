# @krao/video

Krao's video service. It speaks the `app.bsky.video.*` API the app already
uses, stores each video as a blob on the author's PDS, and serves it as HLS.

## Flow

1. The app asks its PDS for a service auth token for
   `com.atproto.repo.uploadBlob`, addressed to the PDS itself.
2. `startUpload` reserves the upload against the daily allowance and plans
   8 MiB parts. `uploadPart` stores each part, and `finishUpload` joins them
   and queues the video.
3. Processing:
   - **Probe.** ffprobe checks that the file is a video and within the
     duration limit.
   - **Normalise to mp4.** H.264 mp4s are only remuxed (faststart); anything
     else is re-encoded to H.264/AAC.
   - **Encode HLS.** The output is 360p, plus 720p when the source is large
     enough, and a thumbnail. It goes to `<dataDir>/hls/<did>/<cid>`, keyed by
     the mp4's blob CID.
   - **Store on the PDS.** The mp4 is uploaded with the user's token, and the
     CID the PDS returns must match.
4. `getJobStatus` returns the blob, and the app posts it in an
   `app.bsky.embed.video` embed.
5. The AppView builds player URLs from `BSKY_VIDEO_PLAYLIST_URL_PATTERN` and
   `BSKY_VIDEO_THUMBNAIL_URL_PATTERN`. Point both at this service:
   `https://video.krao.net/watch/%s/%s/playlist.m3u8` and
   `.../thumbnail.jpg`.

`getUploadLimits` takes a token addressed to this service's DID instead.

## Access and safety

- **Krao accounts only.** Only accounts whose PDS is listed in `pdsUrls` can
  upload. The service only ever sends videos to those PDSes, so a DID document
  cannot point it at an arbitrary host.
- **Token audience.** The upload token's audience must be the account's own
  PDS.
- **Upload size.** Each part must match its planned size exactly. Bodies are
  streamed with a byte cap and never buffered whole.
- **Private uploads.** An upload is only visible to the account that started
  it.
- **Playback paths.** `did`, `cid`, rendition and segment names are checked
  against strict patterns before any file is read.

## State

- **In memory:** upload sessions, job statuses and daily quotas. A restart
  drops uploads in flight (clients start over) and resets the day's counts.
- **On disk:** HLS output under `dataDir`. Keep it on a persistent volume.

## Configuration (`bin.ts`)

| Env                                                | Default                 |
| -------------------------------------------------- | ----------------------- |
| `KRAO_VIDEO_PORT`                                  | `2591`                  |
| `KRAO_VIDEO_DID`                                   | `did:web:video.krao.net` |
| `KRAO_VIDEO_PUBLIC_URL` (did:web document)         | –                       |
| `KRAO_VIDEO_DATA_DIR`                              | `krao-video-data`       |
| `KRAO_PLC_URL`                                     | `https://plc.directory` |
| `KRAO_VIDEO_PDS_URLS` (comma separated, see below) | `https://pds.krao.net`   |
| `KRAO_VIDEO_MAX_BYTES`                             | 100 MiB                 |
| `KRAO_VIDEO_MAX_DURATION_SEC`                      | 180                     |
| `KRAO_VIDEO_DAILY_VIDEOS`                          | 25                      |
| `KRAO_VIDEO_DAILY_BYTES`                           | 10 GiB                  |
| `KRAO_VIDEO_CONCURRENCY`                           | 1                       |
| `KRAO_FFMPEG_PATH` / `KRAO_FFPROBE_PATH`           | `ffmpeg` / `ffprobe`    |

Each `KRAO_VIDEO_PDS_URLS` entry is either a public PDS URL, or
`<public url>=<internal url>` when this service reaches the PDS at a different
address.

**Related settings on other services:**

- **PDS.** `PDS_BLOB_UPLOAD_LIMIT` must be at least `KRAO_VIDEO_MAX_BYTES`.
  The PDS default is 5 MB.
- **App.**
  - `EXPO_PUBLIC_KRAO_VIDEO_URL` is this service's public URL.
  - `EXPO_PUBLIC_KRAO_VIDEO_DID` is `KRAO_VIDEO_DID`.

The dev-env runs the service on :2591. It needs `ffmpeg` and `ffprobe` on the
PATH. The end-to-end check is `packages/krao-e2e/video.mjs`.
