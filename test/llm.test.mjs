/** LLM bridge tests: route resolution, JSON parsing, reasoning-effort fallback. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LlmTranslator,
  extractJsonObject,
  normalizeChunkTranslations,
  normalizeContext,
} from '../lib/llm.js'

/** Build a fake host context around a scripted llm service. */
function fakeCtx({ replies, selection = { provider: 'deepseek-account', model: 'deepseek-flash' }, effortRejects = false }) {
  const calls = []
  const llm = {
    async prepareCall(config, _signal, configure) {
      const effective =
        typeof configure === 'function'
          ? configure(config, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
          : config
      if (effortRejects && (typeof configure !== 'function' || effective.reasoningEffort !== 'low')) {
        const error = new Error('model does not support reasoning effort "off"')
        error.code = 'UNSUPPORTED_REASONING_EFFORT'
        throw error
      }
      calls.push(effective)
      return {
        config: { ...effective },
        async *stream() {
          yield { type: 'text-delta', text: replies.shift() ?? '' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') {
        return selection === null ? undefined : { currentSelection: () => selection }
      }
      return undefined
    },
  }
  return { ctx, calls }
}

test('extractJsonObject handles fences and prose', () => {
  assert.deepEqual(extractJsonObject('```json\n{"1":"a"}\n```'), { 1: 'a' })
  assert.deepEqual(extractJsonObject('sure: {"1":"a","2":"b"} done'), { 1: 'a', 2: 'b' })
  assert.equal(extractJsonObject('no json here'), null)
})

test('normalizeChunkTranslations accepts map and list shapes', () => {
  assert.deepEqual(normalizeChunkTranslations({ 1: 'a' }), { 1: 'a' })
  assert.deepEqual(normalizeChunkTranslations({ translations: [{ id: 2, text: 'b' }] }), { 2: 'b' })
  assert.deepEqual(normalizeContext({ topic: 'x', glossary: { Film: '胶片', empty: '' } }).glossary, { Film: '胶片' })
})

test('analyzeContext parses the JSON reply and keeps the glossary', async () => {
  const { ctx, calls } = fakeCtx({
    replies: [JSON.stringify({ topic: '胶片摄影社区', domain: '摄影', tone: '技术', glossary: { Film: '胶片', Grain: '颗粒' }, notes: '别把 Film 译成电影' })],
  })
  const translator = new LlmTranslator({ ctx, logger: console, config: {} })
  const context = await translator.analyzeContext({ url: 'https://film.example.com', title: 'Film Photography Weekly' })
  assert.equal(context.topic, '胶片摄影社区')
  assert.equal(context.glossary.Film, '胶片')
  assert.equal(calls[0].provider, 'deepseek-account')
  assert.equal(calls[0].reasoningEffort, 'off')
  assert.equal(calls[0].temperature, 0.2)
})

test('translateChunk returns only ids the model actually answered', async () => {
  const { ctx } = fakeCtx({ replies: [JSON.stringify({ 1: '胶片', 2: '颗粒', 99: '多余' })] })
  const translator = new LlmTranslator({ ctx, logger: console, config: {} })
  const table = await translator.translateChunk({
    context: { topic: '胶片摄影', glossary: { Film: '胶片' } },
    segments: [
      { id: '1', text: 'Film' },
      { id: '2', text: 'Grain' },
      { id: '3', text: 'Shutter' },
    ],
    pageUrl: 'https://film.example.com',
  })
  assert.deepEqual(table, { 1: '胶片', 2: '颗粒' })
})

test('translateChunk retries once when the reply is not JSON', async () => {
  const { ctx } = fakeCtx({ replies: ['not json at all', JSON.stringify({ 1: '相机' })] })
  const translator = new LlmTranslator({ ctx, logger: console, config: {} })
  const table = await translator.translateChunk({ context: null, segments: [{ id: '1', text: 'Camera' }] })
  assert.deepEqual(table, { 1: '相机' })
})

test('reasoning effort falls back to the lowest advertised effort', async () => {
  const { ctx, calls } = fakeCtx({ replies: ['{}', JSON.stringify({})], effortRejects: true })
  const translator = new LlmTranslator({ ctx, logger: console, config: {} })
  const table = await translator.translateChunk({ context: null, segments: [{ id: '1', text: 'Camera' }] })
  assert.deepEqual(table, {})
  // Two accepted calls: the empty reply triggers one JSON retry.
  assert.equal(calls.length, 2)
  for (const call of calls) assert.equal(call.reasoningEffort, 'low', 'never inherits the high default')
})

test('explicit config beats the host default and skips agentDefaultModel', async () => {
  const { ctx, calls } = fakeCtx({ replies: [JSON.stringify({ 1: 'x' })], selection: null })
  const translator = new LlmTranslator({ ctx, logger: console, config: { provider: 'p', model: 'm' } })
  assert.deepEqual(translator.route(), { provider: 'p', model: 'm' })
  await translator.translateChunk({ context: null, segments: [{ id: '1', text: 'a' }] })
  assert.equal(calls[0].provider, 'p')
  assert.equal(calls[0].model, 'm')
})

test('translateComposition returns a plain English reply and rejects empty drafts', async () => {
  const { ctx, calls } = fakeCtx({ replies: ['The grain in this shot is gorgeous!'] })
  const translator = new LlmTranslator({ ctx, logger: console, config: {} })
  const reply = await translator.translateComposition({
    text: '这张照片的颗粒感真好！',
    context: { topic: '胶片摄影', domain: '摄影', tone: '社区' },
    pageUrl: 'https://film.example.com/post/1',
    target: 'en',
  })
  assert.equal(reply, 'The grain in this shot is gorgeous!')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].maxTokens, 2048)

  await assert.rejects(() => translator.translateComposition({ text: '   ' }), /内容为空/)
  await assert.rejects(() => translator.translateComposition({ text: 'x'.repeat(4001) }), /太长/)
})

test('composition prompt carries slang guidance and the chosen tone', async () => {
  const { compositionPrompt } = await import('../lib/prompts.js')
  const prompt = compositionPrompt({
    context: { topic: '胶片摄影', domain: '摄影', tone: '社区' },
    text: '这是一枚报恩的镜头，不要修理他！',
    pageUrl: 'https://reddit.com/r/analog/comments/x',
    pageTitle: 'Weekly film thread',
    target: 'en',
    tone: 'humorous',
  })
  assert.match(prompt.system, /报恩/)
  assert.match(prompt.system, /不要逐字直译/)
  assert.match(prompt.system, /幽默/)
  assert.match(prompt.system, /Weekly film thread/)
  assert.equal(prompt.user, '这是一枚报恩的镜头，不要修理他！')
})

test('missing route throws a typed error', async () => {
  const { ctx } = fakeCtx({ replies: [], selection: null })
  const translator = new LlmTranslator({ ctx, logger: console, config: {} })
  assert.throws(() => translator.route(), /model|模型/)
})
