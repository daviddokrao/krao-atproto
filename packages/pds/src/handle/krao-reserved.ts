import { BRAND } from '@krao/brand'

/**
 * Handles Krao keeps for itself, on top of upstream's reserved list.
 *
 * The Krao app serves profiles at short URLs (`krao.net/<name>` for
 * `<name>.krao.net`), so a handle must not clash with a top-level page of the
 * app. Most app pages are already in the upstream list; these are the ones it
 * lacks, plus Krao's own names. Keep in step with the app's
 * `src/lib/routes/shortProfile.ts` (its router pages and EXTRA_RESERVED).
 */
export const kraoReserved = [
  // app pages missing from the upstream list
  'atmosphere',
  'community-guidelines',
  'find-contacts',
  'hashtag',
  'iframe',
  'intent',
  'kyc',
  'moderation',
  'ogcard',
  'points',
  'referral',
  'rewards',
  'saved',
  'starter-pack',
  'starter-pack-short',
  'video-feed',
  'wallet',
  // The brand's own names (its official account uses the domain itself),
  // eg kraonet, krao-net, kraoteam, krao-team
  ...brandNames(),
]

function brandNames(): string[] {
  const domain = BRAND.domain.toLowerCase()
  // Accents folded ("Krào" -> "krao"); letters with no ASCII form dropped
  const name = BRAND.name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return [
    domain.replace(/\./g, ''),
    domain.replace(/\./g, '-'),
    ...(name ? [`${name}team`, `${name}-team`] : []),
  ]
}
