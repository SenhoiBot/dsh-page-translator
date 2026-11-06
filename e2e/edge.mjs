/**
 * Real-browser E2E with headless Edge + CDP.
 *
 * Opens the plugin's proxied page (the same document the DSH client panel shows
 * in its iframe), clicks the injected 「译」 button, waits for the in-place
 * translation, and captures screenshots of the original / translated / restored
 * page.
 *
 * Usage:
 *   node e2e/edge.mjs --origin http://127.0.0.1:<proxyPort> --url <pageUrl> [--out .research/shots]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const origin = String(arg('origin', '')).replace(/\/$/, '')
const pageUrl = String(arg('url', 'https://filmphotographyproject.com/'))
const outDir = String(arg('out', join(here, '..', '..', '..', '.research', 'shots')))
if (origin === '') {
  console.error('missing --origin')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })

/** Pick a free debugging port by letting Edge fail fast on a random one. */
const debugPort = 9333 + Math.floor(Math.random() * 200)
const profileDir = await mkdtemp(join(tmpdir(), 'dsh-edge-e2e-'))

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars=false',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

/** Wait for the CDP endpoint and return the page websocket URL. */
async function waitTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json())
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {
      // endpoint not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Edge CDP endpoint did not come up')
}

/** Minimal CDP client over the Node WebSocket. */
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
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
      timeout: timeoutMs,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error('evaluate failed: ' + JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
    }
    return result.result?.value
  }
}

async function screenshot(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = join(outDir, name)
  await writeFile(file, Buffer.from(result.data, 'base64'))
  console.log('screenshot  :', file)
}

let cdp
try {
  const wsUrl = await waitTarget()
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  cdp = new Cdp(socket)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const proxyUrl = `${origin}/p?url=${encodeURIComponent(pageUrl)}`
  console.log('proxy page  :', proxyUrl)
  await cdp.send('Page.navigate', { url: proxyUrl })

  // Wait for the injected toolbar.
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate(`!!document.querySelector('#dsh-pt-root')`).catch(() => false)
    if (ready === true) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const buttonText = await cdp.evaluate(`document.querySelector('#dsh-pt-root')?.innerText ?? ''`)
  if (!buttonText.includes('译')) {
    const diagnostics = await cdp.evaluate(`({
      href: location.href,
      ready: document.readyState,
      title: document.title,
      bodyLen: document.body ? document.body.innerHTML.length : -1,
      boot: typeof window.__DSH_PT_BOOT__,
      test: typeof window.__DSH_PT_TEST__,
      scripts: Array.from(document.scripts).map(s => s.src || 'inline:' + (s.textContent || '').slice(0, 30)),
      root: !!document.querySelector('#dsh-pt-root'),
      style: !!document.querySelector('#dsh-pt-style'),
    })`)
    console.error('diagnostics :', JSON.stringify(diagnostics, null, 2))
    throw new Error('translate button missing')
  }
  console.log('button      :', JSON.stringify(buttonText))
  console.log('page title  :', await cdp.evaluate('document.title'))
  await screenshot(cdp, '01-original.png')

  // Click and wait for the page translation.
  const started = Date.now()
  await cdp.evaluate(`document.querySelector('#dsh-pt-root').click(); 'clicked'`)
  let state = ''
  while (Date.now() - started < 180_000) {
    state = await cdp.evaluate(`document.querySelector('#dsh-pt-root')?.getAttribute('data-state') ?? ''`)
    if (state === 'done' || state === 'error') break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const elapsed = Date.now() - started
  if (state !== 'done') {
    const diagnostics = await cdp.evaluate(`(async () => {
      const boot = window.__DSH_PT_BOOT__ || {}
      const out = { tokenLen: String(boot.token || '').length, pageUrl: String(boot.pageUrl || '') }
      try {
        const r = await fetch('/api/context', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pt-token': boot.token }, body: JSON.stringify({ url: boot.pageUrl, title: document.title, lang: document.documentElement.lang, meta: {}, headings: [], sample: 'test sample' }) })
        out.contextStatus = r.status
        out.contextBody = (await r.text()).slice(0, 220)
      } catch (error) { out.contextError = String(error) }
      try {
        const r = await fetch('/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pt-token': boot.token }, body: JSON.stringify({ url: boot.pageUrl, target: 'zh', context: null, segments: [{ id: '1', text: 'Film' }] }) })
        out.translateStatus = r.status
        out.translateBody = (await r.text()).slice(0, 220)
      } catch (error) { out.translateError = String(error) }
      return out
    })()`)
    console.error('diagnostics :', JSON.stringify(diagnostics, null, 2))
    throw new Error('translation did not finish, state=' + state)
  }
  const label = await cdp.evaluate(`document.querySelector('#dsh-pt-root')?.innerText ?? ''`)
  console.log('translated  :', JSON.stringify(label), 'in', elapsed + 'ms')
  await screenshot(cdp, '02-translated.png')

  const stats = await cdp.evaluate(`(() => {
    const body = document.body
    const text = body ? body.innerText : ''
    const cjk = (text.match(/[\\u4e00-\\u9fff]/g) || []).length
    const latin = (text.match(/[A-Za-z]/g) || []).length
    return { cjk, latin, textLen: text.length, sample: text.slice(0, 260), theme: document.querySelector('#dsh-pt-topic')?.innerText ?? '' }
  })()`)
  console.log('text stats  :', JSON.stringify({ cjk: stats.cjk, latin: stats.latin, len: stats.textLen }))
  console.log('topic badge :', JSON.stringify(stats.theme))
  console.log('sample      :', stats.sample)

  // Restore and check the original text comes back.
  await cdp.evaluate(`document.querySelector('#dsh-pt-root').click(); 'restore-clicked'`)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const restored = await cdp.evaluate(`(() => {
    const text = document.body ? document.body.innerText : ''
    return { cjk: (text.match(/[\\u4e00-\\u9fff]/g) || []).length, latin: (text.match(/[A-Za-z]/g) || []).length, len: text.length }
  })()`)
  console.log('restored    :', JSON.stringify(restored))
  await screenshot(cdp, '03-restored.png')

  const pass = stats.cjk > 200 && stats.latin < 1200 && restored.latin > stats.latin * 2
  console.log('\nRESULT      :', pass ? 'PASS' : 'CHECK MANUALLY')
  if (!pass) process.exitCode = 1
} finally {
  try {
    if (cdp !== undefined) await cdp.send('Browser.close').catch(() => {})
  } catch {
    // ignore
  }
  edge.kill()
  await new Promise((resolve) => setTimeout(resolve, 500))
  await rm(profileDir, { recursive: true, force: true }).catch(() => {})
}
