/**
 * Edge extension content-script orchestration test without Edge:
 * a jsdom page + the real extension content script + a real loopback bridge
 * server (fake translator) + the real background message handler.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createTranslatorServer } from '../lib/server.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = join(here, '..', 'edge-extension')
const hostedSource = readFileSync(join(extensionDir, 'page-script-hosted.js'), 'utf8')
const contentSource = readFileSync(join(extensionDir, 'content.js'), 'utf8')
const backgroundSource = readFileSync(join(extensionDir, 'background.js'), 'utf8')
const requireFromSuperagent = createRequire(join(here, '..', '..', '..', 'dsh-superagent', 'package.json'))
const { JSDOM } = requireFromSuperagent('jsdom')

const silent = { info() {}, warn() {}, error() {} }
const PAGE_URL = 'https://film.example.com/weekly'
const PAGE = `<!doctype html><html lang="en"><head><title>Film Photography Weekly</title></head><body>
<h1 id="title">Film Photography Weekly</h1>
<p id="lead">Film grain and film rolls.</p>
<p id="labels">Film</p>
</body></html>`

/** Fake translator kept in-process; the extension talks HTTP to it. */
const translator = {
  async analyzeContext() {
    return { topic: '胶片摄影社区', domain: '摄影', tone: '社区', glossary: { Film: '胶片' }, notes: '' }
  },
  async translateChunk({ segments }) {
    const out = {}
    for (const segment of segments) out[segment.id] = '译·' + segment.text
    return out
  },
  async translateComposition({ text }) {
    return 'EN: ' + String(text)
  },
}

async function until(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return false
}

test('extension copy of the page controller matches the DSH plugin source', () => {
  const pluginSource = readFileSync(join(here, '..', 'lib', 'page-script-hosted.js'), 'utf8')
  assert.equal(hostedSource, pluginSource, 're-copy lib/page-script-hosted.js into edge-extension when it changes')
})

test('content script translates the page through the real background + bridge', async () => {
  const service = createTranslatorServer({ translator, config: { port: 0, target: 'zh' }, logger: silent })
  const bound = await service.start()
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only', url: PAGE_URL })
  const guestWindow = dom.window
  const guestDocument = guestWindow.document

  // Minimal chrome extension runtime: storage + one message listener (background).
  const listeners = []
  const localData = {}
  const chromeStub = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (message, callback) => {
        for (const listener of listeners) listener(message, {}, (response) => callback(response))
      },
    },
    storage: {
      sync: {
        get: (defaults, callback) => callback({ ...defaults, bridgeUrl: bound.origin, token: '', target: 'zh' }),
      },
      local: {
        get: (defaults, callback) => {
          const values = { ...defaults }
          for (const key of Object.keys(defaults)) {
            if (localData[key] !== undefined) values[key] = localData[key]
          }
          callback(values)
        },
        set: (values, callback) => {
          Object.assign(localData, values)
          if (typeof callback === 'function') callback()
        },
      },
    },
  }

  // Load background.js: it only needs chrome + fetch.
  new Function('chrome', 'fetch', backgroundSource)(chromeStub, globalThis.fetch)

  // Page controller, then content script (with jsdom timers so cleanup is easy).
  guestWindow.eval(hostedSource)
  new Function('window', 'document', 'chrome', 'setInterval', 'clearInterval', 'location', contentSource)(
    guestWindow,
    guestDocument,
    chromeStub,
    guestWindow.setInterval.bind(guestWindow),
    guestWindow.clearInterval.bind(guestWindow),
    guestWindow.location,
  )

  try {
    const pill = guestDocument.querySelector('#dsh-pt-root')
    assert.ok(pill, 'pill injected')
    pill.click()
    const translated = await until(() => guestDocument.querySelector('#title').textContent.startsWith('译·'))
    assert.equal(translated, true, 'title translated in place')
    assert.equal(guestDocument.querySelector('#labels').textContent, '译·Film')
    assert.equal(pill.getAttribute('data-state'), 'done')

    // Reddit-style SPA / infinite scroll: new content is followed automatically.
    const later = guestDocument.createElement('p')
    later.id = 'later'
    later.textContent = 'Later comment from Reddit'
    guestDocument.body.appendChild(later)
    const followed = await until(() => guestDocument.querySelector('#later').textContent.startsWith('译·'))
    assert.equal(followed, true, 'new content is translated without clicking again')

    pill.click()
    const restored = await until(() => guestDocument.querySelector('#title').textContent === 'Film Photography Weekly')
    assert.equal(restored, true, 'original text restored')
    assert.equal(guestDocument.querySelector('#later').textContent, 'Later comment from Reddit')

    // Reply composer: type a Chinese draft, translate to English through the bridge.
    const input = guestDocument.querySelector('#dsh-pt-compose-input')
    const send = guestDocument.querySelector('#dsh-pt-compose-send')
    assert.ok(input && send, 'compose controls injected')
    input.value = '这张照片的颗粒感真好！'
    send.click()
    const composed = await until(() => {
      const panel = guestDocument.querySelector('#dsh-pt-compose-text')
      return panel !== null && panel.textContent.startsWith('EN: ')
    })
    assert.equal(composed, true, 'English reply shown in the panel')
    assert.equal(guestDocument.querySelector('#dsh-pt-compose-text').textContent, 'EN: 这张照片的颗粒感真好！')

    // Dragging the pill is persisted through the extension storage bridge
    // (no page storage, no extra network call).
    const guestPill = guestDocument.querySelector('#dsh-pt-root')
    const fire = (type, x, y) =>
      guestPill.dispatchEvent(
        new guestWindow.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          button: 0,
          isPrimary: true,
        }),
      )
    fire('pointerdown', 1006, 750)
    fire('pointermove', 300, 400)
    fire('pointerup', 300, 400)
    assert.equal(guestPill.style.left, '300px', 'drag switches the pill to left/top')
    assert.equal(guestPill.style.top, '400px')
    assert.equal(guestPill.getAttribute('data-state'), 'idle', 'dragging does not toggle translation')
    const persisted = await until(() => localData.dshPtPillPosition !== undefined)
    assert.equal(persisted, true, 'dragged position is stored by the extension bridge')
    assert.deepEqual({ ...localData.dshPtPillPosition }, { x: 300, y: 400 })
  } finally {
    dom.window.close()
    await service.stop()
  }
})
