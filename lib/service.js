/**
 * Host service lifecycle for the in-page translator.
 *
 * Owns:
 *  - the LLM bridge (host `llm` service, no API key),
 *  - the loopback proxy server (page rewrite + translation API),
 *  - optional discovery routes on the DSH web server so the client panel can learn
 *    the proxy origin on this machine,
 *  - a small state file under the DSH home for debugging (`~/.dsh/page-translator.json`).
 */

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmTranslator } from './llm.js'
import { createTranslatorServer } from './server.js'
import { createBrowserBridge } from './browser-bridge.js'

/** Plugin-local state file name. */
const STATE_FILE = 'page-translator.json'

/**
 * Normalize raw config from the profile patch.
 * @param {object} [raw]
 * @returns {object}
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const port = Number(config.port)
  return {
    host: typeof config.host === 'string' && config.host !== '' ? config.host : '127.0.0.1',
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0,
    target: typeof config.target === 'string' && config.target !== '' ? config.target : 'zh',
    provider: typeof config.provider === 'string' ? config.provider : '',
    model: typeof config.model === 'string' ? config.model : '',
    callTimeoutMs: Number.isFinite(config.callTimeoutMs) ? config.callTimeoutMs : 25_000,
    fetchTimeoutMs: Number.isFinite(config.fetchTimeoutMs) ? config.fetchTimeoutMs : 20_000,
    maxPageBytes: Number.isFinite(config.maxPageBytes) ? config.maxPageBytes : 5 * 1024 * 1024,
    maxChars: Number.isFinite(config.maxChars) ? config.maxChars : 0,
    llmConcurrency: Number.isFinite(config.llmConcurrency) ? config.llmConcurrency : 8,
    extensionToken: typeof config.extensionToken === 'string' ? config.extensionToken : '',
  }
}

/**
 * Translator service: one instance per plugin load.
 */
export class PageTranslator {
  /**
   * @param {object} options
   * @param {object} options.ctx - plugin context.
   * @param {object} [options.config] - raw patch config.
   * @param {object} options.logger - logger (info/warn/error).
   */
  constructor({ ctx, config, logger }) {
    this.ctx = ctx
    this.log = logger
    this.config = normalizeConfig(config)
    this.translator = new LlmTranslator({ ctx, logger, config: this.config })
    this.server = createTranslatorServer({ translator: this.translator, config: this.config, logger })
    /** @type {Array<() => void>} */
    this.disposers = []
    /** @type {{port: number, origin: string} | null} */
    this.bound = null
  }

  /** @returns {string} the loopback origin (`''` before start). */
  get origin() {
    return this.bound?.origin ?? ''
  }

  /**
   * Start the proxy service, then register discovery routes where available.
   * @returns {Promise<void>}
   */
  async start() {
    try {
      this.bound = await this.server.start()
    } catch (error) {
      this.log.error?.('page translator: failed to bind loopback service: %s', String(error))
      throw error
    }
    await this.writeStateFile()
    this.registerRoutes()
  }

  /**
   * Publish `{ origin, port }` plus the built-in-browser bridge routes on the DSH
   * web server. Registration is best-effort: a profile without the web server
   * (headless) simply skips it.
   */
  registerRoutes() {
    let webServer
    try {
      webServer = typeof this.ctx.get === 'function' ? this.ctx.get('webServer') : this.ctx.webServer
    } catch {
      webServer = undefined
    }
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      this.log.info?.('page translator: no webServer service; client routes skipped')
      return
    }
    try {
      const state = () => this.state()
      const disposers = [
        webServer.register({
          path: '/page-translator/state',
          kind: 'exact',
          handler: (request, response) => {
            response.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            response.end(JSON.stringify(state()))
          },
        }),
      ]
      for (const route of createBrowserBridge({ translator: this.translator, config: this.config, logger: this.log })) {
        disposers.push(webServer.register({ path: route.path, kind: 'exact', handler: route.handler }))
      }
      for (const dispose of disposers) if (typeof dispose === 'function') this.disposers.push(dispose)
      this.log.info?.('page translator: client routes registered (/page-translator/*)')
    } catch (error) {
      this.log.warn?.('page translator: route registration failed: %s', String(error))
    }
  }

  /** @returns {object} current state published to the client. */
  state() {
    const state = this.server.state()
    return {
      ...state,
      target: this.config.target,
      origin: this.bound?.origin ?? state.origin,
    }
  }

  /**
   * Write `~/.dsh/page-translator.json` for debugging / external tooling.
   * @returns {Promise<void>}
   */
  async writeStateFile() {
    try {
      const directory = join(homedir(), '.dsh')
      await mkdir(directory, { recursive: true })
      const file = join(directory, STATE_FILE)
      await writeFile(
        file,
        JSON.stringify({ pid: process.pid, origin: this.origin, port: this.bound?.port ?? 0, target: this.config.target }, null, 2),
        'utf8',
      )
      this.stateFile = file
    } catch (error) {
      this.log.warn?.('page translator: could not write state file: %s', String(error))
    }
  }

  /**
   * Stop the HTTP service and remove the state file.
   * @returns {Promise<void>}
   */
  async stop() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // disposal is best effort
      }
    }
    await this.server.stop()
    if (this.stateFile !== undefined) {
      try {
        await rm(this.stateFile, { force: true })
      } catch {
        // ignore
      }
      this.stateFile = undefined
    }
  }
}
