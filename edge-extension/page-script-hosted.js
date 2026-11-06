/**
 * Guest-page controller for the BUILT-IN sidebar browser (Electron webview).
 *
 * Injected into the page by the client plugin via `webview.executeJavaScript`.
 * Unlike `page-script.js` (the proxied page variant), this script is same-page:
 * it runs on the real site — no proxy, no HTML rewrite — so layout, scripts,
 * logins and interactions all keep working. It performs no network calls: it
 * only walks text nodes, reports a pending request, and paints translations the
 * plugin hands back. All model calls happen in the DSH renderer / host.
 *
 * Contract (window.__DSH_PT_PAGE__):
 *   poll()                -> 'translate' | 'restore' | null   (consumes the request)
 *   collect()             -> { segments, context, total, chars }
 *   apply(table)          -> applied segment count
 *   restore()             -> restored node count
 *   status(state, label, detail)                              (idle|busy|done|error)
 *   ping()                -> true
 *   setPillPosition({x,y})                                    (host restores a dragged pill)
 *   pillPosition()        -> {x,y} | null                     (in-memory position)
 *   pollPillPosition()    -> {x,y} | null                     (consumes a drag result;
 *                                                              the renderer persists it)
 */
(function () {
  'use strict'

  var KEY = '__DSH_PT_PAGE__'
  if (window[KEY] !== undefined) return 'ready'

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1,
    CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, SVG: 1, MATH: 1, IFRAME: 1, CANVAS: 1,
    VIDEO: 1, AUDIO: 1, OBJECT: 1, EMBED: 1, TITLE: 1, META: 1, LINK: 1,
  }
  var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
  var NOISE_RE = /^(?:https?:\/\/|www\.)\S*$/i
  var ONLY_PUNCT_RE = /^[\s\d\p{P}\p{S}]+$/u

  var state = 'idle'
  var request = null
  var originals = new Map()
  var mutated = []
  var ui = null
  /** Text nodes already handled (translated or attempted), used by `follow()`. */
  var knownNodes = new WeakSet()
  /** Monotonic id source: ids must stay unique across collect() and follow(). */
  var segmentSeq = 0
  /** Set when the page mutates while translated, so `follow()` rescans once. */
  var dirty = false
  /** Watches SPA/infinite-scroll DOM updates while the page stays translated. */
  var observer = null

  /** Start watching for new page content (only while state === 'done'). */
  function startObserver() {
    if (observer !== null || typeof MutationObserver !== 'function' || !document.body) return
    observer = new MutationObserver(function (records) {
      for (var index = 0; index < records.length; index += 1) {
        var target = records[index].target
        var element = target && target.nodeType === 1 ? target : target ? target.parentElement : null
        // Our own pill/panel updates are not page content.
        if (element && element.closest && element.closest('#dsh-pt-root, #dsh-pt-compose-panel')) continue
        dirty = true
        return
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  /** Stop watching and drop the pending dirty flag. */
  function stopObserver() {
    if (observer !== null) {
      observer.disconnect()
      observer = null
    }
    dirty = false
  }

  /* --------------------------------------------------------------- utilities */

  function squash(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  }

  function isTranslatable(node) {
    var parent = node.parentElement
    if (!parent) return false
    if (SKIP_TAGS[parent.tagName] === 1) return false
    if (parent.closest && parent.closest('#dsh-pt-root, #dsh-pt-compose-panel')) return false
    if (parent.isContentEditable) return false
    if (parent.getAttribute && parent.getAttribute('aria-hidden') === 'true') return false
    var text = squash(node.nodeValue)
    if (text.length < 2) return false
    if (NOISE_RE.test(text)) return false
    if (ONLY_PUNCT_RE.test(text)) return false
    if (!/[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(text)) return false
    if (typeof parent.getClientRects === 'function' && document.body && document.body.getClientRects().length > 0) {
      if (parent.getClientRects().length === 0) return false
    }
    return true
  }

  function alreadyTarget(text) {
    var cjk = 0
    var letters = 0
    for (var index = 0; index < text.length; index += 1) {
      var char = text[index]
      if (CJK_RE.test(char)) cjk += 1
      else if (/[A-Za-z]/.test(char)) letters += 1
    }
    return cjk > 0 && cjk >= letters * 2
  }

  function collectSegments() {
    var walker = document.createTreeWalker(document.body || document.documentElement, 4)
    var byText = new Map()
    var items = []
    var node
    while ((node = walker.nextNode()) !== null) {
      if (!isTranslatable(node)) continue
      var text = squash(node.nodeValue)
      if (alreadyTarget(text)) continue
      var bucket = byText.get(text)
      if (!bucket) {
        bucket = { id: String(++segmentSeq), text: text, nodes: [] }
        byText.set(text, bucket)
        items.push(bucket)
      }
      bucket.nodes.push(node)
    }
    return items
  }

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

  function bodyText() {
    var body = document.body
    if (!body) return ''
    if (typeof body.innerText === 'string') return body.innerText
    return body.textContent || ''
  }

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
      url: location.href,
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

  /* --------------------------------------------------------------------- UI */

  var SVG_NS = 'http://www.w3.org/2000/svg'
  /** Same translate glyph the plugin used for its sidebar entry. */
  var ICON_PATHS = [
    'M4 5h9M8.5 3v2c0 4-2 7-5 9',
    'M5 9c1.5 2.4 3.6 3.9 6 4.5',
    'M13.5 21l4-10 4 10',
    'M15 17h5',
  ]

  function createIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '15')
    svg.setAttribute('height', '15')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    svg.style.flex = 'none'
    svg.style.display = 'block'
    for (var index = 0; index < ICON_PATHS.length; index += 1) {
      var path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', ICON_PATHS[index])
      svg.appendChild(path)
    }
    return svg
  }

  /** State for the reply composer (Chinese draft -> English reply). */
  var composeRequest = null
  var composeBusy = false
  var composePanel = null

  /** Toggle page translation / restore from the pill's main button. */
  function togglePage() {
    if (state === 'busy') return
    if (state === 'done') {
      request = 'restore'
      setUi('busy', '还原中…', '')
      return
    }
    request = 'translate'
    setUi('busy', '翻译中…', '')
  }

  /** Create the reply panel (above the pill) lazily. */
  function ensureComposePanel() {
    if (composePanel !== null) return composePanel
    var panel = document.createElement('div')
    panel.id = 'dsh-pt-compose-panel'
    panel.style.position = 'fixed'
    // Anchor is computed from the pill's dragged position by anchorComposePanel().
    panel.style.left = EDGE_MARGIN + 'px'
    panel.style.top = EDGE_MARGIN + 'px'
    panel.style.zIndex = '2147483647'
    panel.style.width = 'min(380px, calc(100vw - 36px))'
    panel.style.boxSizing = 'border-box'
    panel.style.background = 'rgba(17,24,39,.97)'
    panel.style.border = '1px solid rgba(255,255,255,.16)'
    panel.style.borderRadius = '12px'
    panel.style.padding = '12px 14px'
    panel.style.color = '#e5e7eb'
    panel.style.font = '400 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
    panel.style.boxShadow = '0 12px 34px rgba(0,0,0,.4)'
    panel.style.display = 'none'
    panel.style.userSelect = 'text'
    panel.style.webkitUserSelect = 'text'

    var head = document.createElement('div')
    head.style.display = 'flex'
    head.style.alignItems = 'center'
    head.style.justifyContent = 'space-between'
    head.style.gap = '8px'

    var title = document.createElement('span')
    title.textContent = '英文回复'
    title.style.color = '#a7f3d0'
    title.style.fontWeight = '600'
    title.style.fontSize = '12px'

    var actions = document.createElement('span')
    actions.style.display = 'flex'
    actions.style.alignItems = 'center'
    actions.style.gap = '6px'

    var copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = '复制'
    copy.style.height = '24px'
    copy.style.padding = '0 10px'
    copy.style.border = '0'
    copy.style.borderRadius = '6px'
    copy.style.background = '#2563eb'
    copy.style.color = '#fff'
    copy.style.font = '600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
    copy.style.cursor = 'pointer'
    pinStyle(copy, {
      'box-sizing': 'border-box',
      height: '24px',
      'min-height': '24px',
      margin: '0',
      padding: '0 10px',
      'line-height': '24px',
      border: '0',
      'border-radius': '6px',
      'font-size': '12px',
      'font-weight': '600',
    })
    copy.addEventListener('click', function (event) {
      event.stopPropagation()
      var value = body.textContent || ''
      var done = function () {
        copy.textContent = '已复制'
        setTimeout(function () { copy.textContent = '复制' }, 1200)
      }
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(value).then(done, done)
        return
      }
      var area = document.createElement('textarea')
      area.value = value
      area.style.position = 'fixed'
      area.style.opacity = '0'
      ;(document.body || document.documentElement).appendChild(area)
      area.select()
      try { document.execCommand('copy') } catch (error) { /* ignore */ }
      area.remove()
      done()
    })

    var close = document.createElement('button')
    close.type = 'button'
    close.textContent = '×'
    close.style.width = '24px'
    close.style.height = '24px'
    close.style.padding = '0'
    close.style.border = '0'
    close.style.borderRadius = '6px'
    close.style.background = 'rgba(255,255,255,.1)'
    close.style.color = '#e5e7eb'
    close.style.font = '600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
    close.style.cursor = 'pointer'
    close.addEventListener('click', function (event) {
      event.stopPropagation()
      panel.style.display = 'none'
    })
    pinStyle(close, {
      'box-sizing': 'border-box',
      width: '24px',
      height: '24px',
      'min-height': '24px',
      margin: '0',
      padding: '0',
      'line-height': '24px',
      border: '0',
      'border-radius': '6px',
      'font-size': '14px',
      'font-weight': '600',
    })

    var body = document.createElement('div')
    body.id = 'dsh-pt-compose-text'
    body.style.marginTop = '8px'
    body.style.whiteSpace = 'pre-wrap'
    body.style.wordBreak = 'break-word'
    body.style.maxHeight = '42vh'
    body.style.overflow = 'auto'
    body.style.lineHeight = '1.5'

    actions.appendChild(copy)
    actions.appendChild(close)
    head.appendChild(title)
    head.appendChild(actions)
    panel.appendChild(head)
    panel.appendChild(body)
    ;(document.body || document.documentElement).appendChild(panel)
    composePanel = { root: panel, body: body, copy: copy, title: title }
    return composePanel
  }

  /** Show compose status/result inside the panel, anchored to the pill. */
  function showCompose(text, tone) {
    var panel = ensureComposePanel()
    panel.root.style.display = 'block'
    panel.body.textContent = String(text)
    panel.body.style.color = tone === 'error' ? '#f87171' : tone === 'busy' ? '#fbbf24' : '#e5e7eb'
    panel.copy.style.display = tone === 'ok' ? '' : 'none'
    anchorComposePanel()
  }

  /** Submit the Chinese draft from the input box. */
  function submitCompose() {
    var current = ensureUi()
    var text = String(current.input.value || '').trim()
    if (text === '' || composeBusy) return
    // Programmatic values (tests / paste without input events) still grow the box.
    current.input.style.setProperty('height', 'auto', 'important')
    var grown = Math.min(96, Math.max(34, current.input.scrollHeight + 2))
    current.input.style.setProperty('height', grown + 'px', 'important')
    current.input.style.setProperty('overflow-y', current.input.scrollHeight > 96 ? 'auto' : 'hidden', 'important')
    composeBusy = true
    composeRequest = { text: text, tone: String(current.tone.value || 'natural') }
    current.send.disabled = true
    current.send.style.opacity = '0.6'
    showCompose('翻译中…', 'busy')
  }

  /**
   * Lock critical layout properties with inline `!important`: community sites
   * (Reddit etc.) often ship `textarea/select/button { ... !important }` rules
   * that would otherwise stretch our controls out of alignment.
   */
  function pinStyle(element, styles) {
    for (var name in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, name)) {
        element.style.setProperty(name, styles[name], 'important')
      }
    }
  }

  /* ------------------------------------------------------ pill position + drag */

  /** Pointer travel (px) before a press becomes a drag instead of a click. */
  var DRAG_THRESHOLD = 5
  /** Keep the pill / composer panel this far from the viewport edges. */
  var EDGE_MARGIN = 8
  /** Gap between the pill and the composer panel. */
  var PANEL_GAP = 8
  /** Renderer-provided position hint, set before this script is evaluated. */
  var POSITION_HINT_KEY = '__DSH_PT_PILL_POS__'
  /** Descendants that must keep their native pointer behaviour (no drag). */
  var NO_DRAG_SELECTOR =
    'input, textarea, select, button, option, a, label, [contenteditable="true"], #dsh-pt-compose-panel'

  /** Last dragged {x,y}; module memory lasts for this page even without a bridge. */
  var pillPosition = null
  /** Drag result waiting for the host bridge (renderer) to collect it. */
  var pendingPosition = null
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

  /** Normalise `{x,y}` / `{left,top}` (or a JSON round-trip) into a position. */
  function normalizePosition(value) {
    if (value === null || typeof value !== 'object') return null
    var x = Number(value.x != null ? value.x : value.left)
    var y = Number(value.y != null ? value.y : value.top)
    if (!isFinite(x) || !isFinite(y)) return null
    return { x: x, y: y }
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
   * Clamp a left/top pair so the box stays inside the viewport with the edge
   * margin. Pure on purpose: the tests call it directly (jsdom has no layout).
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
   * Place the composer panel next to the pill: above it when there is room,
   * otherwise below it, horizontally aligned and clamped inside the viewport.
   * @returns {{left: number, top: number, side: string}}
   */
  function computePanelPlacement(pillRect, panelWidth, panelHeight, viewportWidth, viewportHeight, margin, gap) {
    var edge = numberOr(margin, EDGE_MARGIN)
    var spacing = numberOr(gap, PANEL_GAP)
    var boxWidth = Math.max(0, numberOr(panelWidth, 0))
    var boxHeight = Math.max(0, numberOr(panelHeight, 0))
    var vw = Math.max(0, numberOr(viewportWidth, 0))
    var vh = Math.max(0, numberOr(viewportHeight, 0))
    var pillLeft = numberOr(pillRect ? pillRect.left : 0, 0)
    var pillTop = numberOr(pillRect ? pillRect.top : 0, 0)
    var pillHeight = Math.max(0, numberOr(pillRect ? pillRect.height : 0, 0))
    var above = pillTop - spacing - boxHeight
    var below = pillTop + pillHeight + spacing
    var top
    var side
    if (above >= edge) {
      top = above
      side = 'above'
    } else if (below + boxHeight <= vh - edge) {
      top = below
      side = 'below'
    } else {
      // Neither side fits (short viewport / tall panel): keep it on screen.
      top = clampValue(below, edge, Math.max(edge, vh - boxHeight - edge))
      side = 'below'
    }
    return {
      left: clampValue(pillLeft, edge, Math.max(edge, vw - boxWidth - edge)),
      top: top,
      side: side,
    }
  }

  /**
   * Bounding box of the pill. Falls back to inline left/top or the default
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

  /** Write an absolute left/top position onto the pill (right/bottom off). */
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

  /** Re-clamp the dragged pill after a viewport resize. */
  function repaintPillPosition() {
    if (pillPosition === null || ui === null) return
    applyPillPosition(ui.root, { x: pillPosition.x, y: pillPosition.y })
  }

  /** Anchor the reply panel to the pill's current box (above/below flip). */
  function anchorComposePanel() {
    if (composePanel === null || ui === null) return null
    var panel = composePanel.root
    var rect = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : null
    var view = viewportSize()
    var width = rect && numberOr(rect.width, 0) > 0 ? numberOr(rect.width, 0) : Math.min(380, Math.max(0, view.width - 2 * EDGE_MARGIN))
    var height = rect && numberOr(rect.height, 0) > 0 ? numberOr(rect.height, 0) : Math.max(0, numberOr(panel.offsetHeight, 0))
    var placement = computePanelPlacement(pillBox(), width, height, view.width, view.height, EDGE_MARGIN, PANEL_GAP)
    panel.style.left = placement.left + 'px'
    panel.style.top = placement.top + 'px'
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
    return placement
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
    anchorComposePanel()
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
    pendingPosition = pillPosition === null ? null : { x: pillPosition.x, y: pillPosition.y }
    anchorComposePanel()
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
      anchorComposePanel()
    })
  }

  function ensureUi() {
    if (ui) return ui
    var root = document.createElement('div')
    root.id = 'dsh-pt-root'
    root.setAttribute('data-state', 'idle')
    root.setAttribute('aria-label', '整页翻译 / 回复翻译')
    var style = root.style
    style.position = 'fixed'
    style.right = '18px'
    style.bottom = '18px'
    style.zIndex = '2147483647'
    style.display = 'flex'
    style.alignItems = 'center'
    style.gap = '8px'
    style.maxWidth = 'calc(100vw - 36px)'
    style.font = '600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
    style.color = '#fff'
    style.background = 'rgba(17,24,39,.94)'
    style.border = '1px solid rgba(255,255,255,.14)'
    style.borderRadius = '999px'
    style.padding = '8px 12px'
    style.boxShadow = '0 8px 26px rgba(0,0,0,.28)'
    style.touchAction = 'none'
    pinStyle(root, {
      'box-sizing': 'border-box',
      display: 'flex',
      'align-items': 'center',
      gap: '8px',
      padding: '8px 12px',
      margin: '0',
      'line-height': '1.2',
      'font-family': '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
      'font-size': '14px',
      'touch-action': 'none',
    })

    var toggle = document.createElement('span')
    toggle.style.display = 'flex'
    toggle.style.alignItems = 'center'
    toggle.style.gap = '8px'
    toggle.style.flex = 'none'
    toggle.style.cursor = 'pointer'
    toggle.style.userSelect = 'none'
    toggle.style.webkitUserSelect = 'none'
    toggle.style.height = '34px'

    var icon = createIcon()

    var label = document.createElement('span')
    label.id = 'dsh-pt-label'
    label.style.whiteSpace = 'nowrap'
    label.style.minWidth = '72px'
    label.style.textAlign = 'center'
    label.style.fontSize = '13px'
    label.textContent = '译'

    toggle.appendChild(icon)
    toggle.appendChild(label)
    pinStyle(toggle, {
      display: 'flex',
      'align-items': 'center',
      gap: '8px',
      height: '34px',
      flex: 'none',
    })
    pinStyle(label, {
      display: 'inline-flex',
      'align-items': 'center',
      height: '34px',
      'line-height': '34px',
      'font-size': '13px',
      'font-weight': '600',
      'white-space': 'nowrap',
      'min-width': '72px',
      'text-align': 'center',
    })
    root.appendChild(toggle)

    /** Auto-growing textarea: one row until the draft needs more. */
    var input = document.createElement('textarea')
    input.id = 'dsh-pt-compose-input'
    input.rows = 1
    input.placeholder = '中文 → English'
    input.setAttribute('aria-label', '中文回复译成英文')
    input.spellcheck = false
    input.style.boxSizing = 'border-box'
    input.style.height = '34px'
    input.style.width = 'clamp(300px, 34vw, 560px)'
    input.style.flex = '1 1 auto'
    input.style.minWidth = '300px'
    input.style.maxWidth = '560px'
    input.style.padding = '6px 12px'
    input.style.border = '1px solid rgba(255,255,255,.18)'
    input.style.borderRadius = '17px'
    input.style.background = 'rgba(255,255,255,.08)'
    input.style.color = '#fff'
    input.style.font = '400 13px/20px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
    input.style.outline = 'none'
    input.style.resize = 'none'
    input.style.overflow = 'auto'
    input.style.maxHeight = '96px'
    input.style.userSelect = 'text'
    input.style.webkitUserSelect = 'text'
    input.addEventListener('click', function (event) { event.stopPropagation() })
    function growComposeInput() {
      input.style.setProperty('height', 'auto', 'important')
      var next = Math.min(96, Math.max(34, input.scrollHeight + 2))
      input.style.setProperty('height', next + 'px', 'important')
      input.style.setProperty('overflow-y', input.scrollHeight > 96 ? 'auto' : 'hidden', 'important')
    }
    pinStyle(input, {
      'box-sizing': 'border-box',
      height: '34px',
      'min-height': '34px',
      'max-height': '96px',
      margin: '0',
      padding: '6px 12px',
      'line-height': '20px',
      'font-family': '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
      'font-size': '13px',
      'font-weight': '400',
      color: '#fff',
      background: 'rgba(255,255,255,.08)',
      border: '1px solid rgba(255,255,255,.18)',
      'border-radius': '17px',
      outline: 'none',
      resize: 'none',
      width: 'clamp(300px, 34vw, 560px)',
      'min-width': '300px',
      'max-width': '560px',
      'vertical-align': 'middle',
    })
    input.addEventListener('input', growComposeInput)
    input.addEventListener('keydown', function (event) {
      event.stopPropagation()
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submitCompose()
      }
    })

    var send = document.createElement('button')
    send.id = 'dsh-pt-compose-send'
    send.type = 'button'
    send.textContent = '→EN'
    send.title = '把输入框里的中文译成英文'
    send.style.flex = 'none'
    send.style.boxSizing = 'border-box'
    send.style.height = '34px'
    send.style.padding = '0 14px'
    send.style.border = '0'
    send.style.borderRadius = '17px'
    send.style.background = '#2563eb'
    send.style.color = '#fff'
    send.style.font = '600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
    send.style.cursor = 'pointer'
    send.addEventListener('click', function (event) {
      event.stopPropagation()
      submitCompose()
    })
    pinStyle(send, {
      'box-sizing': 'border-box',
      height: '34px',
      'min-height': '34px',
      margin: '0',
      padding: '0 14px',
      'line-height': '32px',
      'font-family': '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
      'font-size': '12px',
      'font-weight': '600',
      color: '#fff',
      background: '#2563eb',
      border: '0',
      'border-radius': '17px',
      cursor: 'pointer',
      flex: 'none',
      'vertical-align': 'middle',
    })

    var tone = document.createElement('select')
    tone.id = 'dsh-pt-compose-tone'
    tone.title = '回复语气'
    tone.setAttribute('aria-label', '回复语气')
    tone.style.boxSizing = 'border-box'
    tone.style.height = '34px'
    tone.style.flex = 'none'
    tone.style.padding = '0 8px'
    tone.style.border = '1px solid rgba(255,255,255,.18)'
    tone.style.borderRadius = '17px'
    tone.style.background = 'rgba(255,255,255,.08)'
    tone.style.color = '#fff'
    tone.style.font = '400 12px/32px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'
    tone.style.outline = 'none'
    tone.style.cursor = 'pointer'
    var toneOptions = [
      ['natural', '自然'],
      ['casual', '口语'],
      ['humorous', '幽默'],
      ['technical', '专业'],
    ]
    for (var toneIndex = 0; toneIndex < toneOptions.length; toneIndex += 1) {
      var option = document.createElement('option')
      option.value = toneOptions[toneIndex][0]
      option.textContent = toneOptions[toneIndex][1]
      option.style.color = '#111827'
      tone.appendChild(option)
    }
    tone.addEventListener('click', function (event) { event.stopPropagation() })
    tone.addEventListener('keydown', function (event) { event.stopPropagation() })
    pinStyle(tone, {
      'box-sizing': 'border-box',
      height: '34px',
      'min-height': '34px',
      margin: '0',
      padding: '0 8px',
      'line-height': '32px',
      'font-family': '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
      'font-size': '12px',
      'font-weight': '400',
      color: '#fff',
      background: 'rgba(255,255,255,.08)',
      border: '1px solid rgba(255,255,255,.18)',
      'border-radius': '17px',
      outline: 'none',
      cursor: 'pointer',
      flex: 'none',
      'vertical-align': 'middle',
    })

    root.appendChild(tone)
    root.appendChild(input)
    root.appendChild(send)
    root.addEventListener('click', function (event) {
      // The click synthesized after a drag must not toggle translation.
      if (suppressClick) {
        suppressClick = false
        event.preventDefault()
        event.stopPropagation()
        return
      }
      var target = event.target
      if (target !== null && typeof target.closest === 'function' && target.closest('#dsh-pt-compose-input, #dsh-pt-compose-send, #dsh-pt-compose-tone, #dsh-pt-compose-panel')) return
      event.preventDefault()
      event.stopPropagation()
      togglePage()
    })
    root.addEventListener('keydown', function (event) {
      var target = event.target
      if (target !== null && typeof target.closest === 'function' && target.closest('#dsh-pt-compose-input, #dsh-pt-compose-send, #dsh-pt-compose-tone')) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        togglePage()
      }
    })
    ;(document.body || document.documentElement).appendChild(root)
    ui = { root: root, label: label, input: input, send: send, tone: tone }
    bindPillDrag(root)
    bindViewportResize()
    // The renderer may hand back the last dragged position before injecting us.
    var restored = normalizePosition(window[POSITION_HINT_KEY])
    if (restored !== null) applyPillPosition(root, restored)
    return ui
  }

  function setUi(next, label, detail) {
    state = next
    var current = ensureUi()
    current.root.setAttribute('data-state', next)
    current.label.textContent = label
    if (next === 'done') startObserver()
    else if (next === 'idle' || next === 'error') stopObserver()
    current.root.setAttribute('title',
      next === 'done' ? '再点一次还原原文' : '整页翻译：结合页面主题替换原文；再点一次还原',
    )
  }

  /* --------------------------------------------------------------- controller */

  var api = {
    version: 1,
    poll: function () {
      var value = request
      request = null
      return value
    },
    collect: function () {
      var items = collectSegments()
      knownNodes = new WeakSet()
      for (var known = 0; known < items.length; known += 1) {
        for (var knownNode = 0; knownNode < items[known].nodes.length; knownNode += 1) {
          knownNodes.add(items[known].nodes[knownNode])
        }
      }
      var chars = 0
      var segments = []
      for (var index = 0; index < items.length; index += 1) {
        chars += items[index].text.length
        segments.push({ id: items[index].id, text: items[index].text })
      }
      window.__DSH_PT_ITEMS__ = items
      return { segments: segments, context: extractPageContext(), total: items.length, chars: chars }
    },
    /** Page context only; unlike collect() it never touches the translation item list. */
    pageContext: function () {
      return { context: extractPageContext() }
    },
    /**
     * Return text nodes that appeared after the page was translated
     * (infinite scroll / SPA navigation / expanded comments), appending them to
     * the stored item list so apply() can paint them.
     */
    follow: function () {
      if (state !== 'done' || !dirty) return null
      dirty = false
      var scanned = collectSegments()
      var fresh = []
      for (var index = 0; index < scanned.length; index += 1) {
        var item = scanned[index]
        var unknown = []
        for (var nodeIndex = 0; nodeIndex < item.nodes.length; nodeIndex += 1) {
          if (knownNodes.has(item.nodes[nodeIndex])) continue
          knownNodes.add(item.nodes[nodeIndex])
          unknown.push(item.nodes[nodeIndex])
        }
        if (unknown.length > 0) fresh.push({ id: item.id, text: item.text, nodes: unknown })
      }
      if (fresh.length === 0) return null
      var stored = window.__DSH_PT_ITEMS__ || []
      var segments = []
      var chars = 0
      for (var added = 0; added < fresh.length; added += 1) {
        stored.push(fresh[added])
        segments.push({ id: fresh[added].id, text: fresh[added].text })
        chars += fresh[added].text.length
      }
      window.__DSH_PT_ITEMS__ = stored
      return { segments: segments, context: extractPageContext(), total: fresh.length, chars: chars }
    },
    progress: function (label) {
      var current = ensureUi()
      current.label.textContent = String(label)
      return true
    },
    apply: function (table) {
      var items = window.__DSH_PT_ITEMS__ || []
      return applyTranslations(items, table || {})
    },
    restore: function () {
      var restored = restoreTranslations()
      window.__DSH_PT_ITEMS__ = []
      knownNodes = new WeakSet()
      stopObserver()
      return restored
    },
    status: function (next, label, detail) {
      setUi(String(next), String(label), detail === undefined ? '' : String(detail))
      return true
    },
    /** Consume a pending reply-composer request; returns `{ text, tone }`. */
    pollCompose: function () {
      var value = composeRequest
      composeRequest = null
      return value
    },
    /** Show the translated reply in the panel. */
    composeResult: function (text) {
      composeBusy = false
      var current = ensureUi()
      current.send.disabled = false
      current.send.style.opacity = '1'
      showCompose(String(text), 'ok')
      return true
    },
    /** Show a compose failure in the panel. */
    composeError: function (message) {
      composeBusy = false
      var current = ensureUi()
      current.send.disabled = false
      current.send.style.opacity = '1'
      showCompose('翻译失败：' + String(message), 'error')
      return true
    },
    ping: function () {
      return true
    },
    /** Restore a position handed back by the renderer (bridge channel). */
    setPillPosition: function (position) {
      var normal = normalizePosition(position)
      if (normal === null) return false
      var current = ensureUi()
      applyPillPosition(current.root, normal)
      anchorComposePanel()
      return true
    },
    /** Current in-memory pill position, `null` while still in the default corner. */
    pillPosition: function () {
      return pillPosition === null ? null : { x: pillPosition.x, y: pillPosition.y }
    },
    /** Consume a drag result so the renderer can persist it. */
    pollPillPosition: function () {
      var value = pendingPosition
      pendingPosition = null
      return value
    },
  }
  window[KEY] = api
  try {
    window.__DSH_PT_TEST_HOSTED__ = {
      clampPillPosition: clampPillPosition,
      computePanelPlacement: computePanelPlacement,
      normalizePosition: normalizePosition,
      dragThreshold: DRAG_THRESHOLD,
      edgeMargin: EDGE_MARGIN,
    }
  } catch (error) {
    // a hostile page may freeze window; dragging still works
  }
  try {
    ensureUi()
  } catch (error) {
    return 'button-failed: ' + String(error)
  }
  return 'installed'
})()
