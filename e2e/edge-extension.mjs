/**
 * Real Edge E2E for the browser extension: loads the unpacked extension in Edge,
 * opens a local test page, clicks the injected pill, and verifies in-place
 * translation through the extension's service worker → loopback DSH bridge.
 *
 * Usage: node e2e/edge-extension.mjs [--headed]
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTranslatorServer } from '../lib/server.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = join(here, '..', 'edge-extension')
const outDir = join(here, '..', '..', '..', '.research', 'shots')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const headed = process.argv.includes('--headed')
/** Optional real DSH bridge (defaults to a local fake one in this script). */
const bridgeUrlArg = (() => {
  const index = process.argv.indexOf('--bridge-url')
  return index === -1 ? '' : String(process.argv[index + 1] ?? '').replace(/\/$/, '')
})()

const silent = { info() {}, warn() {}, error() {} }
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

const TEST_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Film Photography Weekly</title>
<style>
/* Simulate hostile community CSS (Reddit-style !important rules on form controls). */
textarea, select, button { height: auto !important; min-height: 64px !important; margin: 8px !important; padding: 14px !important; font-size: 20px !important; line-height: 1.8 !important; }
</style></head>
<body style="font:16px/1.6 sans-serif;max-width:760px;margin:40px auto;padding:0 20px">
<h1 id="title">Film Photography Weekly</h1>
<p id="lead">Film grain and film rolls are the heart of analog photography.</p>
<h2>Develop at home</h2>
<p id="dup">Film</p><p>Film</p>
<pre><code>const film = 1;</code></pre>
<p>Shutter speed and aperture matter.</p>
</body></html>`

/** Bridge: either the real DSH host (--bridge-url) or a local fake on a random port. */
let bridge = null
let bridgeOrigin = bridgeUrlArg
let loadExtensionDir = extensionDir
let tempExtensionDir = null
if (bridgeOrigin === '') {
  bridge = createTranslatorServer({ translator, config: { port: 0, target: 'zh' }, logger: silent })
  const bound = await bridge.start()
  bridgeOrigin = bound.origin
  // Copy the extension and point its default bridge at the fake server, so the
  // test does not depend on (or disturb) the real DSH bridge port.
  tempExtensionDir = await mkdtemp(join(tmpdir(), 'dsh-edge-ext-copy-'))
  await cp(extensionDir, tempExtensionDir, { recursive: true })
  const backgroundPath = join(tempExtensionDir, 'background.js')
  const background = await readFile(backgroundPath, 'utf8')
  await writeFile(backgroundPath, background.replace("bridgeUrl: 'http://127.0.0.1:34118'", `bridgeUrl: '${bridgeOrigin}'`), 'utf8')
  loadExtensionDir = tempExtensionDir
}
console.log('bridge        :', bridgeOrigin)
const pageServer = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(TEST_PAGE)
})
await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve))
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`
await mkdir(outDir, { recursive: true })
const profileDir = await mkdtemp(join(tmpdir(), 'dsh-edge-ext-'))
const debugPort = 9900 + Math.floor(Math.random() * 80)

const args = [
  ...(headed ? ['--window-position=-2400,-2400', '--window-size=1200,900'] : ['--headless=new', '--disable-gpu']),
  '--no-first-run',
  '--no-default-browser-check',
  '--allow-insecure-localhost',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  `--disable-extensions-except=${loadExtensionDir}`,
  `--load-extension=${loadExtensionDir}`,
  'about:blank',
]
const edge = spawn(EDGE, args, { stdio: 'ignore' })

/** Wait for the CDP page target. */
async function waitTarget(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json())
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Edge CDP did not start')
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, timeoutMs = 30000) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs })
    if (result.exceptionDetails !== undefined) {
      throw new Error('evaluate failed: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
    }
    return result.result?.value
  }
}

async function poll(cdp, expression, timeoutMs = 20000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(expression).catch(() => undefined)
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return undefined
}

