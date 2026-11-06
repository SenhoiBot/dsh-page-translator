/**
 * Browser half of the in-page translator — built-in sidebar browser only.
 *
 * The built-in sidebar browser renders pages in an Electron `<webview>` that
 * lives in this same renderer document. The plugin reaches that element,
 * injects `page-script-hosted.js` with `executeJavaScript`, and from then on the
 * REAL page shows a translate pill: clicking it translates the visible text in
 * place (layout, scripts and login untouched) and a second click restores it.
 *
 * Translation itself happens on the host (`/page-translator/*` routes) through
 * the host LLM service, so the guest page performs no network calls and never
 * sees a token.
 *
 * There is no separate panel/entry: the sidebar browser is the single entry.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-page-translator',
  factory() {
    /** The webview tag the built-in browser implementation mounts. */
    const WEBVIEW_SELECTOR = 'webview[data-sidebar-browser-frame="webview"]'
    /** Guest-page controller source route. */
    const HOSTED_ROUTE = '/page-translator/hosted.js'
    /** Context / chunk translation routes. */
    const CONTEXT_ROUTE = '/page-translator/context'
    const TRANSLATE_ROUTE = '/page-translator/translate'
    /** Diagnostic event route (host appends to ~/.dsh/page-translator.log). */
    const LOG_ROUTE = '/page-translator/log'
    /** Chunking and parallelism for one page: small chunks travel in parallel. */
    const CHUNK_CHARS = 700
    const CHUNK_ITEMS = 14
    const CONCURRENCY = 8
    /** How often the plugin asks an attached page whether the pill was clicked. */
    const POLL_MS = 400
    /** Safety rescan for webviews created outside MutationObserver coverage. */
    const RESCAN_MS = 4000
    /** Translation target language. */
    const TARGET = 'zh'
    /**
     * Namespaced key for the dragged pill position. It lives in the DSH
     * renderer's own localStorage (never in the visited page): the guest script
     * only reports `{x,y}` through executeJavaScript, and this plugin persists it.
     */
    const PILL_POSITION_KEY = 'dsh.page-translator.pill-position.v1'
    /**
     * Global the guest page reads before the controller is evaluated, so a
     * restored position paints immediately instead of jumping after first fit.
     */
    const PILL_POSITION_GLOBAL = '__DSH_PT_PILL_POS__'

    /** @type {string | null} */
    let hostedSource = null
    /** @type {WeakSet<Element>} */
    const attached = new WeakSet()
    /** @type {WeakSet<Element>} */
    const injected = new WeakSet()
    /** Pages whose context was already requested in the background. */
    /** @type {WeakSet<Element>} */
    const prefetched = new WeakSet()
    /** @type {Set<Element>} */
    const busy = new Set()
    /** Guards one in-flight poll tick per webview (compose can exceed the interval). */
    /** @type {WeakSet<Element>} */
    const polling = new WeakSet()
    /** @type {Map<Element, number>} */
    const loops = new Map()
    /** Live count of attached built-in-browser pages (diagnostics only). */
    const browserState = { count: 0 }

    /**
     * Fire-and-forget diagnostic event, appended by the host to
     * `~/.dsh/page-translator.log`. Never throws.
     * @param {string} event
     * @param {object} [data]
     */
    function logBridge(event, data) {
      try {
        void fetch(LOG_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, data: data ?? null }),
        }).catch(() => {})
      } catch {
        // diagnostics must never break translation
      }
    }

    /**
     * Run code inside the guest page.
     * @param {any} webview
     * @param {string} code
     * @param {number} [timeoutMs]
     * @returns {Promise<any>}
     */
    function execInGuest(webview, code, timeoutMs = 30_000) {
      let timer
      return Promise.race([
        Promise.resolve(webview.executeJavaScript(code)),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('guest evaluation timed out')), timeoutMs)
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
    }

    /** @returns {Promise<string>} the guest-page controller source. */
    async function loadHostedSource() {
      if (hostedSource !== null) return hostedSource
      const response = await fetch(HOSTED_ROUTE, { headers: { accept: 'text/javascript' } })
      if (!response.ok) throw new Error('hosted script HTTP ' + response.status)
      hostedSource = await response.text()
      return hostedSource
    }

    /**
     * Same-origin POST against the host bridge.
     * @param {string} path
     * @param {object} body
     * @param {number} [timeoutMs]
     * @returns {Promise<any>}
     */
    async function postHost(path, body, timeoutMs = 60_000) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined,
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || data === null || data.ok !== true) {
          throw new Error((data && data.message) || 'HTTP ' + response.status)
        }
        return data
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    /** @param {Array<{id: string, text: string}>} segments @returns {Array<Array<{id: string, text: string}>>} */
    function chunkSegments(segments) {
      const chunks = []
      let current = []
      let chars = 0
      for (const segment of segments) {
        if (current.length > 0 && (chars + segment.text.length > CHUNK_CHARS || current.length >= CHUNK_ITEMS)) {
          chunks.push(current)
          current = []
          chars = 0
        }
        current.push(segment)
        chars += segment.text.length
      }
      if (current.length > 0) chunks.push(current)
      return chunks
    }

    /** JSON that is safe to embed in a JavaScript expression. */
    function embed(value) {
      return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    }

    /**
     * Read the last pill position from the DSH renderer's localStorage.
     * @returns {{x: number, y: number} | null}
     */
    function readPillPosition() {
      try {
        const raw = window.localStorage.getItem(PILL_POSITION_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        const x = Number(parsed && parsed.x)
        const y = Number(parsed && parsed.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null
        return { x, y }
      } catch {
        return null
      }
    }

    /**
     * Persist a dragged pill position in the DSH renderer's localStorage.
     * @param {{x: number, y: number}} position
     */
    function storePillPosition(position) {
      try {
        const x = Number(position && position.x)
        const y = Number(position && position.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return
        window.localStorage.setItem(PILL_POSITION_KEY, JSON.stringify({ x, y }))
      } catch {
        // storage may be unavailable/blocked; the guest keeps the position in memory
      }
    }

    /**
     * Make sure the controller (and its pill) exists in this page.
     * @param {any} webview
     * @returns {Promise<boolean>}
     */
    async function ensureHosted(webview) {
      if (injected.has(webview)) return true
      try {
        const url = typeof webview.getURL === 'function' ? String(webview.getURL() || '') : ''
        if (!/^https?:/i.test(url)) return false
        const position = readPillPosition()
        if (position !== null) {
          // Hand the saved position over before the controller builds its pill.
          try {
            await execInGuest(webview, `window.${PILL_POSITION_GLOBAL} = ${embed(position)}`, 8_000)
          } catch {
            // best effort: the guest falls back to the default corner
          }
        }
        const source = await loadHostedSource()
        const result = await execInGuest(webview, source, 15_000)
        if (result === 'installed' || result === 'ready') {
          injected.add(webview)
          if (result === 'ready' && position !== null) {
            // Re-injected controller already exists: apply the saved position.
            try {
              await execInGuest(
                webview,
                `window.__DSH_PT_PAGE__ && typeof window.__DSH_PT_PAGE__.setPillPosition === 'function' && window.__DSH_PT_PAGE__.setPillPosition(${embed(position)})`,
                8_000,
              )
            } catch {
              // older controller: dragging still works, position is in-memory only
            }
          }
          logBridge('inject', { url, result: String(result), pill: position !== null })
          return true
        }
        logBridge('inject-unexpected', { url, result: String(result).slice(0, 80) })
        return false
      } catch {
        return false
      }
    }

    /**
     * Report progress into the guest page's pill.
     * @param {any} webview
     * @param {string} state
     * @param {string} label
     * @param {string} [detail]
     */
    async function setGuestStatus(webview, state, label, detail) {
      try {
        await execInGuest(
          webview,
          `window.__DSH_PT_PAGE__ && window.__DSH_PT_PAGE__.status(${embed(state)}, ${embed(label)}, ${embed(detail ?? '')})`,
          8_000,
        )
      } catch {
        // the page may have navigated away; the next dom-ready re-installs
      }
    }

    /**
     * Warm the host context cache for this page in the background, so a click
     * does not pay the page-analysis round trip. Best effort, never blocks.
     * @param {any} webview
     */
    async function prefetchContext(webview) {
      if (prefetched.has(webview) || busy.has(webview)) return
      prefetched.add(webview)
      const started = Date.now()
      try {
        const info = await execInGuest(
          webview,
          'window.__DSH_PT_PAGE__.pageContext ? window.__DSH_PT_PAGE__.pageContext() : window.__DSH_PT_PAGE__.collect()',
          15_000,
        )
        const context = info !== null && typeof info === 'object' && info.context ? info.context : null
        if (context === null) {
          prefetched.delete(webview)
          return
        }
        const data = await postHost(CONTEXT_ROUTE, context, 20_000)
        logBridge('prefetch', {
          url: String((context && context.url) || webview.getURL?.() || ''),
          ms: Date.now() - started,
          cached: data.cached === true,
          llm: data.llm ?? null,
        })
      } catch {
        prefetched.delete(webview)
      }
    }

    /**
     * Translate the current page in place.
     * @param {any} webview
     */
    async function translateInGuest(webview) {
      const started = Date.now()
      try {
        const info = await execInGuest(webview, 'window.__DSH_PT_PAGE__.collect()', 20_000)
        const segments = info !== null && typeof info === 'object' && Array.isArray(info.segments) ? info.segments : []
        if (segments.length === 0) {
          await setGuestStatus(webview, 'done', '无需翻译', '没有找到需要翻译的正文')
          logBridge('translate-empty', { url: String(webview.getURL?.() ?? '') })
          return
        }
        await setGuestStatus(webview, 'busy', '翻译中 0%', '')
        let context = null
        let contextMs = 0
        let contextCached = null
        let contextLlm = null
        try {
          const contextStarted = Date.now()
          const contextData = await postHost(CONTEXT_ROUTE, info.context ?? {}, 20_000)
          contextMs = Date.now() - contextStarted
          contextCached = contextData.cached === true
          contextLlm = contextData.llm ?? null
          context = contextData.context ?? null
        } catch {
          context = null
        }
        const pageUrl = String((info.context && info.context.url) || (typeof webview.getURL === 'function' ? webview.getURL() : '') || '')
        const chunks = chunkSegments(segments)
        let done = 0
        let applied = 0
        const chunkSamples = []
        const workers = []
        let cursor = 0
        for (let index = 0; index < Math.min(CONCURRENCY, chunks.length); index += 1) {
          workers.push(
            (async () => {
              while (cursor < chunks.length) {
                const chunk = chunks[cursor]
                cursor += 1
                try {
                  const data = await postHost(
                    TRANSLATE_ROUTE,
                    { url: pageUrl, target: TARGET, context, segments: chunk },
                    45_000,
                  )
                  if (data.llm !== null && data.llm !== undefined) chunkSamples.push(data.llm)
                  const table = data.translations ?? {}
                  applied += Number(await execInGuest(webview, `window.__DSH_PT_PAGE__.apply(${embed(table)})`, 10_000)) || 0
                } catch {
                  // keep the original text for this chunk
                }
                done += 1
                await setGuestStatus(webview, 'busy', '翻译中 ' + Math.round((done / chunks.length) * 100) + '%', '')
              }
            })(),
          )
        }
        await Promise.all(workers)
        const seconds = ((Date.now() - started) / 1000).toFixed(1)
        if (applied === 0) {
          await setGuestStatus(webview, 'error', '翻译失败', '模型没有返回可用译文')
          return
        }
        await setGuestStatus(webview, 'done', '已译 100%', '')
        logBridge('translated', {
          url: pageUrl,
          applied,
          chunks: chunks.length,
          seconds: Number(seconds),
          contextMs,
          contextCached,
          contextLlm,
          chunkLlm: chunkSamples[0] ?? null,
          chunkMs: chunkSamples.map((sample) => sample.ms),
        })
      } catch (error) {
        await setGuestStatus(webview, 'error', '翻译失败', String(error && error.message ? error.message : error).slice(0, 100))
        logBridge('translate-error', {
          url: String(webview.getURL?.() ?? ''),
          message: String(error && error.message ? error.message : error).slice(0, 200),
        })
      }
    }

    /**
     * Translate only the segments that appeared after the page was translated
     * (infinite scroll / Reddit SPA navigation / expanded comments).
     * @param {any} webview
     * @param {{segments: Array<{id: string, text: string}>, context?: object}} info
     */
    async function translateFollowInGuest(webview, info) {
      const segments = info !== null && typeof info === 'object' && Array.isArray(info.segments) ? info.segments : []
      if (segments.length === 0) return
      const started = Date.now()
      try {
        let context = null
        try {
          const contextData = await postHost(CONTEXT_ROUTE, info.context ?? {}, 20_000)
          context = contextData.context ?? null
        } catch {
          context = null
        }
        const pageUrl = String((info.context && info.context.url) || webview.getURL?.() || '')
        const chunks = chunkSegments(segments)
        let done = 0
        let applied = 0
        let cursor = 0
        try {
          await execInGuest(webview, `window.__DSH_PT_PAGE__.progress(${embed('更新中 0%')})`, 8_000)
        } catch {
          // page may be navigating
        }
        const workers = []
        for (let index = 0; index < Math.min(CONCURRENCY, chunks.length); index += 1) {
          workers.push(
            (async () => {
              while (cursor < chunks.length) {
                const chunk = chunks[cursor]
                cursor += 1
                try {
                  const data = await postHost(
                    TRANSLATE_ROUTE,
                    { url: pageUrl, target: TARGET, context, segments: chunk },
                    45_000,
                  )
                  const table = data.translations ?? {}
                  applied += Number(await execInGuest(webview, `window.__DSH_PT_PAGE__.apply(${embed(table)})`, 10_000)) || 0
                } catch {
                  // keep originals for this chunk
                }
                done += 1
                try {
                  await execInGuest(
                    webview,
                    `window.__DSH_PT_PAGE__.progress(${embed('更新中 ' + Math.round((done / chunks.length) * 100) + '%')})`,
                    8_000,
                  )
                } catch {
                  // page may be navigating
                }
              }
            })(),
          )
        }
        await Promise.all(workers)
        if (applied > 0) await setGuestStatus(webview, 'done', '已译 100%', '')
        logBridge('followed', {
          url: pageUrl,
          segments: segments.length,
          applied,
          ms: Date.now() - started,
        })
      } catch (error) {
        logBridge('follow-error', { message: String(error && error.message ? error.message : error).slice(0, 160) })
      }
    }

    /**
     * Translate the draft typed in the pill's reply box (Chinese -> English),
     * using the page's topic/tone as context.
     * @param {any} webview
     * @param {{text: string, tone?: string}} draft
     */
    async function composeInGuest(webview, draft) {
      try {
        const text = String(draft && draft.text ? draft.text : '')
        const tone = String(draft && draft.tone ? draft.tone : 'natural')
        const info = await execInGuest(
          webview,
          'window.__DSH_PT_PAGE__.pageContext ? window.__DSH_PT_PAGE__.pageContext() : window.__DSH_PT_PAGE__.collect()',
          15_000,
        )
        const context = info !== null && typeof info === 'object' && info.context ? info.context : {}
        const pageUrl = String((context && context.url) || (typeof webview.getURL === 'function' ? webview.getURL() : '') || '')
        const data = await postHost(
          '/page-translator/compose',
          { text, context, url: pageUrl, title: String(context.title ?? ''), target: 'en', tone },
          60_000,
        )
        await execInGuest(webview, `window.__DSH_PT_PAGE__.composeResult(${embed(String(data.text ?? ''))})`, 10_000)
        logBridge('composed', { url: pageUrl, chars: text.length, tone, ms: data.ms ?? null })
      } catch (error) {
        const message = String(error && error.message ? error.message : error).slice(0, 160)
        try {
          await execInGuest(webview, `window.__DSH_PT_PAGE__.composeError(${embed(message)})`, 8_000)
        } catch {
          // page navigated away
        }
        logBridge('compose-error', { message })
      }
    }

    /**
     * Restore the guest page to its original text.
     * @param {any} webview
     */
    async function restoreInGuest(webview) {
      try {
        const restored = await execInGuest(webview, 'window.__DSH_PT_PAGE__.restore()', 10_000)
        await setGuestStatus(webview, 'idle', '译', '')
        logBridge('restored', { url: String(webview.getURL?.() ?? ''), restored })
      } catch {
        // page navigated away
      }
    }

    /**
     * Attach to one webview: install the controller, then relay its pill requests.
     * @param {any} webview
     */
    function attachWebview(webview) {
      if (webview === null || typeof webview !== 'object' || attached.has(webview)) return
      attached.add(webview)
      const onReady = () => {
        injected.delete(webview)
        prefetched.delete(webview)
        logBridge('dom-ready', { url: String(webview.getURL?.() ?? '') })
        void ensureHosted(webview)
      }
      const onDestroyed = () => {
        const timer = loops.get(webview)
        if (timer !== undefined) clearInterval(timer)
        loops.delete(webview)
        busy.delete(webview)
      }
      try {
        webview.addEventListener('dom-ready', onReady)
        webview.addEventListener('destroyed', onDestroyed)
      } catch {
        // tests may pass a fake element without event APIs
      }
      void ensureHosted(webview)
      const timer = setInterval(async () => {
        if (!webview.isConnected || busy.has(webview) || polling.has(webview)) return
        polling.add(webview)
        try {
          if (!(await ensureHosted(webview))) return
          if (!prefetched.has(webview)) void prefetchContext(webview)
          // A dragged pill reports its new left/top once; keep it in DSH storage.
          const dragged = await execInGuest(
            webview,
            'window.__DSH_PT_PAGE__.pollPillPosition ? window.__DSH_PT_PAGE__.pollPillPosition() : null',
            8_000,
          )
          if (dragged !== null && typeof dragged === 'object') {
            storePillPosition(dragged)
            logBridge('pill-moved', { x: Number(dragged.x), y: Number(dragged.y) })
          }
          const composeDraft = await execInGuest(
            webview,
            'window.__DSH_PT_PAGE__.pollCompose ? window.__DSH_PT_PAGE__.pollCompose() : null',
            8_000,
          )
          if (composeDraft !== null && typeof composeDraft === 'object' && typeof composeDraft.text === 'string' && composeDraft.text !== '') {
            logBridge('compose', { chars: composeDraft.text.length, url: String(webview.getURL?.() ?? '') })
            await composeInGuest(webview, composeDraft)
          }
          const action = await execInGuest(webview, 'window.__DSH_PT_PAGE__.poll()', 8_000)
          if (action === 'translate' || action === 'restore') {
            logBridge('action', { action, url: String(webview.getURL?.() ?? '') })
            busy.add(webview)
            try {
              if (action === 'translate') await translateInGuest(webview)
              else await restoreInGuest(webview)
            } finally {
              busy.delete(webview)
            }
            return
          }
          // Follow SPA navigation / infinite scroll / expanded comments.
          const follow = await execInGuest(
            webview,
            'window.__DSH_PT_PAGE__.follow ? window.__DSH_PT_PAGE__.follow() : null',
            15_000,
          )
          if (follow !== null && typeof follow === 'object' && Array.isArray(follow.segments) && follow.segments.length > 0) {
            logBridge('follow', { segments: follow.segments.length, url: String(webview.getURL?.() ?? '') })
            busy.add(webview)
            try {
              await translateFollowInGuest(webview, follow)
            } finally {
              busy.delete(webview)
            }
          }
        } catch {
          // transient: page loading, navigating or detached
        } finally {
          polling.delete(webview)
        }
      }, POLL_MS)
      loops.set(webview, timer)
    }

    /** Scan the document for webviews and attach to every one. */
    function scanWebviews() {
      const webviews = Array.from(document.querySelectorAll(WEBVIEW_SELECTOR))
      for (const webview of webviews) attachWebview(webview)
      const attachedCount = webviews.filter((webview) => attached.has(webview)).length
      if (browserState.count !== attachedCount) {
        browserState.count = attachedCount
        logBridge('webviews', {
          count: attachedCount,
          urls: webviews.map((webview) => String(webview.getURL?.() ?? '')).slice(0, 10),
        })
      }
    }

    /**
     * Start watching the document for the built-in browser's webviews.
     * @returns {() => void} cleanup
     */
    function installBuiltinBrowserBridge() {
      logBridge('bridge-installed', { webviews: document.querySelectorAll(WEBVIEW_SELECTOR).length })
      scanWebviews()
      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        setTimeout(() => {
          scheduled = false
          scanWebviews()
        }, 300)
      }
      let observer = null
      if (typeof MutationObserver === 'function' && document.body !== null) {
        observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
      }
      const rescan = setInterval(scanWebviews, RESCAN_MS)
      return () => {
        observer?.disconnect()
        clearInterval(rescan)
        for (const timer of loops.values()) clearInterval(timer)
        loops.clear()
        busy.clear()
        browserState.count = 0
      }
    }

    /** The plugin needs no other client service: it only observes the DOM. */
    const inject = []

    /**
     * @param {import('@deepseek-ai/cordis').Context} ctx - browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => installBuiltinBrowserBridge(), 'page translator: built-in browser bridge')
    }

    return { inject, apply }
  },
})
