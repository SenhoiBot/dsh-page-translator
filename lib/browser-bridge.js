/**
 * Host-side bridge for the BUILT-IN sidebar browser mode.
 *
 * The client plugin attaches to the Electron `<webview>` that renders the
 * built-in browser page, injects `page-script-hosted.js` into that page, and
 * relays its requests here through same-origin fetches on the DSH web server:
 *
 *   GET  /page-translator/hosted.js   the guest-page controller source
 *   POST /page-translator/context     page topic + glossary (one LLM call per page)
 *   POST /page-translator/translate   one chunk of numbered segments
 *
 * Keeping the network in the renderer/host (instead of inside the guest page)
 * means the visited site never gets a token and never needs CORS.
 */

import { readFile, appendFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { TranslatorError } from './llm.js'

const HOSTED_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'page-script-hosted.js')
/** Diagnostic log written when the client reports built-in-browser attach events. */
const DIAGNOSTIC_LOG = join(homedir(), '.dsh', 'page-translator.log')
/** Rotate the diagnostic log once it grows past this size. */
const DIAGNOSTIC_LOG_LIMIT = 256 * 1024
const MAX_BODY_BYTES = 1024 * 1024
const CONTEXT_TTL_MS = 10 * 60 * 1000
const CONTEXT_CACHE_LIMIT = 200
const TRANSLATION_CACHE_LIMIT = 20_000

/**
 * Create the web-server routes for the built-in-browser bridge.
 * @param {object} options
 * @param {import('./llm.js').LlmTranslator} options.translator
 * @param {object} [options.config]
 * @param {object} [options.logger]
 * @returns {Array<{path: string, handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void}>}
 */
