#!/usr/bin/env node
// Developer docs for Krao's lexicons (net.krao.*), generated from
// lexicons/net/krao into docs/krao/lexicons.md.
//
//   node scripts/krao-lexicon-docs.mjs          write docs/krao/lexicons.md
//   node scripts/krao-lexicon-docs.mjs --check  exit 1 when the docs are out of
//                                                date or a permission set or
//                                                docs/krao/miniapps.md names
//                                                something that does not exist
//
// No dependencies: plain Node.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LEXICONS = path.join(ROOT, 'lexicons', 'net', 'krao')
export const DOCS = path.join(ROOT, 'docs', 'krao', 'lexicons.md')
const MINIAPP_DOCS = path.join(ROOT, 'docs', 'krao', 'miniapps.md')

/** Every net.krao lexicon document, by NSID */
export function loadLexicons(dir = LEXICONS) {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(d, e.name))
        : e.name.endsWith('.json')
          ? [path.join(d, e.name)]
          : [],
    )
  const docs = walk(dir).map((file) => JSON.parse(readFileSync(file, 'utf8')))
  return new Map(
    docs.sort((a, b) => a.id.localeCompare(b.id)).map((d) => [d.id, d]),
  )
}

const cell = (text) =>
  String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim()

const anchor = (nsid, def = 'main') =>
  (def === 'main' ? nsid : `${nsid}-${def}`).toLowerCase().replace(/\./g, '')

/** A ref as a link to its section */
function refLink(ref, nsid) {
  const [target, def = 'main'] = ref.startsWith('#')
    ? [nsid, ref.slice(1)]
    : ref.split('#')
  if (!target.startsWith('net.krao.')) return `\`${ref}\``
  return `[\`${target}${def === 'main' ? '' : '#' + def}\`](#${anchor(target, def)})`
}

/** A schema's type in one line */
function typeOf(schema, nsid) {
  if (!schema) return ''
  switch (schema.type) {
    case 'ref':
      return refLink(schema.ref, nsid)
    case 'union':
      return (
        schema.refs.map((r) => refLink(r, nsid)).join(' \\| ') +
        (schema.closed ? '' : ' (open)')
      )
    case 'array':
      return `${typeOf(schema.items, nsid)}[]`
    case 'string': {
      const parts = []
      if (schema.format) parts.push(schema.format)
      if (schema.knownValues) {
        parts.push(schema.knownValues.map((v) => `\`${v}\``).join(', '))
      }
      if (schema.enum) parts.push(schema.enum.map((v) => `\`${v}\``).join(', '))
      if (schema.maxGraphemes) parts.push(`≤ ${schema.maxGraphemes} graphemes`)
      return `string${parts.length ? ` (${parts.join('; ')})` : ''}`
    }
    case 'integer': {
      const range = [
        schema.minimum !== undefined ? `≥ ${schema.minimum}` : '',
        schema.maximum !== undefined ? `≤ ${schema.maximum}` : '',
        schema.default !== undefined ? `default ${schema.default}` : '',
      ].filter(Boolean)
      return `integer${range.length ? ` (${range.join(', ')})` : ''}`
    }
    case 'blob':
      return `blob (${[
        schema.accept?.join(', '),
        schema.maxSize ? `≤ ${schema.maxSize} bytes` : '',
      ]
        .filter(Boolean)
        .join('; ')})`
    default:
      return schema.type
  }
}

function propertiesTable(object, nsid) {
  const props = Object.entries(object?.properties ?? {})
  if (!props.length) return ['_No properties._', '']
  const required = new Set(object.required ?? [])
  return [
    '| Name | Type | Required | Description |',
    '| --- | --- | --- | --- |',
    ...props.map(
      ([name, schema]) =>
        `| \`${name}\` | ${cell(typeOf(schema, nsid))} | ${required.has(name) ? 'yes' : ''} | ${cell(schema.description)} |`,
    ),
    '',
  ]
}

function bodySection(title, body, nsid) {
  if (!body) return []
  const lines = [`**${title}** (\`${body.encoding}\`)`, '']
  if (!body.schema) return lines
  if (body.schema.type === 'object') {
    return [...lines, ...propertiesTable(body.schema, nsid)]
  }
  return [...lines, `Schema: ${typeOf(body.schema, nsid)}`, '']
}

function defSection(nsid, name, def) {
  const title = name === 'main' ? nsid : `${nsid}#${name}`
  const lines = [
    `<a id="${anchor(nsid, name)}"></a>`,
    '',
    `### \`${title}\``,
    '',
    `Type: **${def.type}**${def.key ? ` (record key: \`${def.key}\`)` : ''}`,
    '',
  ]
  if (def.description) lines.push(def.description, '')
  switch (def.type) {
    case 'query':
    case 'procedure':
      if (def.parameters) {
        lines.push(
          '**Parameters**',
          '',
          ...propertiesTable(def.parameters, nsid),
        )
      }
      lines.push(...bodySection('Input', def.input, nsid))
      lines.push(...bodySection('Output', def.output, nsid))
      break
    case 'record':
      lines.push(...propertiesTable(def.record, nsid))
      break
    case 'object':
      lines.push(...propertiesTable(def, nsid))
      break
    case 'permission-set':
      if (def.title) lines.push(`Title: ${def.title}`, '')
      if (def.detail) lines.push(def.detail, '')
      for (const p of def.permissions ?? []) {
        const items = p.collection ?? p.lxm ?? []
        const extra = [
          p.action ? `actions: ${p.action.join(', ')}` : '',
          p.inheritAud ? 'audience from the `include:` scope' : '',
        ].filter(Boolean)
        lines.push(
          `- \`${p.resource}\`${extra.length ? ` (${extra.join('; ')})` : ''}: ${items.map((i) => `\`${i}\``).join(', ')}`,
        )
      }
      lines.push('')
      break
    default:
      lines.push(`Schema: ${typeOf(def, nsid)}`, '')
  }
  if (def.errors?.length) {
    lines.push(
      '**Errors**',
      '',
      ...def.errors.map(
        (e) => `- \`${e.name}\`${e.description ? `: ${e.description}` : ''}`,
      ),
      '',
    )
  }
  return lines
}

