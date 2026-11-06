/**
 * Speed probe for the built-in-browser bridge.
 *
 * Measures the two phases separately so the click-time cost is visible:
 *   - context analysis (now prefetched in the background on page attach)
 *   - chunk translation (the only thing a click waits for when prefetch landed)
 *
 * Usage: node e2e/speed.mjs --host http://127.0.0.1:<port> [--url <page>]
 */
import { extractPageMeta } from '../lib/html-rewrite.js'

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const host = String(arg('host', '')).replace(/\/$/, '')
const pageUrl = String(arg('url', 'https://filmphotographyproject.com/'))
if (host === '') {
  console.error('missing --host')
  process.exit(2)
}

async function timed(label, fn) {
  const started = Date.now()
  const value = await fn()
  return { label, ms: Date.now() - started, value }
}

const script = await timed('hosted.js', () =>
  fetch(host + '/page-translator/hosted.js').then(async (response) => ({
    status: response.status,
    length: (await response.text()).length,
  })),
)
console.log(`${script.label.padEnd(18)} ${String(script.ms).padStart(6)} ms `, JSON.stringify(script.value))
const hostedBody = await fetch(host + '/page-translator/hosted.js').then((response) => response.text())
console.log('icon in controller :', /createIcon/.test(hostedBody) && /ICON_PATHS/.test(hostedBody) ? 'yes' : 'no')

const original = await fetch(pageUrl, {
  headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131 Safari/537.36' },
}).then((response) => response.text())
const meta = extractPageMeta(original, pageUrl)

const contextBody = {
  url: pageUrl,
  title: meta.title,
  lang: meta.lang,
  meta: meta.meta,
  headings: meta.headings,
  sample: meta.sample,
}
const cold = await timed('context cold', () =>
  fetch(host + '/page-translator/context', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(contextBody),
  }).then((response) => response.json()),
)
const warm = await timed('context warm', () =>
  fetch(host + '/page-translator/context', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(contextBody),
  }).then((response) => response.json()),
)
const context = cold.value.context
console.log(`${cold.label.padEnd(18)} ${String(cold.ms).padStart(6)} ms  cached=${cold.value.cached}  llm=${JSON.stringify(cold.value.llm)}`)
console.log(`${warm.label.padEnd(18)} ${String(warm.ms).padStart(6)} ms  cached=${warm.value.cached}`)

async function translate(label, segments, useContext = context) {
  const run = await timed(label, () =>
    fetch(host + '/page-translator/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: pageUrl, target: 'zh', context: useContext, segments }),
    }).then((response) => response.json()),
  )
  const translations = run.value.translations ?? {}
  console.log(
    `${run.label.padEnd(18)} ${String(run.ms).padStart(6)} ms  cached=${run.value.cached}  got=${Object.keys(translations).length}/${segments.length}  llm=${JSON.stringify(run.value.llm)}`,
  )
  return translations
}

const small = [
  { id: '1', text: 'Film' },
  { id: '2', text: 'Develop your own roll at home' },
  { id: '3', text: 'Film shooters and vintage cameras' },
]
await translate('translate 3 seg', small)

// A realistic full page: 90 unique segments => 4 chunks, translated in parallel.
const sentences = [
  'Film grain is part of the look.',
  'Shoot a roll of film today.',
  'Vintage cameras still work great.',
  'Develop black and white film at home.',
  'The film photography community is growing.',
  'Load the film in the dark.',
  'Push the film one stop.',
  'Medium format film has more detail.',
  '35mm film is the classic choice.',
  'Expired film can create surprises.',
]
const many = []
for (let index = 0; index < 90; index += 1) {
  many.push({ id: String(index + 1), text: `${sentences[index % sentences.length]} (${index + 1})` })
}
const manyCold = await translate('translate 90 seg', many)
const manyWarm = await translate('translate 90 seg', many)
await translate('translate 90 seg', many)

// Same page split into smaller chunks, fired in parallel: what a tuned
// CHUNK_CHARS/CONCURRENCY would do to wall time.
const groups = []
for (let index = 0; index < many.length; index += 15) groups.push(many.slice(index, index + 15))
const parallelStarted = Date.now()
const parallelResults = await Promise.all(
  groups.map((group) =>
    fetch(host + '/page-translator/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: pageUrl + '#split', target: 'zh', context: null, segments: group }),
    }).then((response) => response.json()),
  ),
)
const parallelMs = Date.now() - parallelStarted
const parallelGot = parallelResults.reduce((sum, result) => sum + Object.keys(result.translations ?? {}).length, 0)
console.log(`${'90 seg / 6 chunks'.padEnd(18)} ${String(parallelMs).padStart(6)} ms  got=${parallelGot}/${many.length}`)

const film = String((small.length > 0 ? null : null) ?? '')
console.log('\nfilm check        :', JSON.stringify(manyCold['1'] ?? ''), JSON.stringify(manyWarm['1'] ?? ''))
console.log('total user-visible click cost (warm context): translate time above (minus context lines)')
