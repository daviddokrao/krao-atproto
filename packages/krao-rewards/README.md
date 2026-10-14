# @krao/rewards

Krao's rewards service: mandatory referral codes, an off-chain points
ledger, reward rules kept as data, and identity verification (KYC). Points
have no monetary value; they may be converted to a token later.

## Sign-up needs a referral code

- The PDS keeps upstream's invite-code flow: `describeServer` reports
  `inviteCodeRequired` (`PDS_INVITE_REQUIRED`), and the app shows the code
  field.
- With `PDS_KRAO_REWARDS_URL` set, the code is a **Krao referral code**:
  - Before creating the account, the PDS asks this service
    (`/internal/check-code`). If the service is down, sign-up fails: the code
    is required.
  - The sign-up goes into the PDS's `krao_referral_outbox` in the account's
    transaction, and is delivered to `/internal/referrals` with retries. A
    new account never loses its referrer. Delivery is idempotent.
  - Both internal routes need `PDS_KRAO_REWARDS_TOKEN` =
    `KRAO_REWARDS_INTERNAL_TOKEN`.
- Codes are case-insensitive, 3–32 letters, digits or dashes.
  - **personal**: one per account, 8 characters, created on first
    `net.krao.referral.getOverview`; unlimited uses.
  - **campaign** / **partner**: made by admins, optionally with an owner
    (credited as referrer), a campaign id, a use limit and an expiry.
- A sign-up whose code stopped passing between check and delivery (used up,
  disabled) is kept and flagged for admins, not rewarded.

## Points

- `points_entry` is append-only. Each entry records the rule and rule version
  that created it, its event, the other account involved, and its
  **vesting** conditions:
  - `kyc:self`: the account getting the points has passed KYC;
  - `kyc:related`: the other side (referrer or referred account) has.
- Entries start `pending` and become `approved` when every condition holds,
  re-checked whenever a KYC is approved.
- Taking points back never edits numbers: pending entries are voided,
  approved ones get a negative entry. This happens on a final KYC rejection
  (including duplicates) and on `admin.revokePoints`.

## Rules

- Stored in `reward_rule`; admins change them with
  `net.krao.rewards.admin.upsertRule`, no deploy needed. A change bumps the
  version and applies from then on.
- A rule: event (`account.created`, `kyc.approved`), beneficiary (`actor`,
  `referrer`, `referrer2`), amount, vesting, and optional filters (code kinds,
  campaign, validity window) and caps (per account in total, per day).
- Defaults (seeded into an empty table): `referral.inviter` +100 to the
  referrer and `referral.invitee` +50 to the new account, both vesting on
  `kyc:self` and `kyc:related`.
- Events are stored in `reward_event`, once per id.

## KYC

- Krao keeps only the outcome (`kyc_record`), never documents.
- **Provider:** an adapter (`KycProvider`); Sumsub ships.
  - `net.krao.kyc.startVerification` returns a Sumsub WebSDK link that the
    app opens in a browser.
  - Sumsub calls `POST /webhooks/sumsub`, checked with the webhook secret
    (`X-Payload-Digest`). GREEN approves; RED + RETRY allows another try;
    RED + FINAL rejects. Turn on duplicate detection in the level: a
    `DUPLICATE` label rejects the account and voids what depended on it.
  - Not yet tried against a live Sumsub account.
- **Manual review** (`admin.reviewKyc`), for exceptions:
  - needs a reason code and a note of at least 10 characters;
  - limited per day across reviewers (`KRAO_KYC_MANUAL_DAILY_LIMIT`, 5);
  - optionally needs two different reviewers to approve
    (`KRAO_KYC_REQUIRE_SECOND_APPROVER`);
  - logged in `audit_log`, like every admin and KYC change.

## Auth

- Users and admins call with atproto service auth addressed to
  `KRAO_REWARDS_DID`.
- Admins: `KRAO_REWARDS_ADMIN_DIDS` (all admin methods),
  `KRAO_KYC_REVIEWER_DIDS` (KYC methods only).

## Config

| Variable                                | Default                    |
| --------------------------------------- | -------------------------- |
| `KRAO_REWARDS_PORT`                     | `2592`                     |
| `KRAO_REWARDS_DID`                      | `did:web:rewards.krao.net` |
| `KRAO_REWARDS_PUBLIC_URL`               | (serves `did.json` if set) |
| `KRAO_REWARDS_DB`                       | `krao-rewards.sqlite`      |
| `KRAO_PLC_URL`                          | `https://plc.directory`    |
| `KRAO_REWARDS_INTERNAL_TOKEN`           | required                   |
| `KRAO_REWARDS_ADMIN_DIDS`               |                            |
| `KRAO_KYC_REVIEWER_DIDS`                |                            |
| `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY` | (no KYC provider if unset) |
| `SUMSUB_LEVEL`                          | `basic-kyc-level`          |
| `SUMSUB_WEBHOOK_SECRET`                 | required with Sumsub       |
| `KRAO_KYC_MANUAL_DAILY_LIMIT`           | `5`                        |
| `KRAO_KYC_REQUIRE_SECOND_APPROVER`      | `false`                    |

## Dev-env

Runs on port 2592 with DID `did:web:rewards.krao.test` and no KYC provider.
It creates the campaign code `KRAO-DEV` (the seed script and e2e tests sign
up with it) and the admin account `rewards-admin.test` / `krao-dev-pass`.
Codes become required once the dev-env's own accounts exist.
