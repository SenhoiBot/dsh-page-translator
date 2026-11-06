/**
 * Renderer <-> guest integration for the draggable pill, without Electron:
 * the guest reports a drag through the existing executeJavaScript bridge, the
 * renderer keeps it in DSH's own localStorage, and the next injection restores
 * it. The visited page's storage is never touched and no new route is called.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')
const hostedSource = readFileSync(join(here, '..', 'lib', 'page-script-hosted.js'), 'utf8')
const requireFromSuperagent = createRequire(join(here, '..', '..', '..', 'dsh-superagent', 'package.json'))
const { JSDOM } = requireFromSuperagent('jsdom')

const PAGE_URL = 'https://film.example.com/weekly'
const PAGE = `<!doctype html><html lang="en"><head><title>Film Photography Weekly</title></head><body>
<h1 id="title">Film Photography Weekly</h1>
<p id="lead">Film grain and film rolls.</p>
</body></html>`
const PILL_POSITION_KEY = 'dsh.page-translator.pill-position.v1'

/** Let timers run until the predicate holds. */
async function until(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return false
}

test('a dragged pill is persisted in DSH localStorage and restored on reload', async () => {
  const storage = new Map()
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => {
      storage.set(key, String(value))
    },
  }
  const guestPage = () => new JSDOM(PAGE, { runScripts: 'outside-only', url: PAGE_URL })
  let guest = guestPage()
  /** @type {Map<string, Function>} */
  const listeners = new Map()
  const fakeWebview = {
    isConnected: true,
    addEventListener(type, handler) {
      listeners.set(type, handler)
    },
    getURL: () => PAGE_URL,
    executeJavaScript: (code) => Promise.resolve(guest.window.eval(code)),
  }
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'webview[data-sidebar-browser-frame="webview"]' ? [fakeWebview] : []),
    createElement: () => ({ dataset: {}, textContent: '', style: {}, remove() {} }),
    head: { appendChild() {} },
    body: null,
  }
  const windowStub = {
    localStorage,
    __ModuleLoader__: {
      load(descriptor) {
        windowStub.descriptor = descriptor
      },
    },
  }

  const originalFetch = globalThis.fetch
  const paths = []
  globalThis.fetch = async (url) => {
    const path = String(url)
    paths.push(path)
    if (path === '/page-translator/hosted.js') {
      return new Response(hostedSource, { status: 200, headers: { 'content-type': 'text/javascript' } })
    }
    if (path === '/page-translator/log') {
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/page-translator/context') {
      return new Response(JSON.stringify({ ok: true, context: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error('unexpected fetch: ' + path)
  }

  const requireModule = () => {
    throw new Error('client must not require any module')
  }
  const disposers = []
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', 'require', 'document', clientSource)(windowStub, requireModule, documentStub)
    const module = windowStub.descriptor.factory(requireModule)
    module.apply({
      effect: (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
    })

    assert.equal(await until(() => guest.window.document.querySelector('#dsh-pt-root') !== null), true, 'pill is injected')
    const pill = guest.window.document.querySelector('#dsh-pt-root')
    assert.equal(pill.style.right, '18px', 'default corner before any drag')

    const fire = (type, x, y) =>
      pill.dispatchEvent(
        new guest.window.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          button: 0,
          isPrimary: true,
        }),
      )
    // jsdom has no layout: the default corner is the viewport minus 18px.
    fire('pointerdown', 1006, 750)
    fire('pointermove', 300, 400)
    fire('pointerup', 300, 400)
    assert.equal(pill.style.left, '300px')
    assert.equal(pill.style.top, '400px')
    assert.equal(pill.getAttribute('data-state'), 'idle', 'dragging does not toggle translation')
    assert.equal(guest.window.localStorage.length, 0, 'the visited page storage is never written')

    assert.equal(await until(() => storage.has(PILL_POSITION_KEY)), true, 'the renderer persists the drag result')
    assert.deepEqual(JSON.parse(storage.get(PILL_POSITION_KEY)), { x: 300, y: 400 })

    // Simulate the guest page reloading: a fresh document + the dom-ready hook.
    guest = guestPage()
    const ready = listeners.get('dom-ready')
    assert.equal(typeof ready, 'function', 'client listens for dom-ready')
    ready()
    const restored = await until(() => {
      const nextPill = guest.window.document.querySelector('#dsh-pt-root')
      return nextPill !== null && nextPill.style.left === '300px' && nextPill.style.top === '400px'
    })
    assert.equal(restored, true, 'the saved position is restored through __DSH_PT_PILL_POS__')
    assert.equal(guest.window.document.querySelector('#dsh-pt-root').style.right, 'auto')

    // Only the existing host routes were touched; nothing new hits the network.
    for (const path of paths) {
      assert.ok(
        path === '/page-translator/hosted.js' || path === '/page-translator/log' || path === '/page-translator/context',
        'unexpected route ' + path,
      )
    }
  } finally {
    for (const dispose of disposers) dispose()
    globalThis.fetch = originalFetch
    guest.window.close()
  }
})
