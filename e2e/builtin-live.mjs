/**
 * Live check of the built-in-browser bridge routes on a running DSH host.
 *
 * Usage: node e2e/builtin-live.mjs --host http://127.0.0.1:<port> [--url <page>]
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

const script = await fetch(host + '/page-translator/hosted.js').then(async (response) => {
  const text = await response.text()
  return { status: response.status, length: text.length, hasApi: /__DSH_PT_PAGE__/.test(text) }
})
console.log('hosted.js   :', JSON.stringify(script))

const original = await fetch(pageUrl, {
  headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131 Safari/537.36' },
}).then((response) => response.text())
const meta = extractPageMeta(original, pageUrl)
console.log('target page :', meta.title)

const started = Date.now()
const context = await fetch(host + '/page-translator/context', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: pageUrl,
    title: meta.title,
    lang: meta.lang,
    meta: meta.meta,
    headings: meta.headings,
    sample: meta.sample,
  }),
}).then((response) => response.json())
console.log('context     :', Date.now() - started + 'ms', 'ok=' + context.ok)
console.log('  topic     :', context.context?.topic)
console.log('  glossary  :', JSON.stringify(context.context?.glossary ?? {}).slice(0, 220))

const segments = [
  { id: '1', text: 'Film' },
  { id: '2', text: 'Develop your own roll at home' },
  { id: '3', text: 'Film shooters and vintage cameras' },
]
const translateStarted = Date.now()
const translated = await fetch(host + '/page-translator/translate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: pageUrl, target: 'zh', context: context.context, segments }),
}).then((response) => response.json())
console.log('translate   :', Date.now() - translateStarted + 'ms', 'ok=' + translated.ok, 'cached=' + translated.cached)
for (const segment of segments) console.log(`  [${segment.id}] ${segment.text} -> ${translated.translations?.[segment.id]}`)
const film = String(translated.translations?.['1'] ?? '')
console.log('FILM CHECK  :', film, /胶片|底片|菲林/.test(film) && !/电影|影片/.test(film) ? 'PASS' : 'CHECK')
