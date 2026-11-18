#!/usr/bin/env node
/**
 * Renames the product across krao-atproto and krao-app (see DESIGN-brand.md).
 *
 *   node scripts/krao-rebrand.mjs --name Abc --domain abc.io [--nsid io.abc]
 *     [--app-id io.abc.app] [--scheme abc] [--slug abc] [--dry-run]
 *
 * Runtime values (name, domain, hosts, emails...) live in brand.json and are
 * only written there. Compile-time values are rewritten in every tracked text
 * file of both repos:
 *   - the lexicon namespace (NSID): `net.krao.x` strings, `net/krao` paths
 *     (lexicon folders are moved), and `import {net}` from generated lexicons
 *   - the app id (`io.krao.app` and its extension ids)
 * Afterwards: run codegen and the checks it prints. Commit first: the script
 * refuses to run on a dirty tree (except with --dry-run).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ATPROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPOS = {
  atproto: { dir: ATPROTO, brand: 'packages/krao-brand/brand.json' },
  // The app's clone sits next to this one unless KRAO_APP_DIR says otherwise
  app: {
    dir: process.env.KRAO_APP_DIR ?? path.join(ATPROTO, '..', 'krao-app'),
    brand: 'brand.json',
  },
}

// Arguments
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const DRY = args.includes('--dry-run')
if (args.includes('--help') || args.length === 0) {
  console.log(
    fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0],
  )
  process.exit(0)
}

const git = (dir, ...a) =>
  execFileSync('git', ['-C', dir, ...a], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })

// Current brand: both copies must agree
const brands = Object.values(REPOS).map((r) =>
  JSON.parse(fs.readFileSync(path.join(r.dir, r.brand), 'utf8')),
)
if (JSON.stringify(brands[0]) !== JSON.stringify(brands[1])) {
  fail(
    'brand.json differs between krao-atproto and krao-app; make them equal first',
  )
}
const old = brands[0]

const domain = opt('domain') ?? old.domain
const next = structuredClone(old)
next.name = opt('name') ?? old.name
next.domain = domain
next.nsid =
  opt('nsid') ??
  (opt('domain') ? domain.split('.').reverse().join('.') : old.nsid)
// Before launch the app's identity follows the brand unless given
const renamed = next.name !== old.name || next.domain !== old.domain
const lowerName = next.name.toLowerCase().replace(/[^a-z0-9]/g, '')
next.app.id =
  opt('app-id') ??
  (renamed ? `${next.nsid.split('.').slice(0, 2).join('.')}.app` : old.app.id)
next.app.scheme = opt('scheme') ?? (renamed ? lowerName : old.app.scheme)
next.app.slug = opt('slug') ?? (renamed ? lowerName : old.app.slug)
// Values that embed the domain follow it (emails, official handle...)
replaceDeep(next, (s) =>
  old.domain !== domain ? s.split(old.domain).join(domain) : s,
)

// Validation
const NSID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/
if (!NSID_RE.test(next.nsid)) {
  fail(
    `--nsid "${next.nsid}": lower-case letters and digits, 2+ dot-separated segments, no hyphens (they become JS identifiers)`,
  )
}
if (!/^[a-z][a-z0-9.-]*\.[a-z]{2,}$/.test(domain))
  fail(`--domain "${domain}" does not look like a domain`)
if (!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(next.app.id))
  fail(`--app-id "${next.app.id}"`)
if (!/^[a-z][a-z0-9+.-]*$/.test(next.app.scheme))
  fail(`--scheme "${next.app.scheme}"`)
if (next.nsid !== domain.split('.').reverse().join('.')) {
  console.warn(
    `⚠️  NSID ${next.nsid} is not the reverse of ${domain}: lexicon resolution needs DNS on ${next.nsid.split('.').reverse().join('.')}`,
  )
}

if (!DRY) {
  for (const [name, r] of Object.entries(REPOS)) {
    if (git(r.dir, 'status', '--porcelain').trim())
      fail(`${name}: commit or stash your changes first`)
  }
}

// Text rewrites
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const rules = []
if (old.nsid !== next.nsid) {
  // net.krao.x / net/krao/x, not inside a longer name (eg "internet.krao")
  rules.push([
    new RegExp(`(?<![A-Za-z0-9_-])${esc(old.nsid)}(?![A-Za-z0-9_-])`, 'g'),
    next.nsid,
  ])
  const oldPath = old.nsid.replaceAll('.', '/')
  rules.push([
    new RegExp(`(?<![A-Za-z0-9_-])${esc(oldPath)}(?![A-Za-z0-9_-])`, 'g'),
    next.nsid.replaceAll('.', '/'),
  ])
}
if (old.app.id !== next.app.id) {
  rules.push([
    new RegExp(`(?<![A-Za-z0-9_-])${esc(old.app.id)}(?![A-Za-z0-9_-])`, 'g'),
    next.app.id,
  ])
}
if (old.domain !== next.domain) {
  // Code reads brand.json; this catches config files, comments and docs
  rules.push([
    new RegExp(`(?<![A-Za-z0-9_-])${esc(old.domain)}(?![A-Za-z0-9_-])`, 'g'),
    next.domain,
  ])
}
/** Static files that cannot read brand.json: the name is written in them */
const NAME_FILES = /\.(html|plist)$/
const nameRule =
  old.name !== next.name
    ? [
        new RegExp(`(?<![A-Za-z0-9_-])${esc(old.name)}(?![A-Za-z0-9_-])`, 'g'),
        next.name,
      ]
    : undefined
