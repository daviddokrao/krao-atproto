// Runs every Krao end-to-end check in milestone order; pass names to run a
// subset (`node run-all.mjs tip gate`).
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ALL = [
  'records',
  'wallet',
  'tip',
  'nft',
  'gate',
  'feed',
  'link-preview',
  'gifs',
  'starter-packs',
  'video',
  'handles',
  'chat',
  'discovery',
  'chat-moderation',
  'referral',
  'push',
  'compliance',
  'safety',
  'smartwallet',
  'community',
  'poll',
  'search',
  'token',
  'growth',
  'miniapps',
  'safety2',
  // Moves the Anvil clock 31 days forward, so it runs last
  'membership',
]
const selected = process.argv.slice(2)
const unknown = selected.filter((name) => !ALL.includes(name))
if (unknown.length) {
  console.error(
    `Unknown check: ${unknown.join(', ')} (have: ${ALL.join(', ')})`,
  )
  process.exit(2)
}

const failed = []
for (const name of selected.length ? selected : ALL) {
  console.log(`\n== ${name}`)
  const file = fileURLToPath(new URL(`./${name}.mjs`, import.meta.url))
  const { status } = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  if (status !== 0) failed.push(name)
}
console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : '\nAll passed')
process.exit(failed.length ? 1 : 0)