/** The generated Markdown */
export function render(lexicons = loadLexicons()) {
  const groups = new Map()
  for (const nsid of lexicons.keys()) {
    // Top-level NSIDs (the permission sets) under net.krao itself
    const parts = nsid.split('.')
    const group = parts.slice(0, parts.length > 3 ? 3 : 2).join('.')
    groups.set(group, [...(groups.get(group) ?? []), nsid])
  }
  const lines = [
    '# Krao lexicons (`net.krao.*`)',
    '',
    '<!-- Generated by scripts/krao-lexicon-docs.mjs from lexicons/net/krao. Do not edit by hand: run the script. -->',
    '',
    "Krao's records, XRPC methods and OAuth permission sets. Methods are served by Krao's services:",
    'the indexer (most `net.krao.*` queries, wallet previews, Mini Apps), the rewards service',
    '(`account`, `kyc`, `phone`, `points`, `referral`, `rewards`, `analytics`, `push`) and the PDS',
    "(`server`). Methods marked as needing service auth take a token from the user's PDS",
    '(`com.atproto.server.getServiceAuth`, audience the service DID, `lxm` the method).',
    'Mini App developers: see [miniapps.md](./miniapps.md).',
    '',
    '## Contents',
    '',
  ]
  for (const [group, ids] of groups) {
    lines.push(
      `- **${group}**: ${ids.map((id) => `[\`${id.slice(group.length + 1) || id}\`](#${anchor(id)})`).join(', ')}`,
    )
  }
  lines.push('')
  for (const [group, ids] of groups) {
    lines.push(`## ${group}`, '')
    for (const id of ids) {
      const doc = lexicons.get(id)
      const defs = Object.entries(doc.defs)
      // main first, then the other defs in file order
      defs.sort(([a], [b]) => (a === 'main' ? -1 : b === 'main' ? 1 : 0))
      if (!doc.defs.main) {
        // defs files (no main): the NSID itself is linkable too
        lines.push(`<a id="${anchor(id)}"></a>`, '')
      }
      for (const [name, def] of defs) {
        lines.push(...defSection(id, name, def))
      }
    }
  }
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  )
}

/** Problems that make --check fail */
export function check(lexicons = loadLexicons()) {
  const problems = []
  let current = ''
  try {
    // A Windows checkout may have CRLF line endings
    current = readFileSync(DOCS, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    problems.push(`${path.relative(ROOT, DOCS)} is missing`)
  }
  if (current && current !== render(lexicons)) {
    problems.push(
      `${path.relative(ROOT, DOCS)} is out of date: run node scripts/krao-lexicon-docs.mjs`,
    )
  }
  const kinds = new Map(
    [...lexicons].map(([id, doc]) => [id, doc.defs.main?.type]),
  )
  for (const [id, doc] of lexicons) {
    if (doc.defs.main?.type !== 'permission-set') continue
    for (const p of doc.defs.main.permissions ?? []) {
      const wanted = p.resource === 'repo' ? ['record'] : ['query', 'procedure']
      for (const item of p.collection ?? p.lxm ?? []) {
        if (!item.startsWith('net.krao.')) {
          problems.push(
            `${id}: ${item} is outside net.krao (not allowed in a permission set)`,
          )
        } else if (!wanted.includes(kinds.get(item))) {
          problems.push(`${id}: ${item} is not a net.krao ${wanted.join('/')}`)
        } else if (item.includes('.admin.')) {
          problems.push(`${id}: ${item} is an admin method`)
        }
      }
    }
  }
  let guide = ''
  try {
    guide = readFileSync(MINIAPP_DOCS, 'utf8')
  } catch {
    problems.push(`${path.relative(ROOT, MINIAPP_DOCS)} is missing`)
  }
  for (const nsid of guide.match(/net\.krao\.[a-zA-Z0-9.]+[a-zA-Z0-9]/g) ??
    []) {
    if (!lexicons.has(nsid)) {
      problems.push(`miniapps.md names ${nsid}, which is not a lexicon`)
    }
  }
  for (const id of lexicons.keys()) {
    if (
      /^net\.krao\.(miniapp|wallet|embed)\./.test(id) &&
      !id.endsWith('.defs') &&
      !guide.includes(id)
    ) {
      problems.push(`miniapps.md does not describe ${id}`)
    }
  }
  return problems
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  if (process.argv.includes('--check')) {
    const problems = check()
    for (const p of problems) console.error(`✗ ${p}`)
    if (problems.length) process.exit(1)
    console.log('Krao lexicon docs are up to date')
  } else {
    writeFileSync(DOCS, render())
    console.log(`Wrote ${path.relative(ROOT, DOCS)}`)
  }
}