const oldTop = old.nsid.split('.')[0]
const newTop = next.nsid.split('.')[0]
const cap = (s) => s[0].toUpperCase() + s.slice(1)
const pascal = (nsid) => nsid.split('.').map(cap).join('')
/** Names generated from the NSID: `NetNS`, `NetKraoFeedTip`, `netKrao` */
const codeRules = []
if (old.nsid !== next.nsid) {
  const word = (s) =>
    new RegExp(`(?<![A-Za-z0-9_$])${esc(s)}(?![a-z0-9_$])`, 'g')
  codeRules.push([word(pascal(old.nsid)), pascal(next.nsid)])
  codeRules.push([
    word(old.nsid.split('.')[0] + pascal(old.nsid).slice(cap(oldTop).length)),
    newTop + pascal(next.nsid).slice(cap(newTop).length),
  ])
  if (oldTop !== newTop) {
    codeRules.push([
      new RegExp(`(?<![A-Za-z0-9_$])${cap(oldTop)}NS(?![A-Za-z0-9_$])`, 'g'),
      `${cap(newTop)}NS`,
    ])
    codeRules.push([
      new RegExp(`^(\\s*)${oldTop}( = new ${cap(newTop)}NS\\(this\\))`, 'gm'),
      `$1${newTop}$2`,
    ])
  }
}

const summary = []
for (const [name, r] of Object.entries(REPOS)) {
  const files = git(r.dir, 'ls-files', '-z').split('\0').filter(Boolean)
  let changed = 0
  let hits = 0
  for (const rel of files) {
    if (rel === r.brand) continue
    const abs = path.join(r.dir, rel)
    let text
    try {
      const buf = fs.readFileSync(abs)
      if (buf.includes(0)) continue // binary
      text = buf.toString('utf8')
    } catch {
      continue // deleted, submodule...
    }
    let out = text
    const fileRules =
      nameRule && NAME_FILES.test(rel) ? [...rules, nameRule] : rules
    for (const [re, to] of fileRules) {
      out = out.replace(re, () => {
        hits++
        return to
      })
    }
    if (/\.(m?[jt]sx?|cts)$/.test(rel)) {
      for (const [re, to] of codeRules) {
        out = out.replace(re, (...m) => {
          hits++
          return to.replace(/\$(\d)/g, (_, i) => m[i])
        })
      }
      if (oldTop !== newTop && out !== text)
        out = renameImports(dropDuplicateNS(out))
    }
    if (out !== text) {
      changed++
      if (!DRY) fs.writeFileSync(abs, out)
    }
  }
  // Move lexicon folders (net/krao -> io/abc) and any path naming the NSID
  const moves = []
  if (old.nsid !== next.nsid) {
    const oldSeg = `/${old.nsid.replaceAll('.', '/')}/`
    const newSeg = `/${next.nsid.replaceAll('.', '/')}/`
    for (const rel of files) {
      const p = `/${rel}`
      if (p.includes(oldSeg))
        moves.push([rel, p.replace(oldSeg, newSeg).slice(1)])
    }
    if (!DRY) {
      for (const [from, to] of moves) {
        fs.mkdirSync(path.dirname(path.join(r.dir, to)), { recursive: true })
        git(r.dir, 'mv', from, to)
      }
    }
  }
  if (!DRY) {
    fs.writeFileSync(
      path.join(r.dir, r.brand),
      JSON.stringify(next, null, 2) + '\n',
    )
    // The lexicon docs carry the name and NSIDs (a unit test compares them)
    const docs = path.join(r.dir, 'scripts/krao-lexicon-docs.mjs')
    if (fs.existsSync(docs))
      execFileSync(process.execPath, [docs], { cwd: r.dir, stdio: 'ignore' })
  }
  summary.push(
    `${name}: ${hits} replacements in ${changed} files, ${moves.length} files moved, brand.json updated`,
  )
}

