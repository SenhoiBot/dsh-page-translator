/** In-page script tests in jsdom: DOM walk, filtering, apply/restore in place. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const scriptSource = readFileSync(join(here, '..', 'lib', 'page-script.js'), 'utf8')

// jsdom ships with the dsh-superagent dev dependencies in this workspace.
const requireFromSuperagent = createRequire(join(here, '..', '..', '..', 'dsh-superagent', 'package.json'))
const { JSDOM } = requireFromSuperagent('jsdom')

const PAGE = `<!doctype html><html lang="en"><head><title>Film Photography Weekly</title></head><body>
<h1>Film Photography Weekly</h1>
<p id="a">Film grain and film rolls.</p>
<p id="b">Film</p>
<p id="c">Film</p>
<code>const film = 1</code>
<textarea>textarea text stays</textarea>
<a id="url" href="https://example.com">https://example.com</a>
<div id="hidden" style="display:none">hidden text here</div>
<p id="num">12345 -- ###</p>
</body></html>`

/** Boot the page script in a fresh jsdom document and return its test hooks. */
function boot() {
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only' })
  dom.window.__DSH_PT_DISABLE_BOOT__ = true
  dom.window.eval(scriptSource)
  return { dom, api: dom.window.__DSH_PT_TEST__, document: dom.window.document }
}

test('collectSegments dedupes identical text and skips code/forms/URLs/numbers', () => {
  const { api, document } = boot()
  const collected = api.collectSegments(document, 'zh')
  const texts = collected.items.map((item) => item.text)
  assert.ok(texts.includes('Film Photography Weekly'))
  assert.ok(texts.includes('Film grain and film rolls.'))
  assert.ok(!texts.some((text) => text.includes('const film')), 'code is not translated')
  assert.ok(!texts.some((text) => text.includes('textarea')), 'textarea is not translated')
  assert.ok(!texts.some((text) => text.startsWith('https://')), 'bare URLs are not translated')
  assert.ok(!texts.some((text) => text.includes('12345')), 'numbers/punctuation are not translated')
  const film = collected.items.find((item) => item.text === 'Film')
  assert.ok(film, 'the repeated "Film" label is collected once')
  assert.equal(film.nodes.length, 2, 'both occurrences share one segment')
})

test('applyTranslations rewrites text in place and restore puts it back', () => {
  const { api, document } = boot()
  const collected = api.collectSegments(document, 'zh')
  const table = {}
  for (const item of collected.items) table[item.id] = '译:' + item.text
  const applied = api.applyTranslations(collected.items, table)
  assert.ok(applied > 0)
  assert.equal(document.querySelector('#a').textContent, '译:Film grain and film rolls.')
  assert.equal(document.querySelector('#b').textContent, '译:Film')
  assert.equal(document.querySelector('#c').textContent, '译:Film')
  assert.equal(document.querySelector('code').textContent, 'const film = 1')
  const restored = api.restoreTranslations()
  assert.ok(restored > 0)
  assert.equal(document.querySelector('#a').textContent, 'Film grain and film rolls.')
  assert.equal(document.querySelector('#b').textContent, 'Film')
})

test('chunkSegments keeps chunks within limits', () => {
  const { api } = boot()
  const segments = []
  for (let index = 0; index < 60; index += 1) segments.push({ id: String(index + 1), text: 'x'.repeat(120) })
  const chunks = api.chunkSegments(segments)
  assert.ok(chunks.length >= 3)
  for (const chunk of chunks) {
    const chars = chunk.reduce((sum, segment) => sum + segment.text.length, 0)
    assert.ok(chars <= 1400, 'chunk char budget respected')
    assert.ok(chunk.length <= 26, 'chunk item budget respected')
  }
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), segments.length)
})

test('alreadyTarget detects Chinese text', () => {
  const { api } = boot()
  assert.equal(api.alreadyTarget('这是一段中文', 'zh'), true)
  assert.equal(api.alreadyTarget('Film grain', 'zh'), false)
})

test('extractPageContext reads title, headings and meta', () => {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head><title>T</title><meta name="description" content="D"></head><body><h1>A</h1><h2>B</h2><p>sample words</p></body></html>`,
    { runScripts: 'outside-only' },
  )
  dom.window.__DSH_PT_DISABLE_BOOT__ = true
  dom.window.eval(scriptSource)
  const context = dom.window.__DSH_PT_TEST__.extractPageContext()
  assert.equal(context.title, 'T')
  assert.equal(context.meta.description, 'D')
  assert.equal(context.headings.slice(0, 2).join(','), 'A,B')
  assert.match(context.sample, /sample words/)
})

/** Boot the toolbar itself (jsdom) with stubbed same-origin API calls. */
function bootToolbar() {
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only', url: 'https://film.example.com/weekly' })
  dom.window.__DSH_PT_BOOT__ = {
    token: 'test-token',
    proxyOrigin: '',
    pageUrl: 'https://film.example.com/weekly',
    target: 'zh',
    autoOpen: false,
    maxChars: 0,
  }
  dom.window.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, context: null, translations: {} }),
  })
  dom.window.eval(scriptSource)
  return { dom, window: dom.window, document: dom.window.document }
}

/** Dispatch a pointer event into the jsdom page (jsdom has no layout). */
function pointer(window, target, type, x, y) {
  target.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: 0,
      isPrimary: true,
    }),
  )
}

test('toolbar drag moves the pill with left/top and never toggles translation', () => {
  const { document, window } = bootToolbar()
  const pill = document.querySelector('#dsh-pt-root')
  const label = document.querySelector('#dsh-pt-label')
  assert.ok(pill, 'toolbar is injected')
  assert.equal(pill.style.right, '18px', 'starts in the bottom-right corner')
  assert.equal(pill.style.bottom, '18px')

  // Default corner in jsdom (no layout): 1024-18 / 768-18.
  pointer(window, pill, 'pointerdown', 1000, 700)
  pointer(window, pill, 'pointermove', 400, 300)
  pointer(window, pill, 'pointerup', 400, 300)
  assert.equal(pill.style.right, 'auto', 'the first drag switches from right to left')
  assert.equal(pill.style.bottom, 'auto', 'the first drag switches from bottom to top')
  assert.equal(pill.style.left, '406px')
  assert.equal(pill.style.top, '350px')
  assert.equal(label.textContent, '译', 'dragging does not start a translation')

  pill.click()
  assert.equal(label.textContent, '译', 'the click synthesized after a drag is swallowed')
  pill.click()
  assert.notEqual(label.textContent, '译', 'a plain click still toggles translation')

  // Pure clamp helper (also used by the resize handler).
  const hooks = window.__DSH_PT_TEST__
  assert.deepEqual({ ...hooks.clampPillPosition(-100, 900, 300, 34, 1024, 768) }, { x: 8, y: 726 })
  assert.deepEqual({ ...hooks.clampPillPosition(5000, 5000, 300, 34, 1024, 768) }, { x: 716, y: 726 })
  assert.equal(hooks.dragThreshold, 5)
})

