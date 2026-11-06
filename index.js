/**
 * Host entry of the in-page translator.
 *
 * Loads in the desktop/web profile as a bundle row. It needs the host `llm`
 * service (for translation) and, when present, the web server (for the client
 * discovery route). Everything user-visible happens in the loopback proxy page
 * served by `lib/server.js`.
 */
import { PageTranslator } from './lib/service.js'

export const name = 'dsh-page-translator'
export const inject = ['llm']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - patch row config (port/provider/model/...).
 * @returns {void}
 */
export function apply(ctx, config) {
  const logger = resolveLogger(ctx)
  const translator = new PageTranslator({ ctx, config, logger })

  ctx.effect(() => {
    let disposed = false
    const started = translator.start().catch((error) => {
      logger.error?.('page translator: start failed: %s', String(error))
    })
    return async () => {
      disposed = true
      await started
      if (disposed) await translator.stop()
    }
  }, 'page translator: loopback service')
}

/**
 * Resolve a logger that works with both the Cordis logger factory and a plain
 * logger object (tests inject the latter).
 * @param {object} ctx
 * @returns {object}
 */
function resolveLogger(ctx) {
  try {
    if (typeof ctx?.logger === 'function') return ctx.logger('page-translator')
    if (ctx?.logger !== undefined && ctx.logger !== null) return ctx.logger
    if (typeof ctx?.get === 'function') {
      const service = ctx.get('logger')
      if (service !== undefined && service !== null) return service
    }
  } catch {
    // fall through to console
  }
  return console
}
