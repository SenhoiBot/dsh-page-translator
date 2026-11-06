/**
 * Host-side LLM bridge.
 *
 * The plugin never holds an API key and never talks to a provider directly: it
 * goes through the host `llm` service (`resolveCallConfig` / `prepareCall` /
 * `prepared.stream`), which owns provider routing, credentials, retries and
 * telemetry. Reason effort is pinned to the model's cheapest setting (`off` when
 * advertised) because translation is a bounded rewrite, not a reasoning task —
 * this is what keeps a page fast.
 */

import { compositionPrompt, contextPrompt, translatePrompt } from './prompts.js'

/** Output budget for the context analysis call. */
const CONTEXT_MAX_TOKENS = 500
/** Output budget for one chunk translation call. */
const TRANSLATE_MAX_TOKENS = 4096
/** Composer limits: a reply draft, not a page. */
const COMPOSE_MAX_CHARS = 4000
const COMPOSE_MAX_TOKENS = 2048
/** Default per-call timeout. */
const DEFAULT_CALL_TIMEOUT_MS = 25_000
/** Reasoning effort used for translation calls: thinking buys nothing here. */
const PREFERRED_EFFORT = 'off'

/**
 * Error carrying a stable machine code, surfaced to the page as a short message.
 */
export class TranslatorError extends Error {
  /**
   * @param {string} code - stable code (e.g. `llm-unavailable`).
   * @param {string} message - human readable, safe to show.
   * @param {object} [details] - extra JSON-safe facts.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'TranslatorError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * Extract the first JSON object from a model reply, tolerating code fences and
 * leading prose.
 * @param {string} raw
 * @returns {object | null}
 */
export function extractJsonObject(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced?.[1]) text = fenced[1].trim()
  const direct = tryParse(text)
  if (direct !== null) return direct
  const braced = firstBalancedObject(text)
  if (braced !== null) return tryParse(braced)
  return null
}

/**
 * Normalize a parsed chunk reply to `{ id: translation }`.
 * @param {unknown} parsed
 * @returns {Record<string, string>}
 */
export function normalizeChunkTranslations(parsed) {
  if (parsed === null || typeof parsed !== 'object') return {}
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.items)
      ? parsed.items
      : Array.isArray(parsed.translations)
        ? parsed.translations
        : null
  if (list !== null) {
    const out = {}
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue
      const id = entry.id ?? entry.index ?? entry.i
      const text = entry.text ?? entry.translation ?? entry.t
      if (id !== undefined && typeof text === 'string') out[String(id)] = text
    }
    return out
  }
  const out = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value
    else if (value !== null && typeof value === 'object' && typeof value.text === 'string') out[key] = value.text
  }
  return out
}

/**
 * Normalize the context analysis reply.
 * @param {unknown} parsed
 * @returns {{topic: string, domain: string, tone: string, glossary: Record<string, string>, notes: string}}
 */
export function normalizeContext(parsed) {
  const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const glossary = {}
  const rawGlossary = source.glossary !== null && typeof source.glossary === 'object' ? source.glossary : {}
  let count = 0
  for (const [key, value] of Object.entries(rawGlossary)) {
    if (count >= 24) break
    if (typeof value === 'string' && key.trim() !== '' && value.trim() !== '') {
      glossary[key.trim()] = value.trim()
      count += 1
    }
  }
  return {
    topic: typeof source.topic === 'string' ? source.topic.trim() : '',
    domain: typeof source.domain === 'string' ? source.domain.trim() : '',
    tone: typeof source.tone === 'string' ? source.tone.trim() : '',
    glossary,
    notes: typeof source.notes === 'string' ? source.notes.trim() : '',
  }
}

/**
 * LLM-backed translator.
 */
export class LlmTranslator {
  /**
   * @param {object} options
   * @param {object} options.ctx - plugin context; must expose `llm` and optionally `agentDefaultModel`.
   * @param {Function} options.logger - logger function with `info`/`warn`/`error`.
   * @param {object} [options.config] - plugin config (`provider`, `model`, `callTimeoutMs`).
   */
  constructor({ ctx, logger, config, onCall }) {
    this.ctx = ctx
    this.log = logger
    this.config = config ?? {}
    /** Optional timing/effort observer: ({kind, ms, provider, model, reasoningEffort}) => void. */
    this.onCall = typeof onCall === 'function' ? onCall : null
    /** Last call sample, surfaced to diagnostics (kind/ms/effort). */
    this.lastCall = null
    /** @type {{provider: string, model: string, at: number} | null} */
    this.routeCache = null
    /** @type {string[]} */
    this.routeWarnings = []
  }

  /** @returns {object} the host llm service. */
  service() {
    const llm = typeof this.ctx.get === 'function' ? this.ctx.get('llm') : this.ctx.llm
    if (llm === undefined || llm === null) {
      throw new TranslatorError('llm-unavailable', 'DSH 宿主的 llm 服务不可用，无法翻译')
    }
    return llm
  }