export function createBrowserBridge({ translator, config, logger }) {
  const log = logger ?? console
  const target = String(config?.target ?? 'zh')
  /** @type {Map<string, {context: object, at: number}>} */
  const contextCache = new Map()
  /** @type {Map<string, string>} */
  const translationCache = new Map()
  /** Deduplicates concurrent context calls for the same page (prefetch + click). */
  /** @type {Map<string, Promise<object>>} */
  const inflightContext = new Map()
  let hostedScript = null

  /** @returns {Promise<string>} current controller source, re-read so edits apply without a host restart. */
  async function loadHostedScript() {
    hostedScript = await readFile(HOSTED_SCRIPT_PATH, 'utf8')
    return hostedScript
  }

  /** @param {import('node:http').IncomingMessage} request @param {number} [limit] @returns {Promise<any>} */
  async function readJson(request, limit = MAX_BODY_BYTES) {
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

  /** @param {import('node:http').ServerResponse} response @param {number} status @param {object} payload */
  function sendJson(response, status, payload) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(payload))
  }

  /** @param {import('node:http').ServerResponse} response @param {unknown} error */
  function sendError(response, error) {
    const code = error instanceof TranslatorError ? error.code : 'internal'
    const status = code === 'bad-json' || code === 'body-too-large' ? 400 : 502
    sendJson(response, status, { ok: false, error: code, message: error instanceof Error ? error.message : String(error) })
  }

  /** @param {string} pageUrl @param {string} text @returns {string} */
  function cacheKey(pageUrl, text) {
    return `${pageUrl}\u0000${target}\u0000${createHash('sha1').update(text).digest('hex')}`
  }

  /** @param {Map<string, string>} map @param {string} key @param {string} value */
  function remember(map, key, value) {
    if (map.has(key)) map.delete(key)
    map.set(key, value)
    while (map.size > TRANSLATION_CACHE_LIMIT) {
      const oldest = map.keys().next()
      if (oldest.done === true) break
      map.delete(oldest.value)
    }
  }

  /** @param {Map<string, {context: object, at: number}>} map @param {string} key @param {object} context */
  function rememberContext(map, key, context) {
    if (map.has(key)) map.delete(key)
    map.set(key, { context, at: Date.now() })
    while (map.size > CONTEXT_CACHE_LIMIT) {
      const oldest = map.keys().next()
      if (oldest.done === true) break
      map.delete(oldest.value)
    }
  }

  return [
    {
      path: '/page-translator/log',
      handler: (request, response) => {
        readJson(request, 32 * 1024)
          .then(async (body) => {
            const record = {
              at: new Date().toISOString(),
              event: typeof body?.event === 'string' ? body.event.slice(0, 60) : 'unknown',
              data: body !== null && typeof body === 'object' ? body.data ?? null : null,
            }
            try {
              await mkdir(dirname(DIAGNOSTIC_LOG), { recursive: true })
              const info = await stat(DIAGNOSTIC_LOG).catch(() => null)
              const line = JSON.stringify(record) + '\n'
              if (info !== null && info.size > DIAGNOSTIC_LOG_LIMIT) await writeFile(DIAGNOSTIC_LOG, line, 'utf8')
              else await appendFile(DIAGNOSTIC_LOG, line, 'utf8')
            } catch (error) {
              log.warn?.('page translator: diagnostic log failed: %s', String(error))
            }
            sendJson(response, 200, { ok: true })
          })
          .catch(() => {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            response.end('{"ok":true}')
          })
      },
    },
    {
      path: '/page-translator/hosted.js',
      handler: (request, response) => {
        loadHostedScript()
          .then((source) => {
            response.writeHead(200, {
              'content-type': 'text/javascript; charset=utf-8',
              'cache-control': 'no-store',
            })
            response.end(source)
          })
          .catch((error) => sendError(response, error))
      },
    },
    {
      path: '/page-translator/context',
      handler: (request, response) => {
        readJson(request)
          .then(async (body) => {
            const page = {
              url: String(body?.url ?? ''),
              title: String(body?.title ?? ''),
              lang: String(body?.lang ?? ''),
              meta: body?.meta !== null && typeof body?.meta === 'object' ? body.meta : {},
              headings: Array.isArray(body?.headings) ? body.headings.slice(0, 18) : [],
              sample: String(body?.sample ?? ''),
            }
            const cached = contextCache.get(page.url)
            if (cached !== undefined && Date.now() - cached.at < CONTEXT_TTL_MS) {
              sendJson(response, 200, { ok: true, context: cached.context, cached: true, llm: null })
              return
            }
            const started = Date.now()
            let pending = inflightContext.get(page.url)
            if (pending === undefined) {
              pending = translator
                .analyzeContext(page)
                .then((context) => {
                  rememberContext(contextCache, page.url, context)
                  return context
                })
                .finally(() => {
                  inflightContext.delete(page.url)
                })
              inflightContext.set(page.url, pending)
            }
            const context = await pending
            sendJson(response, 200, {
              ok: true,
              context,
              cached: false,
              ms: Date.now() - started,
              llm: translator.lastCall ?? null,
            })
          })
          .catch((error) => {
            log.warn?.('page translator: context route failed: %s', String(error))
            sendError(response, error)
          })
      },
    },
    {
      path: '/page-translator/translate',
      handler: (request, response) => {
        readJson(request)
          .then(async (body) => {
            const pageUrl = String(body?.url ?? '')
            const context = body?.context !== null && typeof body?.context === 'object' ? body.context : null
            const segments = []
            for (const segment of Array.isArray(body?.segments) ? body.segments : []) {
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
              const hit = translationCache.get(cacheKey(pageUrl, segment.text))
              if (typeof hit === 'string') translations[segment.id] = hit
              else missing.push(segment)
            }
            if (missing.length > 0) {
              const translated = await translator.translateChunk({ context, segments: missing, pageUrl })
              for (const [id, text] of Object.entries(translated)) {
                translations[id] = text
                const segment = missing.find((candidate) => candidate.id === id)
                if (segment !== undefined) remember(translationCache, cacheKey(pageUrl, segment.text), text)
              }
            }
            sendJson(response, 200, {
              ok: true,
              translations,
              cached: segments.length - missing.length,
              ms: Date.now() - started,
              llm: translator.lastCall ?? null,
            })
          })
          .catch((error) => {
            log.warn?.('page translator: translate route failed: %s', String(error))
            sendError(response, error)
          })
      },
    },
    {
      path: '/page-translator/compose',
      handler: (request, response) => {
        readJson(request, 64 * 1024)
          .then(async (body) => {
            const text = typeof body?.text === 'string' ? body.text : ''
            const context = body?.context !== null && typeof body?.context === 'object' ? body.context : null
            const pageUrl = String(body?.url ?? '')
            const target = typeof body?.target === 'string' && body.target !== '' ? body.target : 'en'
            const tone = typeof body?.tone === 'string' && body.tone !== '' ? body.tone : 'natural'
            const pageTitle = String(body?.title ?? '')
            const started = Date.now()
            const translated = await translator.translateComposition({ text, context, pageUrl, pageTitle, target, tone })
            sendJson(response, 200, { ok: true, text: translated, ms: Date.now() - started, llm: translator.lastCall ?? null })
          })
          .catch((error) => {
            log.warn?.('page translator: compose route failed: %s', String(error))
            sendError(response, error)
          })
      },
    },
  ]
}
