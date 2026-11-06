/**
 * Live end-to-end check against a running DSH instance with the plugin loaded.
 *
 * Usage:
 *   node test/live.e2e.mjs --origin http://127.0.0.1:<proxyPort> --url <pageUrl>
 *
 * It exercises the exact server path the browser uses: proxy fetch -> token ->
 * context analysis -> chunk translation, and prints timings plus the glossary so
 * the "film means 胶片, not 电影" requirement can be checked against a real page.
 */
import { extractPageMeta } from '../lib/html-rewrite.js'

/** Minimal argv parsing. */
function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const origin = String(arg('origin', '')).replace(/\/$/, '')
const pageUrl = String(arg('url', 'https://en.wikipedia.org/wiki/Photographic_film'))
if (origin === '') {
  console.error('missing --origin (see ~/.dsh/page-translator.json for the proxy port)')
  process.exit(2)
}

/** Fetch with a timeout. */
async function timed(label, fn) {
  const started = Date.now()
  const value = await fn()
  return { value, ms: Date.now() - started, label }
}

const pageResponse = await fetch(`${origin}/p?url=${encodeURIComponent(pageUrl)}`)
if (!pageResponse.ok) {
  console.error('proxy page fetch failed:', pageResponse.status, await pageResponse.text())
  process.exit(1)
}
const proxied = await pageResponse.text()
const tokenMatch = /window\.__DSH_PT_BOOT__=(\{.*?\})<\/script>/.exec(proxied)
if (tokenMatch === null) {
  console.error('no boot payload in proxied page')
  process.exit(1)
}
const boot = JSON.parse(tokenMatch[1])
console.log('proxy origin :', origin)
console.log('target page  :', pageUrl)
console.log('proxied bytes:', proxied.length, '| boot.token:', boot.token.slice(0, 8) + '…')

const original = await fetch(pageUrl, {
  headers: {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
}).then((response) => response.text())
const meta = extractPageMeta(original, pageUrl)
console.log('page title   :', meta.title)
console.log('headings     :', meta.headings.slice(0, 5).join(' | '))

const contextStarted = Date.now()
const contextResponse = await fetch(`${origin}/api/context`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-pt-token': boot.token },
  body: JSON.stringify({
    url: pageUrl,
    title: meta.title,
    lang: meta.lang,
    meta: meta.meta,
    headings: meta.headings,
    sample: meta.sample,
  }),
})
const contextData = await contextResponse.json()
const contextMs = Date.now() - contextStarted
if (!contextData.ok) {
  console.error('context call failed:', JSON.stringify(contextData))
  process.exit(1)
}
console.log(`context call : ${contextMs} ms  cached=${contextData.cached}`)
console.log('topic        :', contextData.context.topic)
console.log('domain       :', contextData.context.domain)
console.log('tone         :', contextData.context.tone)
console.log('glossary     :', JSON.stringify(contextData.context.glossary))
console.log('notes        :', contextData.context.notes)

const segments = [
  { id: '1', text: 'Film' },
  { id: '2', text: 'Grain' },
  { id: '3', text: 'Shutter speed and aperture' },
  { id: '4', text: 'Develop your own roll at home' },
  { id: '5', text: 'This community is all about shooting film' },
]
const translateStarted = Date.now()
const translateResponse = await fetch(`${origin}/api/translate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-pt-token': boot.token },
  body: JSON.stringify({ url: pageUrl, target: 'zh', context: contextData.context, segments }),
})
const translateData = await translateResponse.json()
const translateMs = Date.now() - translateStarted
if (!translateData.ok) {
  console.error('translate call failed:', JSON.stringify(translateData))
  process.exit(1)
}
console.log(`translate    : ${translateMs} ms  cached=${translateData.cached}`)
for (const segment of segments) {
  console.log(`  [${segment.id}] ${segment.text}\n      -> ${translateData.translations[segment.id] ?? '(missing)'}`)
}

const film = String(translateData.translations['1'] ?? '')
const filmSide = /胶片|底片|菲林/.test(film)
const movieSide = /电影|影片/.test(film)
console.log('\nFILM CHECK   :', film, filmSide && !movieSide ? 'PASS (胶片语境)' : 'CHECK MANUALLY')
console.log('total wall   :', contextMs + translateMs, 'ms')