  /**
   * Resolve the provider/model route: explicit config wins, then the host default
   * model selection. A route is cached briefly so a page of parallel chunks does
   * not resolve it many times.
   * @returns {{provider: string, model: string}}
   */
  route() {
    const configuredProvider = String(this.config.provider ?? '').trim()
    const configuredModel = String(this.config.model ?? '').trim()
    if (configuredProvider !== '' && configuredModel !== '') {
      return { provider: configuredProvider, model: configuredModel }
    }
    const now = Date.now()
    if (this.routeCache !== null && now - this.routeCache.at < 60_000) {
      return { provider: this.routeCache.provider, model: this.routeCache.model }
    }
    let selection = null
    try {
      const service = typeof this.ctx.get === 'function' ? this.ctx.get('agentDefaultModel') : this.ctx.agentDefaultModel
      if (service !== undefined && service !== null && typeof service.currentSelection === 'function') {
        selection = service.currentSelection()
      }
    } catch (error) {
      this.routeWarnings.push(String(error instanceof Error ? error.message : error))
    }
    const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : ''
    const model = typeof selection?.model === 'string' ? selection.model.trim() : ''
    if (provider === '' || model === '') {
      throw new TranslatorError(
        'no-model-route',
        '解析不出要用的模型：请在插件配置里设置 provider/model，或先在 DSH 里选择一个默认模型',
      )
    }
    this.routeCache = { provider, model, at: now }
    return { provider, model }
  }

