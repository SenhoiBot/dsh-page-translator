/**
 * Loopback HTTP service for the in-page translator.
 *
 * Why a separate loopback origin instead of the DSH web server: the built-in
 * sidebar browser refuses to load the DSH application origin itself, and the
 * translation page must be a *same-origin* document for its script to call the
 * translation API without CORS. So the plugin owns a small `node:http` server on
 * `127.0.0.1:<random>`:
 *
 *   GET  /p?url=<target>   proxy that page, inject the translate button script
 *   GET  /pt.js            the in-page script (served same-origin with the page)
 *   GET  /api/state        origin/port/version, for the DSH-side panel
 *   POST /api/context      page topic + glossary analysis (one LLM call per page)
 *   POST /api/translate    one chunk of numbered segments (many calls in parallel)
 *
 * Nothing leaves the machine; the only egress is the page fetch itself and the
 * host LLM service.
 */

import http from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractPageMeta, rewriteHtml } from './html-rewrite.js'
import { TranslatorError } from './llm.js'

const PLUGIN_VERSION = '0.6.0'
const PAGE_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'page-script.js')
/** Default page byte cap before rewrite; protects the host from huge downloads. */
const DEFAULT_MAX_PAGE_BYTES = 5 * 1024 * 1024
/** Default upstream fetch timeout. */
const DEFAULT_FETCH_TIMEOUT_MS = 20_000
/** Maximum concurrent host LLM calls across all pages. */
const DEFAULT_LLM_CONCURRENCY = 8
/** Body caps for the JSON API. */
const MAX_JSON_BODY_BYTES = 512 * 1024
/** Context cache lifetime. */
const CONTEXT_TTL_MS = 10 * 60 * 1000
/** Translation cache entry cap. */
const TRANSLATION_CACHE_LIMIT = 20_000
/** Browser-ish user agent: many sites answer plain scripted clients with a wall. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 DSH-PageTranslator/0.1'

/**
 * Semaphore for host LLM calls; keeps one page from starving the rest.
 */
class Semaphore {
  /** @param {number} limit */
  constructor(limit) {
    this.limit = Math.max(1, limit)
    this.active = 0
    /** @type {Array<() => void>} */
    this.queue = []
  }

  /** @param {() => Promise<T>} fn @template T @returns {Promise<T>} */
  async run(fn) {
    if (this.active >= this.limit) await new Promise((resolve) => this.queue.push(resolve))
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      const next = this.queue.shift()
      if (next !== undefined) next()
    }
  }
}

/**
 * Small insertion-ordered cache with a hard cap (oldest evicted first).
 * @template V
 */
class LruCache {
  /** @param {number} limit */
  constructor(limit) {
    this.limit = limit
    /** @type {Map<string, V>} */
    this.map = new Map()
  }

  /** @param {string} key @returns {V | undefined} */
  get(key) {
    return this.map.get(key)
  }

  /** @param {string} key @param {V} value */
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next()
      if (oldest.done === true) break
      this.map.delete(oldest.value)
    }
  }

  get size() {
    return this.map.size
  }
}

/**
 * Create the loopback translator server.
 * @param {object} options
 * @param {import('./llm.js').LlmTranslator} options.translator
 * @param {object} [options.config] - normalized plugin config.
 * @param {object} [options.logger] - logger with info/warn/error.
 * @param {Function} [options.fetchImpl] - injectable fetch (tests).
 * @returns {{start: () => Promise<{port: number, origin: string}>, stop: () => Promise<void>, state: () => object, server: http.Server}}
 */
