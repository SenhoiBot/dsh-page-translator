/**
 * Integration test for the built-in-browser attach path, without Electron:
 * a fake `<webview>` executes injected code in a jsdom page, and a stubbed
 * same-origin fetch answers the host bridge routes. This exercises the real
 * client orchestration: inject -> poll pill -> collect -> context -> chunk
 * translate -> apply in place -> restore.
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
<p id="labels">Film</p>
</body></html>`

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** Let timers run until the predicate holds. */
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

test('client attaches to a webview, translates in place and restores', async () => {
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only', url: PAGE_URL })
  const guestWindow = dom.window

  /** Fake webview: executes injected code in the jsdom page. */
  const fakeWebview = {
    isConnected: true,
    addEventListener() {},
    getURL: () => PAGE_URL,
    executeJavaScript: (code) => Promise.resolve(guestWindow.eval(code)),
  }

  const documentStub = {
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'webview[data-sidebar-browser-frame="webview"]' ? [fakeWebview] : []),
    createElement: () => ({ dataset: {}, textContent: '', style: {}, remove() {} }),
    head: { appendChild() {} },
    body: null,
  }
  const windowStub = { __ModuleLoader__: { load(descriptor) { windowStub.descriptor = descriptor } } }

  const fetchCalls = { context: 0, translate: 0 }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path === '/page-translator/hosted.js') {
      return new Response(hostedSource, { status: 200, headers: { 'content-type': 'text/javascript' } })
    }
    if (path === '/page-translator/context') {
      fetchCalls.context += 1
      return new Response(JSON.stringify({ ok: true, context: { topic: '胶片摄影社区', glossary: { Film: '胶片' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (path === '/page-translator/translate') {
      fetchCalls.translate += 1
      const body = JSON.parse(init.body)
      const translations = {}
      for (const segment of body.segments) translations[segment.id] = '译·' + segment.text
      return new Response(JSON.stringify({ ok: true, translations, cached: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (path === '/page-translator/compose') {
      fetchCalls.compose = (fetchCalls.compose ?? 0) + 1
      const body = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, text: 'EN: ' + body.text }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error('unexpected fetch: ' + path)
  }

  const require = (name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }
  const disposers = []
  const registered = []
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', 'require', 'document', clientSource)(windowStub, require, documentStub)
    const module = windowStub.descriptor.factory(require)
    module.apply({
      locale: { register: () => () => {}, bind: () => (key) => key },
      effect: (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
      slots: {
        inject: (_name, install) => install(),
        register: (options) => {
          registered.push(options.name)
          return () => {}
        },
      },
    })

    // The bridge injects the guest controller and its pill.
    const injected = await until(() => guestWindow.document.querySelector('#dsh-pt-root') !== null)
    assert.equal(injected, true, 'pill is injected into the guest page')

    // User clicks the pill.
    guestWindow.document.querySelector('#dsh-pt-root').click()
    const translated = await until(() =>
      guestWindow.document.querySelector('#title').textContent.startsWith('译·'),
    )
    assert.equal(translated, true, 'headline is translated in place')
    assert.equal(guestWindow.document.querySelector('#labels').textContent, '译·Film')
    assert.ok(fetchCalls.context >= 1, 'context is requested (prefetch and/or click)')
    assert.ok(fetchCalls.translate >= 1)
    assert.ok(guestWindow.document.querySelector('#dsh-pt-root').getAttribute('data-state') === 'done')

    // SPA / infinite scroll: new comments must be translated automatically.
    const later = guestWindow.document.createElement('p')
    later.id = 'later'
    later.textContent = 'Later comment from Reddit'
    guestWindow.document.body.appendChild(later)
    const followed = await until(() => guestWindow.document.querySelector('#later').textContent.startsWith('译·'))
    assert.equal(followed, true, 'content added after translation is followed')

    // Second click restores the original text.
    guestWindow.document.querySelector('#dsh-pt-root').click()
    const restored = await until(() => guestWindow.document.querySelector('#title').textContent === 'Film Photography Weekly')
    assert.equal(restored, true, 'original text is restored')
    assert.equal(guestWindow.document.querySelector('#later').textContent, 'Later comment from Reddit')

    // Reply composer: the pill's input translates a Chinese draft to English.
    const input = guestWindow.document.querySelector('#dsh-pt-compose-input')
    const send = guestWindow.document.querySelector('#dsh-pt-compose-send')
    assert.ok(input && send, 'compose controls are injected')
    input.value = '这张照片的颗粒感真好！'
    send.click()
    const composed = await until(() => {
      const panel = guestWindow.document.querySelector('#dsh-pt-compose-text')
      return panel !== null && panel.textContent.startsWith('EN: ')
    })
    assert.equal(composed, true, 'English reply shown in the guest panel')
    assert.equal(guestWindow.document.querySelector('#dsh-pt-compose-text').textContent, 'EN: 这张照片的颗粒感真好！')
    assert.ok((fetchCalls.compose ?? 0) >= 1)
  } finally {
    for (const dispose of disposers) dispose()
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})