  /**
   * One streaming model call, returning the joined visible text.
   * @param {object} options
   * @param {string} options.system
   * @param {string} options.user
   * @param {number} [options.maxTokens]
   * @param {'context'|'chunk'|'compose'} [options.kind] - diagnostic label.
   * @param {number} [options.temperature] - sampling temperature (default 0.2).
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<string>}
   */
  async call({ system, user, maxTokens, kind, temperature, signal }) {
    const llm = this.service()
    const route = this.route()
    const started = Date.now()
    const timeout = Number.isFinite(this.config.callTimeoutMs) ? this.config.callTimeoutMs : DEFAULT_CALL_TIMEOUT_MS
    const timeoutSignal = AbortSignal.timeout(timeout)
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])

    const baseConfig = {
      provider: route.provider,
      model: route.model,
      reasoningEffort: PREFERRED_EFFORT,
      temperature: Number.isFinite(temperature) ? temperature : 0.2,
      maxTokens: maxTokens ?? TRANSLATE_MAX_TOKENS,
    }
    let prepared
    try {
      prepared = await prepareCall(llm, baseConfig, combined)
    } catch (error) {
      if (isUnsupportedEffort(error)) {
        // The model does not advertise `off`: take its lowest advertised effort
        // instead of dropping the field (which would inherit "high" and make
        // translation needlessly slow).
        prepared = await prepareCall(llm, baseConfig, combined, lowestEffort)
      } else {
        throw normalizeCallError(error)
      }
    }

    const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }]
    const options = { ...prepared.config, system, messages, signal: combined }
    let text = ''
    let failure = null
    try {
      for await (const chunk of prepared.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason !== null && typeof chunk.reason === 'object' && chunk.reason.kind === 'error') {
          failure = chunk.reason.failure ?? chunk.reason
        }
      }
    } catch (error) {
      this.reportCall({ kind, started, prepared, route })
      if (isAbort(error)) throw new TranslatorError('timeout', '模型调用超时，稍后再试', { timeout })
      throw normalizeCallError(error)
    }
    this.reportCall({ kind, started, prepared, route })
    const trimmed = text.trim()
    if (trimmed === '') {
      if (failure !== null) {
        throw new TranslatorError('llm-failed', `模型调用失败：${String(failure.message ?? '未知错误')}`)
      }
      throw new TranslatorError('empty-response', '模型没有返回内容')
    }
    return trimmed
  }

  /**
   * Emit a timing/effort sample to the optional observer.
   * @param {{kind?: string, started: number, prepared: object, route: {provider: string, model: string}}} sample
   */
  reportCall({ kind, started, prepared, route }) {
    const sample = {
      kind: kind ?? 'call',
      ms: Date.now() - started,
      provider: route.provider,
      model: route.model,
      reasoningEffort: prepared.config?.reasoningEffort ?? null,
    }
    this.lastCall = sample
    if (this.onCall === null) return
    try {
      this.onCall(sample)
    } catch {
      // observers must not break translation
    }
  }

  /**
   * Analyze the page once: topic, domain, tone and a glossary that disambiguates
   * words like film/photography vs film/movie.
   * @param {object} page - page metadata from the in-page script.
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<{topic: string, domain: string, tone: string, glossary: Record<string, string>, notes: string}>}
   */
  async analyzeContext(page, options = {}) {
    const { system, user } = contextPrompt(page, this.config.target ?? 'zh')
    const raw = await this.call({ system, user, maxTokens: CONTEXT_MAX_TOKENS, kind: 'context', signal: options.signal })
    const parsed = extractJsonObject(raw)
    if (parsed === null) {
      this.log?.warn?.('context call returned non-JSON; continuing without glossary')
      return normalizeContext({})
    }
    return normalizeContext(parsed)
  }

  /**
   * Translate one chunk of segments with page context baked into the prompt.
   * @param {object} options
   * @param {object | null} options.context - page context from analyzeContext.
   * @param {Array<{id: string, text: string}>} options.segments
   * @param {string} [options.pageUrl]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<Record<string, string>>} id -> translation.
   */
  async translateChunk({ context, segments, pageUrl, signal }) {
    const ids = new Set(segments.map((segment) => String(segment.id)))
    const { system, user } = translatePrompt({ context, segments, target: this.config.target ?? 'zh', pageUrl })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await this.call({ system, user, maxTokens: TRANSLATE_MAX_TOKENS, kind: 'chunk', signal })
      const parsed = extractJsonObject(raw)
      const table = parsed === null ? {} : normalizeChunkTranslations(parsed)
      const matched = {}
      let hit = 0
      for (const id of ids) {
        const value = table[id]
        if (typeof value === 'string' && value.trim() !== '') {
          matched[id] = value
          hit += 1
        }
      }
      if (hit > 0 || attempt === 1) return matched
    }
    return {}
  }

  /**
   * Translate the user's reply draft (usually Chinese) into the target language,
   * using the page's topic/tone/glossary so it reads like a native comment.
   * @param {object} options
   * @param {string} options.text - the draft.
   * @param {object | null} [options.context] - page context.
   * @param {string} [options.pageUrl]
   * @param {string} [options.pageTitle]
   * @param {string} [options.target] - target language tag (default `en`).
   * @param {string} [options.tone] - tone preset id.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<string>}
   */
  async translateComposition({ text, context, pageUrl, pageTitle, target = 'en', tone = 'natural', signal }) {
    const source = String(text ?? '').trim()
    if (source === '') throw new TranslatorError('empty-text', '要翻译的内容为空')
    if (source.length > COMPOSE_MAX_CHARS) {
      throw new TranslatorError('text-too-long', `内容太长（上限 ${COMPOSE_MAX_CHARS} 字符）`)
    }
    const { system, user } = compositionPrompt({ context, text: source, pageUrl, pageTitle, target, tone })
    const raw = await this.call({
      system,
      user,
      maxTokens: COMPOSE_MAX_TOKENS,
      kind: 'compose',
      temperature: 0.6,
      signal,
    })
    return raw.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/```\s*$/, '').trim()
  }
}

/**
 * Prepare a call, keeping the two-argument and three-argument host signatures
 * compatible.
 * @param {object} llm
 * @param {object} config
 * @param {AbortSignal} signal
 * @param {Function} [configure] - host `ConfigureCall` callback (controls, model).
 * @returns {Promise<{config: object, stream: Function}>}
 */
async function prepareCall(llm, config, signal, configure) {
  if (typeof llm.prepareCall !== 'function') {
    throw new TranslatorError('llm-incompatible', '宿主 llm 服务版本过旧：缺少 prepareCall')
  }
  return configure === undefined ? llm.prepareCall(config, signal) : llm.prepareCall(config, signal, configure)
}

/**
 * `ConfigureCall` that selects the model's cheapest advertised reasoning effort.
 * Used only when `off` is rejected, so translation never silently inherits the
 * profile's high default effort.
 * @param {object} controls
 * @param {{reasoning?: {efforts?: Array<{id?: string}>}}} model
 * @returns {object}
 */
function lowestEffort(controls, model) {
  const efforts = model?.reasoning?.efforts
  const id = Array.isArray(efforts) && efforts.length > 0 ? efforts[0]?.id : undefined
  return typeof id === 'string' && id !== '' ? { ...controls, reasoningEffort: id } : controls
}

/**
 * Whether a failure means the requested reasoning effort is not advertisable.
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnsupportedEffort(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '')
  return code === 'UNSUPPORTED_REASONING_EFFORT' || /reasoning effort/i.test(message)
}

/**
 * Whether a failure is an abort/timeout.
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbort(error) {
  const name = String(error?.name ?? '')
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * Map a host failure to a page-safe translator error.
 * @param {unknown} error
 * @returns {TranslatorError}
 */
function normalizeCallError(error) {
  if (error instanceof TranslatorError) return error
  const code = String(error?.code ?? 'llm-error')
  const message = String(error?.message ?? error)
  return new TranslatorError('llm-failed', `模型调用失败（${code}）：${message.slice(0, 300)}`)
}

/**
 * @param {string} text
 * @returns {object | null}
 */
function tryParse(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Find the first balanced `{...}` block, skipping braces inside strings.
 * @param {string} text
 * @returns {string | null}
 */
function firstBalancedObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let quote = ''
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}
