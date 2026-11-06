/**
 * In-page translator (browser half, served by the loopback proxy at /pt.js).
 *
 * Runs same-origin with the proxy page, so it can read the DOM and POST to
 * `/api/context` and `/api/translate` without CORS. Translation replaces text
 * nodes in place — the page keeps its own layout, fonts, images and spacing —
 * and the toolbar button toggles between the original and the translation.
 *
 * Design constraints:
 *  - never hold an API key: the proxy talks to the host LLM service;
 *  - keep the page responsive: skip hidden/代码/表单 nodes, dedupe identical
 *    strings, translate in parallel chunks and paint each chunk as it lands;
 *  - fail soft: a chunk that fails leaves its text in the original language and
 *    the toolbar reports how many segments were skipped.
 */
(function () {
  'use strict'

  /** Elements whose text must stay untouched. */
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1,
    CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, SVG: 1, MATH: 1, IFRAME: 1, CANVAS: 1,
    VIDEO: 1, AUDIO: 1, OBJECT: 1, EMBED: 1, TITLE: 1, META: 1, LINK: 1,
  }
  /** Characters that mean "already Chinese". */
  var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
  /** Strings that are structural noise, not prose. */
  var NOISE_RE = /^(?:https?:\/\/|www\.)\S*$/i
  /** Punctuation / numbers only. */
  var ONLY_PUNCT_RE = /^[\s\d\p{P}\p{S}]+$/u
  /** Chunk limits: small chunks keep the model fast and the JSON reliable. */
  var CHUNK_CHARS = 1400
  var CHUNK_ITEMS = 26
  /** Parallel chunk requests; each is one host LLM call. */
  var CONCURRENCY = 4

  /* ------------------------------------------------------------------ state */

  var boot = null
  /** @type {Map<Text, string>} original text per mutated node */
  var originals = new Map()
  /** @type {Text[]} mutated nodes, in document order (Map is not iterable-safe on all engines) */
  var mutated = []
  /** @type {{root: Element, label: Element, topic: Element} | null} */
  var ui = null
  var phase = 'idle'
  /** @type {object | null} */
  var pageContext = null
  var contextPromise = null
  var skippedCount = 0
  var failedCount = 0

  /* --------------------------------------------------------------- utilities */

  /**
   * Visible text of an element, collapsed.
   * @param {string} text
   * @returns {string}
   */
  function squash(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  }

  /**
   * Whether a node is worth translating.
   * @param {Text} node
   * @returns {boolean}
   */
  function isTranslatable(node) {
    var parent = node.parentElement
    if (!parent) return false
    if (SKIP_TAGS[parent.tagName] === 1) return false
    if (parent.closest && parent.closest('#dsh-pt-root')) return false
    if (parent.isContentEditable) return false
    if (parent.getAttribute && parent.getAttribute('aria-hidden') === 'true') return false
    var text = squash(node.nodeValue)
    if (text.length < 2) return false
    if (NOISE_RE.test(text)) return false
    if (ONLY_PUNCT_RE.test(text)) return false
    if (!/[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(text)) return false
    // Hidden nodes: only judge when the document actually has a layout (jsdom does not).
    if (typeof parent.getClientRects === 'function' && document.body && document.body.getClientRects().length > 0) {
      if (parent.getClientRects().length === 0) return false
    }
    return true
  }

  /**
   * Skip strings that are already in the target language.
   * @param {string} text
   * @param {string} target
   * @returns {boolean}
   */
  function alreadyTarget(text, target) {
    if (target !== 'zh') return false
    var cjk = 0
    var letters = 0
    for (var index = 0; index < text.length; index += 1) {
      var char = text[index]
      if (CJK_RE.test(char)) cjk += 1
      else if (/[A-Za-z]/.test(char)) letters += 1
    }
    return cjk > 0 && cjk >= letters * 2
  }

  /**
   * Collect unique translatable segments from the document.
   * @param {Document} doc
   * @param {string} target
   * @returns {{items: Array<{id: string, text: string, nodes: Text[]}>, totalNodes: number}}
   */
  function collectSegments(doc, target) {
    var walker = doc.createTreeWalker(doc.body || doc.documentElement, 4 /* SHOW_TEXT */, null)
    var byText = new Map()
    var items = []
    var node
    while ((node = walker.nextNode()) !== null) {
      if (!isTranslatable(node)) continue
      var text = squash(node.nodeValue)
      if (alreadyTarget(text, target)) continue
      var bucket = byText.get(text)
      if (!bucket) {
        bucket = { id: String(items.length + 1), text: text, nodes: [] }
        byText.set(text, bucket)
        items.push(bucket)
      }
      bucket.nodes.push(node)
    }
    return { items: items, totalNodes: items.reduce(function (sum, item) { return sum + item.nodes.length }, 0) }
  }

  /**
   * Greedily group unique segments into chunks.
   * @param {Array<{id: string, text: string}>} segments
   * @returns {Array<Array<{id: string, text: string}>>}
   */
  function chunkSegments(segments) {
    var chunks = []
    var current = []
    var chars = 0
    for (var index = 0; index < segments.length; index += 1) {
      var segment = segments[index]
      var size = segment.text.length
      if (current.length > 0 && (chars + size > CHUNK_CHARS || current.length >= CHUNK_ITEMS)) {
        chunks.push(current)
        current = []
        chars = 0
      }
      current.push(segment)
      chars += size
    }
    if (current.length > 0) chunks.push(current)
    return chunks
  }

  /**
   * Replace a text node's value, keeping its leading/trailing whitespace.
   * @param {Text} node
   * @param {string} translated
   */
  function paintNode(node, translated) {
    var original = node.nodeValue == null ? '' : node.nodeValue
    var leading = (/^\s*/.exec(original) || [''])[0]
    var trailing = (/\s*$/.exec(original) || [''])[0]
    if (!originals.has(node)) {
      originals.set(node, original)
      mutated.push(node)
    }
    node.nodeValue = leading + translated + trailing
  }

  /**
   * Write a translated table back into the DOM, chunk by chunk.
   * @param {Array<{id: string, nodes: Text[]}>} items
   * @param {Record<string, string>} table
   * @returns {number} applied segment count
   */
  function applyTranslations(items, table) {
    var applied = 0
    for (var index = 0; index < items.length; index += 1) {
      var item = items[index]
      var translated = table[item.id]
      if (typeof translated !== 'string' || translated === '') continue
      var changed = false
      for (var nodeIndex = 0; nodeIndex < item.nodes.length; nodeIndex += 1) {
        var node = item.nodes[nodeIndex]
        if (!node.isConnected) continue
        paintNode(node, translated)
        changed = true
      }
      if (changed) applied += 1
    }
    return applied
  }

  /**
   * Put every mutated node back to its original text.
   * @returns {number} restored node count
   */
  function restoreTranslations() {
    var restored = 0
    for (var index = 0; index < mutated.length; index += 1) {
      var node = mutated[index]
      var original = originals.get(node)
      if (original !== undefined && node.isConnected) {
        node.nodeValue = original
        restored += 1
      }
    }
    originals = new Map()
    mutated = []
    return restored
  }

  /* ---------------------------------------------------------------- browser */

  /**
   * Visible body text, falling back to textContent where innerText is missing.
   * @returns {string}
   */
  function bodyText() {
    var body = document.body
    if (!body) return ''
    if (typeof body.innerText === 'string') return body.innerText
    return body.textContent || ''
  }

  /**
   * Build the page metadata used by the context stage.
   * @returns {object}
   */
  function extractPageContext() {
    var metaOf = function (name) {
      var element = document.querySelector('meta[name="' + name + '"]')
      return element ? String(element.getAttribute('content') || '') : ''
    }
    var propOf = function (property) {
      var element = document.querySelector('meta[property="' + property + '"]')
      return element ? String(element.getAttribute('content') || '') : ''
    }
    var headings = []
    var nodes = document.querySelectorAll('h1,h2,h3')
    for (var index = 0; index < nodes.length && headings.length < 18; index += 1) {
      var text = squash(nodes[index].textContent)
      if (text !== '' && headings.indexOf(text) === -1) headings.push(text)
    }
    return {
      url: (boot && boot.pageUrl) || location.href,
      title: document.title || '',
      lang: document.documentElement.lang || '',
      meta: {
        description: metaOf('description'),
        siteName: propOf('og:site_name'),
        ogType: propOf('og:type'),
        keywords: metaOf('keywords'),
      },
      headings: headings,
      sample: squash(bodyText()).slice(0, 1800),
    }
  }

  /**
   * POST a JSON request to the same-origin proxy API.
   * @param {string} path
   * @param {object} body
   * @param {number} [timeoutMs]
   * @returns {Promise<object>}
   */
  async function api(path, body, timeoutMs) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null
    var timer = controller && timeoutMs ? setTimeout(function () { controller.abort() }, timeoutMs) : null
    // The page carries a <base> pointing at the original site, so relative URLs
    // would resolve against the target origin. Always call the proxy explicitly.
    var target = ((boot && boot.proxyOrigin) || location.origin) + path
    try {
      var response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pt-token': (boot && boot.token) || '' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      })
      var data = await response.json().catch(function () { return null })
      if (!response.ok || !data || data.ok !== true) {
        var message = (data && data.message) || ('HTTP ' + response.status)
        throw new Error(message)
      }
      return data
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /* --------------------------------------------------------------------- UI */

  /* --------------------------------------------------- toolbar position + drag */

  /** Pointer travel (px) before a press becomes a drag instead of a click. */
  var DRAG_THRESHOLD = 5
  /** Keep the toolbar this far from the viewport edges. */
  var EDGE_MARGIN = 8
  /** Descendants that must keep their native pointer behaviour (no drag). */
  var NO_DRAG_SELECTOR = 'input, textarea, select, button, option, a, label, [contenteditable="true"]'

  /** Last dragged {x,y}; module memory lasts for this page (no host bridge here). */
  var pillPosition = null
  /** True for the click synthesized right after a drag: it must not toggle. */
  var suppressClick = false
  /** Active press/drag state, null when idle. */
  var dragState = null
  /** Whether the viewport resize listener is installed. */
  var resizeBound = false

  function numberOr(value, fallback) {
    var next = Number(value)
    return isFinite(next) ? next : fallback
  }

  function clampValue(value, min, max) {
    if (!isFinite(value)) return min
    if (max < min) max = min
    return value < min ? min : value > max ? max : value
  }

  function viewportSize() {
    var width = Number(window.innerWidth)
    var height = Number(window.innerHeight)
    var documentElement = document.documentElement
    if (!isFinite(width) || width <= 0) width = documentElement ? Number(documentElement.clientWidth) : 0
    if (!isFinite(height) || height <= 0) height = documentElement ? Number(documentElement.clientHeight) : 0
    return {
      width: isFinite(width) && width > 0 ? width : 0,
      height: isFinite(height) && height > 0 ? height : 0,
    }
  }

  /**
   * Clamp a left/top pair so the toolbar stays inside the viewport with the
   * edge margin. Pure on purpose: the tests call it directly (jsdom has no layout).
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number} viewportWidth
   * @param {number} viewportHeight
   * @param {number} [margin]
   * @returns {{x: number, y: number}}
   */
  function clampPillPosition(x, y, width, height, viewportWidth, viewportHeight, margin) {
    var edge = numberOr(margin, EDGE_MARGIN)
    var boxWidth = Math.max(0, numberOr(width, 0))
    var boxHeight = Math.max(0, numberOr(height, 0))
    var vw = Math.max(0, numberOr(viewportWidth, 0))
    var vh = Math.max(0, numberOr(viewportHeight, 0))
    return {
      x: clampValue(numberOr(x, edge), edge, Math.max(edge, vw - boxWidth - edge)),
      y: clampValue(numberOr(y, edge), edge, Math.max(edge, vh - boxHeight - edge)),
    }
  }

  /**
   * Bounding box of the toolbar. Falls back to inline left/top or the default
   * right/bottom corner when the engine reports an empty rect (jsdom, tests).
   * @returns {{left: number, top: number, width: number, height: number}}
   */
  function pillBox() {
    var root = ui ? ui.root : null
    var rect = root && typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null
    var width = rect ? numberOr(rect.width, 0) : 0
    var height = rect ? numberOr(rect.height, 0) : 0
    var left = rect ? numberOr(rect.left, 0) : 0
    var top = rect ? numberOr(rect.top, 0) : 0
    if (width <= 0 && height <= 0 && left <= 0 && top <= 0) {
      var inlineLeft = root && root.style ? parseFloat(root.style.left) : NaN
      var inlineTop = root && root.style ? parseFloat(root.style.top) : NaN
      if (isFinite(inlineLeft) && isFinite(inlineTop)) {
        left = inlineLeft
        top = inlineTop
      } else if (pillPosition !== null) {
        left = pillPosition.x
        top = pillPosition.y
      } else {
        var view = viewportSize()
        left = Math.max(0, view.width - 18 - width)
        top = Math.max(0, view.height - 18 - height)
      }
    }
    return { left: left, top: top, width: width, height: height }
  }

  /** Write an absolute left/top position onto the toolbar (right/bottom off). */
  function applyPillPosition(root, position) {
    var box = pillBox()
    var clamped = clampPillPosition(
      position.x,
      position.y,
      box.width,
      box.height,
      viewportSize().width,
      viewportSize().height,
      EDGE_MARGIN,
    )
    pillPosition = clamped
    root.style.left = clamped.x + 'px'
    root.style.top = clamped.y + 'px'
    root.style.right = 'auto'
    root.style.bottom = 'auto'
    return clamped
  }

  /** Re-clamp the dragged toolbar after a viewport resize. */
  function repaintPillPosition() {
    if (pillPosition === null || ui === null) return
    applyPillPosition(ui.root, { x: pillPosition.x, y: pillPosition.y })
  }

  function startPillDrag(event) {
    if (dragState !== null || event === null || typeof event !== 'object') return
    if (event.isPrimary === false) return
    if (typeof event.button === 'number' && event.button > 0) return
    var target = event.target
    if (target !== null && typeof target.closest === 'function' && target.closest(NO_DRAG_SELECTOR) !== null) return
    var current = ensureUi()
    var box = pillBox()
    dragState = {
      pointerId: event.pointerId === undefined ? null : event.pointerId,
      startX: numberOr(event.clientX, 0),
      startY: numberOr(event.clientY, 0),
      originX: box.left,
      originY: box.top,
      width: box.width,
      height: box.height,
      moved: false,
    }
    if (dragState.pointerId !== null && typeof current.root.setPointerCapture === 'function') {
      try {
        current.root.setPointerCapture(dragState.pointerId)
      } catch (error) {
        // jsdom / engines without pointer capture
      }
    }
  }

  function movePillDrag(event) {
    if (dragState === null || event === null || typeof event !== 'object') return
    if (dragState.pointerId !== null && event.pointerId !== undefined && event.pointerId !== dragState.pointerId) return
    var dx = numberOr(event.clientX, dragState.startX) - dragState.startX
    var dy = numberOr(event.clientY, dragState.startY) - dragState.startY
    if (!dragState.moved) {
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return
      dragState.moved = true
    }
    if (event.cancelable !== false && typeof event.preventDefault === 'function') event.preventDefault()
    var current = ensureUi()
    var clamped = clampPillPosition(
      dragState.originX + dx,
      dragState.originY + dy,
      dragState.width,
      dragState.height,
      viewportSize().width,
      viewportSize().height,
      EDGE_MARGIN,
    )
    pillPosition = clamped
    current.root.style.left = clamped.x + 'px'
    current.root.style.top = clamped.y + 'px'
    current.root.style.right = 'auto'
    current.root.style.bottom = 'auto'
  }

  function endPillDrag() {
    if (dragState === null) return
    var state = dragState
    dragState = null
    var current = ensureUi()
    if (state.pointerId !== null && typeof current.root.releasePointerCapture === 'function') {
      try {
        current.root.releasePointerCapture(state.pointerId)
      } catch (error) {
        // jsdom / engines without pointer capture
      }
    }
    // A press that never passed the threshold stays a plain click.
    if (!state.moved) return
    suppressClick = true
    setTimeout(function () {
      suppressClick = false
    }, 0)
  }

  function bindPillDrag(root) {
    root.addEventListener('pointerdown', startPillDrag)
    root.addEventListener('pointermove', movePillDrag)
    root.addEventListener('pointerup', endPillDrag)
    root.addEventListener('pointercancel', endPillDrag)
  }

  function bindViewportResize() {
    if (resizeBound || typeof window.addEventListener !== 'function') return
    resizeBound = true
    window.addEventListener('resize', function () {
      repaintPillPosition()
    })
  }

  function ensureUi() {
    if (ui) return ui
    var root = document.createElement('div')
    root.id = 'dsh-pt-root'
    root.setAttribute('data-state', 'idle')
    root.setAttribute('role', 'button')
    root.setAttribute('tabindex', '0')
    root.setAttribute('title', '整页翻译：结合页面主题，把原文替换为译文；再点一次还原')
    // Inline styles: page CSS must not be able to break the toolbar.
    var style = root.style
    style.position = 'fixed'
    style.right = '18px'
    style.bottom = '18px'
    style.zIndex = '2147483647'
    style.display = 'flex'
    style.alignItems = 'center'
    style.gap = '8px'
    style.font = '500 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
    style.color = '#fff'
    style.background = 'rgba(17,24,39,.92)'
    style.border = '1px solid rgba(255,255,255,.14)'
    style.borderRadius = '999px'
    style.padding = '8px 12px'
    style.boxShadow = '0 8px 26px rgba(0,0,0,.28)'
    style.userSelect = 'none'
    style.webkitUserSelect = 'none'
    style.cursor = 'pointer'
    style.touchAction = 'none'

    var dot = document.createElement('span')
    dot.id = 'dsh-pt-dot'
    dot.style.width = '7px'
    dot.style.height = '7px'
    dot.style.borderRadius = '50%'
    dot.style.background = '#34d399'
    dot.style.flex = 'none'

    var label = document.createElement('span')
    label.id = 'dsh-pt-label'
    label.style.whiteSpace = 'nowrap'
    label.textContent = '译'

    var topic = document.createElement('span')
    topic.id = 'dsh-pt-topic'
    topic.style.maxWidth = '44vw'
    topic.style.overflow = 'hidden'
    topic.style.textOverflow = 'ellipsis'
    topic.style.whiteSpace = 'nowrap'
    topic.style.color = '#a7f3d0'
    topic.style.fontWeight = '400'
    topic.style.fontSize = '12px'
    topic.textContent = ''

    root.appendChild(dot)
    root.appendChild(label)
    root.appendChild(topic)
    root.addEventListener('click', function (event) {
      // The click synthesized after a drag must not toggle translation.
      if (suppressClick) {
        suppressClick = false
        event.preventDefault()
        event.stopPropagation()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void toggle()
    })
    root.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        void toggle()
      }
    })
    root.addEventListener('pointerenter', function () { void prefetchContext() }, { passive: true })
    ;(document.body || document.documentElement).appendChild(root)
    ui = { root: root, label: label, topic: topic }
    bindPillDrag(root)
    bindViewportResize()
    return ui
  }

  /**
   * @param {string} state - idle | busy | done | error
   * @param {string} label
   * @param {string} [detail]
   */
  function setUi(state, label, detail) {
    var current = ensureUi()
    current.root.setAttribute('data-state', state)
    current.label.textContent = label
    if (detail !== undefined) current.topic.textContent = detail
  }

  function showError(message) {
    phase = 'error'
    setUi('error', '翻译失败', strip(message))
    var current = ensureUi()
    current.root.setAttribute('title', String(message))
  }

  function strip(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').slice(0, 120)
  }

  /* -------------------------------------------------------------- translate */

  /**
   * Fetch (and cache) page context once.
   * @returns {Promise<object | null>}
   */
  function prefetchContext() {
    if (phase === 'done' || phase === 'busy') return Promise.resolve(pageContext)
    if (contextPromise) return contextPromise
    contextPromise = api('/api/context', extractPageContext(), 12_000)
      .then(function (data) {
        pageContext = data && data.context ? data.context : null
        var summary = pageContext && (pageContext.topic || pageContext.domain)
        if (summary && phase === 'idle' && ui) ui.topic.textContent = strip(summary)
        return pageContext
      })
      .catch(function () { return null })
      .finally(function () { contextPromise = null })
    return contextPromise
  }

  /**
   * Translate one chunk and paint it immediately.
   * @param {Array<{id: string, text: string}>} chunk
   * @param {Array<{id: string, nodes: Text[]}>} items
   * @param {object | null} context
   * @returns {Promise<number>} applied count
   */
  async function translateChunk(chunk, items, context) {
    var data = await api('/api/translate', {
      url: (boot && boot.pageUrl) || location.href,
      target: (boot && boot.target) || 'zh',
      context: context,
      segments: chunk,
    }, 30_000)
    var table = data && data.translations ? data.translations : {}
    return applyTranslations(items, table)
  }

  /**
   * Run the whole translation pass.
   * @returns {Promise<void>}
   */
  async function translatePage() {
    if (phase === 'busy') return
    var target = (boot && boot.target) || 'zh'
    phase = 'busy'
    skippedCount = 0
    failedCount = 0
    var startedAt = Date.now()
    setUi('busy', '翻译中…', '')

    var collected = collectSegments(document, target)
    if (collected.items.length === 0) {
      phase = 'done'
      setUi('done', '无需翻译', '没有找到需要翻译的正文')
      return
    }
    if (boot && boot.maxChars > 0) {
      var budget = boot.maxChars
      var used = 0
      var kept = []
      for (var index = 0; index < collected.items.length; index += 1) {
        var item = collected.items[index]
        if (used + item.text.length > budget) { skippedCount += 1; continue }
        kept.push(item)
        used += item.text.length
      }
      collected.items = kept
      if (collected.items.length === 0) {
        phase = 'done'
        setUi('done', '超出预算', '页面正文超过翻译字符预算')
        return
      }
    }

    var chunks = chunkSegments(collected.items.map(function (item) {
      return { id: item.id, text: item.text }
    }))
    var done = 0
    var applied = 0
    setUi('busy', '翻译中… 0/' + chunks.length, '')
    try {
      await prefetchContext()
      var context = pageContext
      // Simple worker pool: four chunks in flight, each painted on arrival.
      var cursor = 0
      var workers = []
      for (var workerIndex = 0; workerIndex < Math.min(CONCURRENCY, chunks.length); workerIndex += 1) {
        workers.push((async function () {
          while (cursor < chunks.length) {
            var chunkIndex = cursor
            cursor += 1
            try {
              applied += await translateChunk(chunks[chunkIndex], collected.items, context)
            } catch (error) {
              failedCount += chunks[chunkIndex].length
            }
            done += 1
            if (phase === 'busy') setUi('busy', '翻译中… ' + done + '/' + chunks.length, '')
          }
        })())
      }
      await Promise.all(workers)
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error))
      return
    }
    var seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    var tail = failedCount > 0 ? '，' + failedCount + ' 段失败保留原文' : ''
    if (applied === 0) {
      showError('没有可用的译文（模型返回为空）')
      return
    }
    phase = 'done'
    var summary = pageContext && pageContext.topic ? strip(pageContext.topic) : ''
    setUi('done', '已译文 · ' + applied + ' 段 · ' + seconds + 's' + tail, summary)
    ensureUi().root.setAttribute('title', '再点一次还原原文' + (summary ? '｜主题：' + summary : ''))
  }

  /**
   * Toolbar click: translate, restore, or retry.
   * @returns {Promise<void>}
   */
  async function toggle() {
    if (phase === 'busy') return
    if (phase === 'done') {
      var restored = restoreTranslations()
      phase = 'idle'
      setUi('idle', '译', '')
      ensureUi().root.setAttribute('title', '整页翻译：已还原 ' + restored + ' 处原文')
      return
    }
    if (phase === 'error') {
      phase = 'idle'
      setUi('idle', '译', '')
    }
    await translatePage()
  }

  /* ------------------------------------------------------------------- boot */

  // Test hooks: the pure DOM helpers, usable without booting the toolbar.
  window.__DSH_PT_TEST__ = {
    collectSegments: collectSegments,
    chunkSegments: chunkSegments,
    applyTranslations: applyTranslations,
    restoreTranslations: restoreTranslations,
    isTranslatable: isTranslatable,
    alreadyTarget: alreadyTarget,
    extractPageContext: extractPageContext,
    clampPillPosition: clampPillPosition,
    dragThreshold: DRAG_THRESHOLD,
  }

  if (window.__DSH_PT_DISABLE_BOOT__ === true) return
  boot = window.__DSH_PT_BOOT__
  if (!boot || !document.body) return
  ensureUi()
  if (boot.autoOpen === true) {
    setTimeout(function () { void translatePage() }, 600)
  }
})()