export function createTranslatorServer({ translator, config, logger, fetchImpl }) {
  const log = logger ?? console
  const cfg = config ?? {}
  const token = randomBytes(16).toString('hex')
  const semaphore = new Semaphore(Number.isFinite(cfg.llmConcurrency) ? cfg.llmConcurrency : DEFAULT_LLM_CONCURRENCY)
  const contextCache = new Map()
  const translationCache = new LruCache(TRANSLATION_CACHE_LIMIT)
  /** @type {{port: number, origin: string} | null} */
  let bound = null
  let pageScript = null

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      log.error?.('page translator: unhandled request error: %s', String(error))
      if (!response.headersSent) {
        sendApiError(response, error)
      } else {
        response.destroy()
      }
    })
  })

  /**
   * Route dispatcher.
   * @param {http.IncomingMessage} request
   * @param {http.ServerResponse} response
   */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, version: PLUGIN_VERSION })
      return
    }
    if (request.method === 'GET' && url.pathname === '/pt.js') {
      const body = await loadPageScript()
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      response.end(body)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      requireToken(request)
      sendJson(response, 200, {
        ok: true,
        version: PLUGIN_VERSION,
        port: bound?.port ?? 0,
        origin: bound?.origin ?? '',
        cache: { context: contextCache.size, translation: translationCache.size },
      })
      return
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/p') {
      await servePage(request, response, url)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/context') {
      requireToken(request)
      await handleContext(request, response)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/translate') {
      requireToken(request)
      await handleTranslate(request, response)
      return
    }
    // Extension bridge (Edge/Chrome add-on): no per-process page token, because an
    // extension is not the proxied page. Optional static token via config.
    // No CORS headers are sent: an MV3 extension with host_permissions bypasses
    // CORS from its service worker, while ordinary web pages stay blocked.
    if (request.method === 'GET' && url.pathname === '/ext/health') {
      requireExtensionToken(request)
      sendJson(response, 200, {
        ok: true,
        version: PLUGIN_VERSION,
        target: cfg.target ?? 'zh',
        port: bound?.port ?? 0,
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/ext/context') {
      requireExtensionToken(request)
      await handleContext(request, response)
      return
    }
    if (request.method === 'POST' && url.pathname === '/ext/translate') {
      requireExtensionToken(request)
      await handleTranslate(request, response)
      return
    }
    if (request.method === 'POST' && url.pathname === '/ext/compose') {
      requireExtensionToken(request)
      await handleCompose(request, response)
      return
    }
    sendJson(response, 404, { ok: false, error: 'not-found', message: '未知路由' })
  }

  /**
   * Optional shared secret for the extension bridge; empty means loopback-only trust.
   * @param {http.IncomingMessage} request
   */
  function requireExtensionToken(request) {
    const expected = typeof cfg.extensionToken === 'string' ? cfg.extensionToken : ''
    if (expected === '') return
    const provided = String(request.headers['x-pt-ext-token'] ?? '')
    if (provided !== expected) throw new TranslatorError('forbidden', '扩展访问令牌不正确')
  }

  /**
   * Reject loopback API calls that do not carry the per-process token.
   * @param {http.IncomingMessage} request
   */
  function requireToken(request) {
    const provided = String(request.headers['x-pt-token'] ?? '')
    if (provided !== token) throw new TranslatorError('forbidden', '缺少或错误的访问令牌')
  }

  /**
   * Proxy one page: fetch, rewrite, inject the script.
   * @param {http.IncomingMessage} request
   * @param {http.ServerResponse} response
   * @param {URL} url
   */
  async function servePage(request, response, url) {
    const target = String(url.searchParams.get('url') ?? '').trim()
    if (target === '') {
      sendHtml(response, 400, errorPage('缺少 url 参数', '用法：/p?url=https://example.com/article'))
      return
    }
    let page
    try {
      page = await fetchPage(target)
    } catch (error) {
      const message = error instanceof TranslatorError ? error.message : String(error?.message ?? error)
      sendHtml(response, 502, errorPage('页面抓取失败', message))
      return
    }
    const targetLanguage = String(url.searchParams.get('target') ?? cfg.target ?? 'zh')
    const autoOpen = url.searchParams.get('auto') === '1'
    const maxChars = Number(url.searchParams.get('maxChars') ?? cfg.maxChars ?? 0)
    const rewritten = rewriteHtml(page.html, {
      finalUrl: page.finalUrl,
      token,
      target: targetLanguage,
      autoOpen,
      assetOrigin: bound?.origin ?? '',
      maxChars: Number.isFinite(maxChars) ? maxChars : 0,
    })
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
    response.end(rewritten)
  }

  /**
   * Read and JSON-parse a request body with a hard size cap.
   * @param {http.IncomingMessage} request
   * @param {number} [limit]
   * @returns {Promise<any>}
   */
  async function readJson(request, limit = MAX_JSON_BODY_BYTES) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > limit) throw new TranslatorError('body-too-large', '请求体过大')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new TranslatorError('bad-json', '请求体不是合法 JSON')
    }
  }

  /**
   * Context analysis endpoint.
   * @param {http.IncomingMessage} request
   * @param {http.ServerResponse} response
   */
  async function handleContext(request, response) {
    const body = await readJson(request)
    const page = {
      url: String(body?.url ?? ''),
      title: String(body?.title ?? ''),
      lang: String(body?.lang ?? ''),
      meta: body?.meta !== null && typeof body?.meta === 'object' ? body.meta : {},
      headings: Array.isArray(body?.headings) ? body.headings.slice(0, 18) : [],
      sample: String(body?.sample ?? ''),
    }
    const cacheKey = page.url
    const cached = contextCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < CONTEXT_TTL_MS) {
      sendJson(response, 200, { ok: true, context: cached.context, cached: true })
      return
    }
    const started = Date.now()
    try {
      const context = await semaphore.run(() => translator.analyzeContext(page))
      contextCache.set(cacheKey, { context, at: Date.now() })
      sendJson(response, 200, { ok: true, context, cached: false, ms: Date.now() - started })
    } catch (error) {
      throw normalizeApiError(error)
    }
  }

  /**
   * Chunk translation endpoint.
   * @param {http.IncomingMessage} request
   * @param {http.ServerResponse} response
   */
  async function handleTranslate(request, response) {
    const body = await readJson(request)
    const pageUrl = String(body?.url ?? '')
    const target = String(body?.target ?? cfg.target ?? 'zh')
    const context = body?.context !== null && typeof body?.context === 'object' ? body.context : null
    const rawSegments = Array.isArray(body?.segments) ? body.segments : []
    const segments = []
    for (const segment of rawSegments) {
      if (segment === null || typeof segment !== 'object') continue
      const id = segment.id === undefined ? '' : String(segment.id)
      const text = typeof segment.text === 'string' ? segment.text.replace(/\s+/g, ' ').trim() : ''
      if (id === '' || text === '') continue
      segments.push({ id, text })
    }
    if (segments.length === 0) {
      sendJson(response, 200, { ok: true, translations: {}, cached: 0 })
      return
    }
    const started = Date.now()
    const translations = {}
    const missing = []
    for (const segment of segments) {
      const cacheKey = cacheKeyFor(pageUrl, target, segment.text)
      const hit = translationCache.get(cacheKey)
      if (typeof hit === 'string') translations[segment.id] = hit
      else missing.push(segment)
    }
    if (missing.length > 0) {
      const translated = await semaphore.run(() =>
        translator.translateChunk({ context, segments: missing, pageUrl }),
      )
      for (const [id, text] of Object.entries(translated)) {
        translations[id] = text
        const segment = missing.find((candidate) => candidate.id === id)
        if (segment !== undefined) translationCache.set(cacheKeyFor(pageUrl, target, segment.text), text)
      }
    }
    sendJson(response, 200, {
      ok: true,
      translations,
      cached: segments.length - missing.length,
      ms: Date.now() - started,
    })
  }

  /**
   * Reply-composer endpoint: translate the user's draft (usually Chinese) into
   * the community's language, using the page topic/tone as context.
   * @param {http.IncomingMessage} request
   * @param {http.ServerResponse} response
   */
  async function handleCompose(request, response) {
    const body = await readJson(request, 64 * 1024)
    const text = typeof body?.text === 'string' ? body.text : ''
    const context = body?.context !== null && typeof body?.context === 'object' ? body.context : null
    const pageUrl = String(body?.url ?? '')
    const target = typeof body?.target === 'string' && body.target !== '' ? body.target : 'en'
    const tone = typeof body?.tone === 'string' && body.tone !== '' ? body.tone : 'natural'
    const pageTitle = String(body?.title ?? '')
    const started = Date.now()
    const translated = await semaphore.run(() =>
      translator.translateComposition({ text, context, pageUrl, pageTitle, target, tone }),
    )
    sendJson(response, 200, { ok: true, text: translated, ms: Date.now() - started })
  }

  /**
   * Fetch the target page with a browser-ish request and a size cap.
   * @param {string} target
   * @returns {Promise<{html: string, finalUrl: string}>}
   */
  async function fetchPage(target) {
    let parsed
    try {
      parsed = new URL(target)
    } catch {
      throw new TranslatorError('bad-url', 'URL 格式不正确')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TranslatorError('bad-url', '只支持 http/https 页面')
    }
    const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
    const timeout = Number.isFinite(cfg.fetchTimeoutMs) ? cfg.fetchTimeoutMs : DEFAULT_FETCH_TIMEOUT_MS
    const maxBytes = Number.isFinite(cfg.maxPageBytes) ? cfg.maxPageBytes : DEFAULT_MAX_PAGE_BYTES
    let response
    try {
      response = await doFetch(parsed.href, {
        redirect: 'follow',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
        },
        signal: AbortSignal.timeout(timeout),
      })
    } catch (error) {
      if (String(error?.name ?? '') === 'TimeoutError') throw new TranslatorError('fetch-timeout', '目标页面响应超时')
      throw new TranslatorError('fetch-failed', `无法访问目标页面：${String(error?.message ?? error).slice(0, 200)}`)
    }
    if (response.ok !== true) {
      throw new TranslatorError('fetch-status', `目标页面返回 HTTP ${response.status}`)
    }
    const contentType = String(response.headers.get('content-type') ?? '')
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      throw new TranslatorError('not-html', `不是 HTML 页面（${contentType || '未知类型'}）`)
    }
    const html = await readBodyWithLimit(response, maxBytes)
    return { html, finalUrl: response.url || parsed.href }
  }

  /** @returns {Promise<string>} the page script source. */
  async function loadPageScript() {
    if (pageScript === null) pageScript = await readFile(PAGE_SCRIPT_PATH, 'utf8')
    return pageScript
  }

  return {
    server,
    /**
     * Listen on the configured address (port 0 = OS-assigned).
     * @returns {Promise<{port: number, origin: string}>}
     */
    async start() {
      const host = String(cfg.host ?? '127.0.0.1')
      const port = Number.isFinite(cfg.port) ? cfg.port : 0
      const listen = (candidate) =>
        new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off('listening', onListening)
            reject(error)
          }
          const onListening = () => {
            server.off('error', onError)
            resolve()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(candidate, host)
        })
      try {
        await listen(port)
      } catch (error) {
        // A fixed port (needed by the browser extension) may be taken. Fall back
        // to an OS-assigned port so the DSH plugin keeps working; the extension
        // then reports the bridge unavailable until that port is free.
        if (port !== 0 && error?.code === 'EADDRINUSE') {
          log.warn?.(
            'page translator: port %s is in use; falling back to a random port (extension bridge unavailable)',
            String(port),
          )
          await listen(0)
        } else {
          throw error
        }
      }
      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port
      bound = { port: actualPort, origin: `http://${host}:${actualPort}` }
      log.info?.('page translator listening on %s', bound.origin)
      return bound
    },
    /** @returns {Promise<void>} */
    async stop() {
      if (bound === null) return
      bound = null
      await new Promise((resolve) => server.close(() => resolve()))
    },
    /** @returns {object} state for a host-side status route. */
    state() {
      return {
        ok: bound !== null,
        version: PLUGIN_VERSION,
        origin: bound?.origin ?? '',
        port: bound?.port ?? 0,
        cache: { context: contextCache.size, translation: translationCache.size },
      }
    },
    /** Exposed for tests. */
    token,
  }
}

