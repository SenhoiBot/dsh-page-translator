/**
 * Edge 扩展 service worker：把内容脚本的请求转发到本机 DSH 的扩展桥。
 *
 * 为什么网络请求放在这里而不是内容脚本里：内容脚本受页面 CORS 限制，
 * 而 MV3 扩展的 service worker 在声明 host_permissions 后可以直连
 * http://127.0.0.1:<port>，不需要后端加 CORS 头（普通网页因此仍读不到）。
 */

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:34118',
  token: '',
  target: 'zh',
}

/** 读取扩展设置（chrome.storage.sync）。 */
function readSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (settings) => resolve({ ...DEFAULTS, ...settings }))
  })
}

/** 去掉末尾斜杠的桥地址。 */
function bridgeRoot(settings) {
  return String(settings.bridgeUrl || DEFAULTS.bridgeUrl).replace(/\/+$/, '')
}

/** POST 到扩展桥，并把非 2xx/非 ok 转成异常。 */
async function postBridge(path, payload) {
  const settings = await readSettings()
  const headers = { 'content-type': 'application/json' }
  if (settings.token) headers['x-pt-ext-token'] = settings.token
  const response = await fetch(bridgeRoot(settings) + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload ?? {}),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || data === null || data.ok !== true) {
    throw new Error((data && data.message) || 'HTTP ' + response.status)
  }
  return data
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ;(async () => {
    try {
      if (message === null || typeof message !== 'object') {
        sendResponse({ ok: false, error: '无效消息' })
        return
      }
      switch (message.type) {
        case 'settings': {
          sendResponse({ ok: true, settings: await readSettings() })
          return
        }
        case 'context': {
          const data = await postBridge('/ext/context', message.payload)
          sendResponse({ ok: true, data })
          return
        }
        case 'translateChunk': {
          const data = await postBridge('/ext/translate', message.payload)
          sendResponse({ ok: true, data })
          return
        }
        case 'compose': {
          const data = await postBridge('/ext/compose', message.payload)
          sendResponse({ ok: true, data })
          return
        }
        case 'ping': {
          const settings = await readSettings()
          const response = await fetch(bridgeRoot(settings) + '/ext/health')
          const health = await response.json().catch(() => null)
          sendResponse({
            ok: response.ok && health !== null && health.ok === true,
            health,
            error: response.ok ? '' : 'HTTP ' + response.status,
          })
          return
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型' })
      }
    } catch (error) {
      sendResponse({ ok: false, error: String((error && error.message) || error) })
    }
  })()
  // 保持消息通道，等待上面的异步 sendResponse。
  return true
})
