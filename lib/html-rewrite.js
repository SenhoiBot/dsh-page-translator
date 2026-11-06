/**
 * HTML rewrite for the loopback proxy.
 *
 * The proxy serves a fetched page under `http://127.0.0.1:<port>/p?url=...` so the
 * in-page translation script runs same-origin with the proxy API. Rewriting is
 * deliberately conservative:
 *
 *  - keep the page's own structure, stylesheets and images (layout must survive),
 *  - insert a `<base>` so relative URLs still resolve to the original site,
 *  - remove `<script>` elements and CSP/meta-refresh so our injected script owns
 *    the document and cannot be blocked by the page's policy,
 *  - inject one boot object + the translation script.
 *
 * Everything else (including inline styles, SVG, tables) is handed through as-is.
 */

/** Attributes that can break a rewritten page and are safe to drop. */
const INTEGRITY_ATTR = /\s+integrity\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi

/**
 * Escape a string for an HTML attribute value.
 * @param {string} value
 * @returns {string}
 */
export function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Strip tags but keep text, used for the context sample.
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract page metadata for the context stage from raw HTML. The in-page script
 * recomputes this from the live DOM; this server-side pass is the fallback used by
 * `/p` so the page can render a topic badge even before any client work.
 * @param {string} html
 * @param {string} finalUrl
 * @returns {{title: string, lang: string, meta: {description: string, siteName: string, ogType: string, keywords: string}, headings: string[], sample: string}}
 */
export function extractPageMeta(html, finalUrl) {
  const source = String(html ?? '')
  const title = matchFirst(source, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? ''
  const lang = matchFirst(source, /<html[^>]*\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) ?? ''
  const metaTag = (name) =>
    matchFirst(source, new RegExp(`<meta\\b[^>]*(?:name|property)\\s*=\\s*["']?${name}["']?[^>]*>`, 'i'))
  const metaContent = (name) => {
    const tag = metaTag(name)
    if (tag === null) return ''
    return matchFirst(tag, /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) ?? ''
  }
  const headings = []
  const headingRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi
  let headingMatch
  while ((headingMatch = headingRe.exec(source)) !== null && headings.length < 18) {
    const text = htmlToText(headingMatch[2]).replace(/\s+/g, ' ').trim()
    if (text !== '' && !headings.includes(text)) headings.push(text)
  }
  const body = matchFirst(source, /<body[^>]*>([\s\S]*)<\/body>/i) ?? source
  const sample = htmlToText(body).slice(0, 1800)
  return {
    title: htmlToText(title),
    lang: htmlToText(lang),
    meta: {
      description: metaContent('description'),
      siteName: metaContent('og:site_name'),
      ogType: metaContent('og:type'),
      keywords: metaContent('keywords'),
    },
    headings,
    sample,
    url: finalUrl,
  }
}

/**
 * First capture group of a match, or null.
 * @param {string} text
 * @param {RegExp} re
 * @returns {string | null}
 */
function matchFirst(text, re) {
  const match = re.exec(text)
  if (match === null) return null
  if (match.length === 1) return match[0]
  for (let index = 1; index < match.length; index += 1) {
    if (typeof match[index] === 'string' && match[index] !== '') return match[index]
  }
  return null
}

/**
 * Rewrite a fetched HTML document for same-origin proxying.
 * @param {string} html - raw page HTML.
 * @param {object} options
 * @param {string} options.finalUrl - URL after redirects; used as `<base>`.
 * @param {string} options.token - per-process API token handed to the page script.
 * @param {string} options.target - target language tag.
 * @param {string} [options.assetOrigin] - proxy origin, so the injected script is
 *   requested from the proxy rather than the target page (the injected `<base>`
 *   would otherwise resolve `/pt.js` against the original site).
 * @param {boolean} [options.autoOpen] - whether the page should translate on load.
 * @param {number} [options.maxChars] - client-side translation budget.
 * @returns {string} rewritten HTML.
 */
export function rewriteHtml(html, options) {
  const finalUrl = String(options?.finalUrl ?? '')
  const token = String(options?.token ?? '')
  const target = String(options?.target ?? 'zh')
  const assetOrigin = String(options?.assetOrigin ?? '').replace(/\/$/, '')
  let out = String(html ?? '')

  // Drop a document-level script policy and refresh, then scripts themselves:
  // the page runs no author JavaScript from here on.
  out = out.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
  out = out.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '')
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  out = out.replace(/<script\b[^>]*\/>/gi, '')
  out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
  out = out.replace(INTEGRITY_ATTR, '')

  // A single base element after <head>; earlier ones would win, so drop them.
  out = out.replace(/<base\b[^>]*>/gi, '')
  const base = `<base href="${escapeAttr(finalUrl)}">`
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (match) => match + base)
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (match) => match + base)
  else out = base + out

  const boot = {
    token,
    proxyOrigin: assetOrigin,
    pageUrl: finalUrl,
    target,
    autoOpen: options?.autoOpen === true,
    maxChars: Number.isFinite(options?.maxChars) ? options.maxChars : 0,
  }
  const injection =
    `<style id="dsh-pt-style">${INLINE_CSS}</style>` +
    `<script id="dsh-pt-boot">window.__DSH_PT_BOOT__=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>` +
    `<script id="dsh-pt-script" src="${escapeAttr(assetOrigin !== '' ? `${assetOrigin}/pt.js` : '/pt.js')}"></script>`

  if (/<\/body>\s*<\/html>\s*$/i.test(out)) {
    out = out.replace(/<\/body>(\s*)<\/html>\s*$/i, `${injection}</body>$1</html>`)
  } else if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${injection}</body>`)
  } else {
    out += injection
  }
  return out
}

/** Minimal style for the injected toolbar; the page's own CSS must not reach it. */
const INLINE_CSS = [
  '#dsh-pt-root{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;align-items:center;gap:8px;',
  'font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#fff;',
  'background:rgba(17,24,39,.92);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:9px 14px;',
  'box-shadow:0 8px 26px rgba(0,0,0,.28);user-select:none;-webkit-user-select:none;backdrop-filter:blur(6px);cursor:pointer;',
  'animation:dsh-pt-glow 1.4s ease-in-out 2}',
  '@keyframes dsh-pt-glow{0%,100%{box-shadow:0 8px 26px rgba(0,0,0,.28)}50%{box-shadow:0 0 0 4px rgba(52,211,153,.5),0 8px 26px rgba(0,0,0,.28)}}',
  '#dsh-pt-root:hover{background:rgba(17,24,39,.99);animation:none}',
  '#dsh-pt-root[data-state="busy"]{cursor:progress}',
  '#dsh-pt-root[data-state="error"]{border-color:rgba(248,113,113,.65)}',
  '#dsh-pt-dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.16)}',
  '#dsh-pt-root[data-state="busy"] #dsh-pt-dot{background:#fbbf24;box-shadow:0 0 0 3px rgba(251,191,36,.18);animation:dsh-pt-pulse 1s ease-in-out infinite}',
  '#dsh-pt-root[data-state="error"] #dsh-pt-dot{background:#f87171;box-shadow:0 0 0 3px rgba(248,113,113,.18)}',
  '#dsh-pt-label{white-space:nowrap;font-variant-numeric:tabular-nums}',
  '#dsh-pt-topic{max-width:44vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a7f3d0;font-weight:400;font-size:12px}',
  '@keyframes dsh-pt-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
  '@media (prefers-reduced-motion:reduce){#dsh-pt-dot,#dsh-pt-root{animation:none!important}}',
].join('')