/**
 * Read a response body up to `maxBytes`.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBodyWithLimit(response, maxBytes) {
  if (response.body === null || typeof response.body?.[Symbol.asyncIterator] !== 'function') {
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) throw new TranslatorError('page-too-large', '页面超过大小上限')
    return text
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw new TranslatorError('page-too-large', '页面超过大小上限')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Map a thrown translator error to an HTTP status and JSON body.
 * @param {http.ServerResponse} response
 * @param {unknown} error
 */
function sendApiError(response, error) {
  const code = error instanceof TranslatorError ? error.code : 'internal'
  const message = error instanceof Error ? error.message : String(error)
  const status =
    code === 'forbidden'
      ? 403
      : code === 'bad-json' || code === 'body-too-large' || code === 'bad-url'
        ? 400
        : code === 'not-found'
          ? 404
          : 502
  sendJson(response, status, { ok: false, error: code, message })
}

/**
 * Build a stable cache key.
 * @param {string} pageUrl
 * @param {string} target
 * @param {string} text
 * @returns {string}
 */
function cacheKeyFor(pageUrl, target, text) {
  return `${pageUrl}\u0000${target}\u0000${createHash('sha1').update(text).digest('hex')}`
}

/**
 * @param {http.ServerResponse} response
 * @param {number} status
 * @param {object} payload
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * @param {http.ServerResponse} response
 * @param {number} status
 * @param {string} html
 */
function sendHtml(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(html)
}

/**
 * @param {unknown} error
 * @returns {TranslatorError}
 */
function normalizeApiError(error) {
  if (error instanceof TranslatorError) return error
  return new TranslatorError('llm-failed', String(error?.message ?? error).slice(0, 300))
}

/**
 * Standalone error page shown inside the browser tab.
 * @param {string} title
 * @param {string} detail
 * @returns {string}
 */
function errorPage(title, detail) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:#0f1115;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{max-width:560px;background:#151922;border:1px solid #2a2f3a;border-radius:14px;padding:24px 28px}
h1{font-size:18px;margin:0 0 10px}code{background:#0b0d12;padding:2px 6px;border-radius:6px;color:#93c5fd}
p{margin:6px 0;color:#9ca3af}a{color:#60a5fa}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
<p>返回原文：<a href="javascript:history.back()">上一页</a>，或把目标网址重新粘贴到 <code>/p?url=</code> 后面。</p></div></body></html>`
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Metadata helper re-exported for the host service (topic badge before a page load).
 * @param {string} html
 * @param {string} finalUrl
 * @returns {object}
 */
export { extractPageMeta }