let cdp
try {
  const socket = new WebSocket(await waitTarget())
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  cdp = new Cdp(socket)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: pageUrl })

  const hasPill = await poll(cdp, `!!document.querySelector('#dsh-pt-root')`, 15000)
  if (!hasPill) {
    const diag = await cdp.evaluate(`({ title: document.title, body: document.body ? document.body.innerText.slice(0, 200) : '', pill: !!document.querySelector('#dsh-pt-root') })`)
    throw new Error('pill not injected (extension content script not running?): ' + JSON.stringify(diag))
  }
  console.log('pill injected : yes')
  const metrics = await cdp.evaluate(`(() => {
    const ids = ['dsh-pt-label', 'dsh-pt-compose-tone', 'dsh-pt-compose-input', 'dsh-pt-compose-send']
    return ids.map((id) => {
      const el = document.getElementById(id)
      if (el === null) return { id, missing: true }
      const rect = el.getBoundingClientRect()
      return { id, height: Math.round(rect.height * 10) / 10, center: Math.round((rect.top + rect.height / 2) * 10) / 10 }
    })
  })()`)
  const aligned =
    Array.isArray(metrics) &&
    metrics.every(
      (item) =>
        item.missing !== true &&
        Math.abs(item.height - 34) < 1.5 &&
        Math.abs(item.center - metrics[0].center) < 1.5,
    )
  console.log('align         :', JSON.stringify(metrics))
  console.log('alignment     :', aligned ? 'PASS' : 'FAIL')
  await cdp.evaluate(`document.querySelector('#dsh-pt-root').click(); 'clicked'`)
  // The fake bridge returns "译·..." while the real model returns natural Chinese;
  // both mean "the title changed and now contains Chinese".
  const translated = await poll(
    cdp,
    `(() => {
      const title = document.querySelector('#title')?.textContent ?? ''
      return title !== 'Film Photography Weekly' && /[\\u4e00-\\u9fff]/.test(title)
    })()`,
    30000,
  )
  if (!translated) {
    const state = await cdp.evaluate(`({ state: document.querySelector('#dsh-pt-root')?.getAttribute('data-state'), label: document.querySelector('#dsh-pt-root')?.innerText, title: document.querySelector('#title')?.textContent })`)
    throw new Error('translation did not apply: ' + JSON.stringify(state))
  }
  const label = await cdp.evaluate(`document.querySelector('#dsh-pt-label')?.textContent ?? document.querySelector('#dsh-pt-root')?.innerText`)
  const sample = await cdp.evaluate(`document.body.innerText.slice(0, 220)`)
  console.log('pill label    :', JSON.stringify(label))
  console.log('sample        :', sample.replace(/\n/g, ' | '))
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const shotPath = join(outDir, 'edge-extension.png')
  await writeFile(shotPath, Buffer.from(shot.data, 'base64'))
  console.log('screenshot    :', shotPath)

  // SPA / infinite scroll: appended content must be translated without clicking again.
  await cdp.evaluate(`(() => {
    const p = document.createElement('p')
    p.id = 'later'
    p.textContent = 'Later comment from Reddit is here.'
    document.body.appendChild(p)
    return true
  })()`)
  const followed = await poll(
    cdp,
    `(() => {
      const later = document.querySelector('#later')
      return later !== null && later.textContent !== 'Later comment from Reddit is here.' && /[\\u4e00-\\u9fff]/.test(later.textContent)
    })()`,
    25000,
  )
  console.log('follow        :', followed ? 'PASS' : 'FAIL')

  // Restore.
  await cdp.evaluate(`document.querySelector('#dsh-pt-root').click(); 'clicked'`)
  const restored = await poll(cdp, `document.querySelector('#title')?.textContent === 'Film Photography Weekly'`, 8000)
  const laterRestored = await poll(cdp, `document.querySelector('#later')?.textContent === 'Later comment from Reddit is here.'`, 8000)
  console.log('restore       :', restored && laterRestored ? 'PASS' : 'FAIL')

  // Reply composer: type a Chinese draft, ask for the English reply.
  const composeReady = await cdp.evaluate(`(() => {
    const input = document.querySelector('#dsh-pt-compose-input')
    const send = document.querySelector('#dsh-pt-compose-send')
    if (!input || !send) return false
    input.value = '这张照片的颗粒感真好！请问用的是什么胶卷？'
    send.click()
    return true
  })()`)
  if (!composeReady) throw new Error('compose controls missing')
  const composeText = await poll(
    cdp,
    `(() => {
      const panel = document.querySelector('#dsh-pt-compose-panel')
      const text = document.querySelector('#dsh-pt-compose-text')?.textContent ?? ''
      if (!panel || panel.style.display !== 'block') return ''
      return text && !text.includes('翻译中') ? text : ''
    })()`,
    20000,
  )
  console.log('compose reply :', JSON.stringify(composeText))
  const composeShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const composeShotPath = join(outDir, 'edge-extension-compose.png')
  await writeFile(composeShotPath, Buffer.from(composeShot.data, 'base64'))
  console.log('screenshot    :', composeShotPath)
  const composeOk = typeof composeText === 'string' && composeText.length > 0 && !composeText.includes('翻译失败')
  console.log('compose       :', composeOk ? 'PASS' : 'SKIP/FAIL (bridge may need a DSH restart for /ext/compose)')
  console.log('\nRESULT        :', translated && restored && composeOk ? 'PASS' : 'CHECK')
  if (!(translated && restored && composeOk)) process.exitCode = 1
} finally {
  try {
    if (cdp !== undefined) await cdp.send('Browser.close').catch(() => {})
  } catch {
    // ignore
  }
  edge.kill()
  await new Promise((resolve) => setTimeout(resolve, 400))
  await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  if (tempExtensionDir !== null) await rm(tempExtensionDir, { recursive: true, force: true }).catch(() => {})
  pageServer.close()
  if (bridge !== null) await bridge.stop()
}