console.log(
  `${DRY ? '[dry run] ' : ''}${old.name} (${old.domain}, ${old.nsid}, ${old.app.id}) -> ${next.name} (${next.domain}, ${next.nsid}, ${next.app.id})`,
)
for (const line of summary) console.log(`  ${line}`)
console.log(`
Next steps:
  1. Format (shorter or longer names re-wrap lines), codegen and checks
     atproto (WSL): commit, sync.sh, \`pnpm exec prettier --write .\` (copy back with fmt.sh or amend
          from WSL), \`pnpm codegen && pnpm build\`, \`pnpm verify\`, unit tests, e2e
     app: \`pnpm lexicons:generate\` (then fix \`\\\\\` -> \`/\` in src/lexicons imports, see HANDOFF),
          \`pnpm intl:extract\` is not needed (UI strings use {BRAND_NAME}),
          \`pnpm prettier --write .\`, \`pnpm typecheck && pnpm lint && pnpm test\`
  2. By hand
     - logos: replace the files in krao-app/assets/brand/ (same names)
     - DNS for ${domain}: web + ${Object.values(next.hosts ?? {})
       .map((h) => `${h}.${domain}`)
       .join(', ')}
     - lexicon resolution: \`_lexicon\` TXT records under ${next.nsid.split('.').reverse().join('.')} (services/krao/deploy/dns-lexicon.md), then publish the lexicons
     - OAuth client metadata, app store listing (${next.app.id}), push certificates for the new app id
     - existing records keep their old NSID: only rebrand before launch, or migrate data`)

/** `net = new NetNS(this)` became a second `com = new ComNS(this)`: drop it */
function dropDuplicateNS(src) {
  const seen = new Set()
  return src.replace(
    /^(\s*)(\w+) = new (\w+NS)\(this\)\n/gm,
    (line, _i, prop, cls) => {
      const key = `${prop}=${cls}`
      if (seen.has(key)) return ''
      seen.add(key)
      return line
    },
  )
}

/**
 * `import {com, net} from '...lexicons...'` -> `{com, io}`; any import list
 * that now names something twice (`ComNS, ComNS`) is deduplicated
 */
function renameImports(src) {
  return src.replace(
    /import\s*(type\s*)?\{([^}]*)\}\s*from\s*(['"][^'"]*['"])/g,
    (all, type = '', names, from) => {
      const fromLexicons = /lexicons|client/.test(from)
      const list = names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
      const hasOld =
        fromLexicons &&
        list.some((n) => n === oldTop || n.startsWith(`${oldTop} as `))
      if (!hasOld && new Set(list).size === list.length) return all
      const seen = new Set()
      const renamed = list
        .map((n) =>
          !fromLexicons
            ? n
            : n === oldTop
              ? newTop
              : n.startsWith(`${oldTop} as `)
                ? `${newTop}${n.slice(oldTop.length)}`
                : n,
        )
        .filter((n) => (seen.has(n) ? false : seen.add(n)))
      // Keep the file's style: `{a, b}` (app) or `{ a, b }` (atproto), or one per line
      const body = names.includes('\n')
        ? `\n  ${renamed.join(',\n  ')},\n`
        : /^\s/.test(names)
          ? ` ${renamed.join(', ')} `
          : renamed.join(', ')
      return `import ${type}{${body}} from ${from}`
    },
  )
}

function replaceDeep(obj, fn) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') obj[k] = fn(v)
    else if (v && typeof v === 'object') replaceDeep(v, fn)
  }
}

function fail(msg) {
  console.error(`✖ ${msg}`)
  process.exit(1)
}
