/**
 * Edge 扩展内容脚本：把页面里的「译」按钮请求翻译成对后台的调用。
 *
 * `page-script-hosted.js` 已在同一隔离世界注入控制器（window.__DSH_PT_PAGE__），
 * 负责找文本节点、原地替换与还原；本脚本只负责轮询按钮状态、分块请求后台、
 * 把译文回填，以及把进度写回按钮。
 *
 * 所有网络请求都经 background service worker 发往本机 DSH 的扩展桥
 * （`/ext/context`、`/ext/translate`），内容脚本自身不直连网络。
 */
;(() => {
  'use strict'
  if (window.__DSH_PT_EDGE__ === true) return
  window.__DSH_PT_EDGE__ = true

  /** 轮询按钮请求的间隔。 */
  const POLL_MS = 300
  /** 分块大小与并发：与 DSH 内置浏览器模式一致（小分块并行更快）。 */
  const CHUNK_CHARS = 700
  const CHUNK_ITEMS = 14
  const CONCURRENCY = 8
  /** 扩展本地存储键：拖动后的「译」控件位置（同一扩展跨页面记住）。 */
  const POSITION_KEY = 'dshPtPillPosition'

  let busy = false

  /** 从扩展本地存储恢复「译」控件位置（内容脚本 → 扩展 storage，不写页面存储）。 */
  function restorePillPosition(controller) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return
      chrome.storage.local.get({ [POSITION_KEY]: null }, (data) => {
        const position = data ? data[POSITION_KEY] : null
        if (position && controller && typeof controller.setPillPosition === 'function') {
          controller.setPillPosition(position)
        }
      })
    } catch {
      // storage 不可用时退化为本页内存记忆
    }
  }

  /** 保存拖动后的位置到扩展本地存储。 */
  function savePillPosition(position) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return
      chrome.storage.local.set({ [POSITION_KEY]: { x: Number(position.x), y: Number(position.y) } })
    } catch {
      // ignore: the guest keeps the position in memory
    }
  }

  /** 向 service worker 发一条消息并等待结果。 */
  function call(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError
          if (error) reject(new Error(error.message))
          else resolve(response)
        })
      } catch (error) {
        reject(new Error(String((error && error.message) || error)))
      }
    })
  }

  /** 读取扩展设置（桥地址、目标语言、可选 token）。 */
  async function readSettings() {
    try {
      const response = await call({ type: 'settings' })
      if (response && response.ok && response.settings) return response.settings
    } catch {
      // fall through to defaults
    }
    return { bridgeUrl: 'http://127.0.0.1:34118', token: '', target: 'zh' }
  }

  /** 把一组 segments 切成若干块。 */
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

  /** 取扩展桥的页面主题上下文；失败不阻塞翻译。 */
  async function fetchContext(controller) {
    try {
      const info = typeof controller.pageContext === 'function' ? controller.pageContext() : controller.collect()
      const context = info && info.context ? info.context : null
      if (!context) return null
      const response = await call({ type: 'context', payload: context })
      if (response && response.ok && response.data && response.data.context) return response.data.context
    } catch {
      // ignore: translation proceeds without glossary
    }
    return null
  }

  /** 翻译当前页面并原地回填。 */
  async function translatePage(controller) {
    const settings = await readSettings()
    const target = settings.target || 'zh'
    const info = controller.collect()
    const segments = info && Array.isArray(info.segments) ? info.segments : []
    if (segments.length === 0) {
      controller.status('done', '无需翻译', '没有找到需要翻译的正文')
      return
    }
    const chunks = chunkSegments(segments)
    controller.status('busy', '翻译中 0%', '')
    const context = await fetchContext(controller)
    const pageUrl = String((info.context && info.context.url) || location.href)
    let done = 0
    let applied = 0
    let lastError = ''
    let cursor = 0
    const workers = []
    for (let index = 0; index < Math.min(CONCURRENCY, chunks.length); index += 1) {
      workers.push(
        (async () => {
          while (cursor < chunks.length) {
            const chunk = chunks[cursor]
            cursor += 1
            try {
              const response = await call({
                type: 'translateChunk',
                payload: { url: pageUrl, target, context, segments: chunk },
              })
              if (!response || response.ok !== true) throw new Error((response && response.error) || '后台请求失败')
              const table = (response.data && response.data.translations) || {}
              applied += Number(controller.apply(table)) || 0
            } catch (error) {
              lastError = String((error && error.message) || error).slice(0, 120)
            }
            done += 1
            controller.status('busy', '翻译中 ' + Math.round((done / chunks.length) * 100) + '%', '')
          }
        })(),
      )
    }
    await Promise.all(workers)
    if (applied === 0) {
      controller.status('error', '翻译失败', lastError || '没有拿到可用译文')
      return
    }
    controller.status('done', '已译 100%', '')
  }

  /** 还原页面原文。 */
  function restorePage(controller) {
    controller.restore()
    controller.status('idle', '译', '')
  }

  /** 翻译页面在翻译完成后新出现的内容（Reddit SPA 翻页、无限滚动、展开评论）。 */
  async function followUpdates(controller) {
    if (typeof controller.follow !== 'function') return
    let info = null
    try {
      info = controller.follow()
    } catch {
      return
    }
    if (info === null || typeof info !== 'object' || !Array.isArray(info.segments) || info.segments.length === 0) return
    const settings = await readSettings()
    const target = settings.target || 'zh'
    const chunks = chunkSegments(info.segments)
    const context = await fetchContext(controller)
    const pageUrl = String((info.context && info.context.url) || location.href)
    if (typeof controller.progress === 'function') controller.progress('更新中 0%')
    let done = 0
    let applied = 0
    let cursor = 0
    const workers = []
    for (let index = 0; index < Math.min(CONCURRENCY, chunks.length); index += 1) {
      workers.push(
        (async () => {
          while (cursor < chunks.length) {
            const chunk = chunks[cursor]
            cursor += 1
            try {
              const response = await call({
                type: 'translateChunk',
                payload: { url: pageUrl, target, context, segments: chunk },
              })
              if (response && response.ok === true) {
                applied += Number(controller.apply((response.data && response.data.translations) || {})) || 0
              }
            } catch {
              // keep originals for this chunk
            }
            done += 1
            if (typeof controller.progress === 'function') {
              controller.progress('更新中 ' + Math.round((done / chunks.length) * 100) + '%')
            }
          }
        })(),
      )
    }
    await Promise.all(workers)
    if (applied > 0) controller.status('done', '已译 100%', '')
  }

  /** 把输入框里的中文草稿译成英文回复（带页面主题与语气）。 */
  async function composeReply(controller, draft) {
    try {
      const text = String(draft && draft.text ? draft.text : '')
      const tone = String(draft && draft.tone ? draft.tone : 'natural')
      const info = controller.collect()
      const context = info && info.context ? info.context : {}
      const pageUrl = String((context && context.url) || location.href)
      const response = await call({
        type: 'compose',
        payload: { text, context, url: pageUrl, title: String(context.title ?? ''), target: 'en', tone },
      })
      if (!response || response.ok !== true) throw new Error((response && response.error) || '后台请求失败')
      controller.composeResult(String((response.data && response.data.text) || ''))
    } catch (error) {
      controller.composeError(String((error && error.message) || error).slice(0, 160))
    }
  }

  /** 轮询「译」按钮与回复输入框的请求。 */
  function startPolling() {
    let polling = false
    setInterval(async () => {
      const controller = window.__DSH_PT_PAGE__
      if (!controller || busy || polling) return
      polling = true
      try {
        // 拖动后的位置：经扩展 storage 持久化（跨页面记住）。
        const moved = typeof controller.pollPillPosition === 'function' ? controller.pollPillPosition() : null
        if (moved !== null && typeof moved === 'object') {
          savePillPosition(moved)
        }
        const draft = typeof controller.pollCompose === 'function' ? controller.pollCompose() : null
        if (draft !== null && typeof draft === 'object' && typeof draft.text === 'string' && draft.text !== '') {
          await composeReply(controller, draft)
        }
        let action = null
        try {
          action = controller.poll()
        } catch {
          return
        }
        if (action === 'translate' || action === 'restore') {
          busy = true
          try {
            if (action === 'translate') await translatePage(controller)
            else restorePage(controller)
          } catch (error) {
            try {
              controller.status('error', '翻译失败', String((error && error.message) || error).slice(0, 120))
            } catch {
              // page may be gone
            }
          } finally {
            busy = false
          }
          return
        }
        // 翻译完成后跟随 Reddit 等 SPA 的新内容 / 无限滚动。
        busy = true
        try {
          await followUpdates(controller)
        } finally {
          busy = false
        }
      } finally {
        polling = false
      }
    }, POLL_MS)
  }

  // 先恢复上次拖动的位置，再开始轮询按钮请求。
  if (window.__DSH_PT_PAGE__) restorePillPosition(window.__DSH_PT_PAGE__)
  startPolling()
})()
