/**
 * Live browser-half E2E in jsdom against a running DSH host with the plugin loaded.
 *
 * It loads the real proxied page, runs the real `lib/page-script.js`, clicks the
 * toolbar button and verifies that text nodes are replaced in place, that the
 * original layout nodes survive, and that a second click restores the source.
 *
 * Usage:
 *   node test/browser.e2e.mjs --origin http://127.0.0.1:<proxyPort> --url <pageUrl>
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const scriptSource = readFileSync(join(here, '..', 'lib', 'page-script.js'), 'utf8')
const requireFromSuperagent = createRequire(join(here, '..', '..', '..', 'dsh-superagent', 'package.json'))
const { JSDOM } = requireFromSuperagent('jsdom')

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const origin = String(arg('origin', '')).replace(/\/$/, '')
const pageUrl = String(arg('url', 'https://filmphotographyproject.com/'))
if (origin === '') {
  console.error('missing --origin (see ~/.dsh/page-translator.json for the proxy port)')
  process.exit(2)
}

const proxyUrl = `${origin}/p?url=${encodeURIComponent(pageUrl)}`
const pageHtml = await fetch(proxyUrl).then((response) => {
  if (!response.ok) throw new Error(`proxy returned ${response.status}`)
  return response.text()
})
const bootMatch = /window\.__DSH_PT_BOOT__=(\{.*?\})<\/script>/.exec(pageHtml)
if (bootMatch === null) throw new Error('no boot payload')
const boot = JSON.parse(bootMatch[1])

const dom = new JSDOM(pageHtml, { url: proxyUrl, runScripts: 'outside-only' })
const { window } = dom
const { document } = window
// jsdom has no fetch; bridge to Node and drop the abort signal (different realm).
window.fetch = (input, init) => {
  const target = typeof input === 'string' ? new URL(input, origin).href : input
  const { signal: _signal, ...rest } = init ?? {}
  return fetch(target, rest)
}
window.__DSH_PT_BOOT__ = boot
window.eval(scriptSource)

const textOf = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
const cjkRatio = (text) => {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return text.length === 0 ? 0 : cjk / text.length
}
const bodyBefore = textOf(document.body)
const englishCharsBefore = (bodyBefore.match(/[A-Za-z]/g) ?? []).length
// Anchor on the site name: a node that must be translated in place.
const siteNode = (() => {
  const walker = document.createTreeWalker(document.body, 4)
  let node
  while ((node = walker.nextNode()) !== null) {
    if ((node.nodeValue ?? '').includes('Film Photography Project')) return node
  }
  return null
})()
const siteBefore = siteNode === null ? '' : siteNode.nodeValue

const button = document.querySelector('#dsh-pt-root')
if (button === null) throw new Error('translate button was not injected')
console.log('button       :', textOf(button))
console.log('anchor before:', JSON.stringify(siteBefore))

const started = Date.now()
button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const deadline = Date.now() + 180_000
while (Date.now() < deadline) {
  if (button.getAttribute('data-state') === 'done') break
  if (button.getAttribute('data-state') === 'error') throw new Error('translation failed: ' + button.getAttribute('title'))
  await new Promise((resolve) => setTimeout(resolve, 250))
}
const elapsed = Date.now() - started
if (button.getAttribute('data-state') !== 'done') throw new Error('timed out waiting for translation')
console.log('button done  :', textOf(button).slice(0, 120))

const siteAfter = siteNode === null ? '' : siteNode.nodeValue
const bodyAfter = textOf(document.body)
const englishCharsAfter = (bodyAfter.match(/[A-Za-z]/g) ?? []).length
const paragraphs = document.querySelectorAll('p,h2,h3,li').length
const translatedNodes = (() => {
  let count = 0
  const walker = document.createTreeWalker(document.body, 4)
  let node
  while ((node = walker.nextNode()) !== null) {
    if (cjkRatio(node.nodeValue ?? '') > 0.3 && /[\u4e00-\u9fff]/.test(node.nodeValue ?? '')) count += 1
  }
  return count
})()

console.log('anchor after :', JSON.stringify(siteAfter))
console.log('elapsed      :', elapsed + ' ms')
console.log('layout nodes :', paragraphs, '| translated text nodes:', translatedNodes)
console.log('English chars:', englishCharsBefore, '->', englishCharsAfter)
console.log('sample       :', bodyAfter.slice(0, 220))

const checks = {
  'anchor text translated in place': siteBefore !== '' && siteAfter !== siteBefore && /[\u4e00-\u9fff]/.test(siteAfter),
  'body mostly translated': englishCharsAfter < englishCharsBefore * 0.6,
  'in-place (layout kept)': paragraphs > 5 && translatedNodes > 10,
}
console.log('\nchecks:')
for (const [name, pass] of Object.entries(checks)) console.log(' ', pass ? 'PASS' : 'FAIL', name)

// Toggle back to the original text.
button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const restoredH1 = textOf(document.querySelector('h1'))
const restoredBody = textOf(document.body)
const restoredOk = Math.abs(restoredBody.length - bodyBefore.length) < bodyBefore.length * 0.1 && cjkRatio(restoredH1) < 0.2
console.log('restore      :', restoredOk ? 'PASS' : 'FAIL', '| h1 restored:', restoredH1)
if (!Object.values(checks).every(Boolean) || !restoredOk) process.exitCode = 1
