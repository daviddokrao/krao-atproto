# @krao/push

Krao's push notification service, in place of Bluesky's closed "courier".

- Speaks the courier protocol (`proto/courier.proto`, Connect RPC) to the
  AppView, which hands it device tokens (`BSKY_COURIER_URL`).
- Reads the AppView's `notification` table and pushes likes, replies,
  follows and the rest, after each person's push settings, blocks and mutes.
- Takes Krao's own events at `POST /internal/notify` (chat messages, tips,
  points, KYC), see `src/krao-events.ts`.
- Sends through FCM (Android) and APNs (iOS); without keys it only logs, and
  lists what it would have sent at `GET /internal/recent`.

Configuration: `src/bin.ts`. Production wiring: `services/krao`.
