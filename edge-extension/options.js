/** 设置页逻辑：读写 chrome.storage.sync，可选申请自定义桥地址权限，测试连接。 */

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:34118',
  token: '',
  target: 'zh',
}

const bridgeInput = document.getElementById('bridgeUrl')
const targetSelect = document.getElementById('target')
const tokenInput = document.getElementById('token')
const status = document.getElementById('status')

/** 显示状态行。 */
function showStatus(text, tone) {
  status.textContent = text
  status.dataset.tone = tone || ''
}

/** 读到表单里的桥地址；非法时抛出。 */
function readBridgeUrl() {
  const raw = bridgeInput.value.trim()
  if (raw === '') throw new Error('请填写 DSH 扩展桥地址')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('地址格式不正确，例如 http://127.0.0.1:34118')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https 地址')
  return url.origin
}

/** 是否为回环地址（回环不需要额外权限，已在 manifest 声明）。 */
function isLoopback(origin) {
  const url = new URL(origin)
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
}

/** 对非回环桥地址申请可选 host 权限。 */
async function ensurePermission(origin) {
  if (isLoopback(origin)) return true
  const granted = await chrome.permissions.request({ origins: [origin + '/*'] })
  return granted === true
}

/** 载入已保存设置。 */
function load() {
  chrome.storage.sync.get(DEFAULTS, (settings) => {
    bridgeInput.value = settings.bridgeUrl || DEFAULTS.bridgeUrl
    tokenInput.value = settings.token || ''
    targetSelect.value = settings.target || DEFAULTS.target
  })
}

/** 保存设置（非回环地址先申请权限）。 */
async function save() {
  try {
    const origin = readBridgeUrl()
    if (!(await ensurePermission(origin))) {
      showStatus('未授予访问该地址的权限，无法保存。', 'error')
      return
    }
    const settings = {
      bridgeUrl: origin,
      token: tokenInput.value.trim(),
      target: targetSelect.value,
    }
    await new Promise((resolve, reject) => {
      chrome.storage.sync.set(settings, () => {
        const error = chrome.runtime.lastError
        if (error) reject(new Error(error.message))
        else resolve()
      })
    })
    showStatus('已保存。', 'ok')
  } catch (error) {
    showStatus(String((error && error.message) || error), 'error')
  }
}

/** 通过 service worker 测试桥连接。 */
function test() {
  showStatus('正在测试…')
  chrome.runtime.sendMessage({ type: 'ping' }, (response) => {
    const error = chrome.runtime.lastError
    if (error) {
      showStatus('扩展后台无响应：' + error.message, 'error')
      return
    }
    if (response && response.ok) {
      const health = response.health || {}
      showStatus('连接成功：DSH 扩展桥 v' + (health.version || '?') + '（目标语言 ' + (health.target || 'zh') + '）', 'ok')
    } else {
      showStatus('连接失败：' + ((response && response.error) || '未知错误') + '\n请确认 DSH 正在运行，且地址/端口与插件配置一致。', 'error')
    }
  })
}

document.getElementById('save').addEventListener('click', save)
document.getElementById('test').addEventListener('click', test)
load()
