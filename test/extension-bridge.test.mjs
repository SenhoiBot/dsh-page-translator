/** Extension bridge routes on the loopback server (`/ext/*`). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTranslatorServer } from '../lib/server.js'

const silent = { info() {}, warn() {}, error() {} }

/** Fake translator for bridge route tests. */
function fakeTranslator() {
  const calls = { context: 0, translate: 0 }
  return {
    calls,
    async analyzeContext() {
      calls.context += 1
      return { topic: '胶片摄影社区', domain: '摄影', tone: '社区', glossary: { Film: '胶片' }, notes: '' }
    },
    async translateChunk({ segments }) {
      calls.translate += 1
      const out = {}
      for (const segment of segments) out[segment.id] = '译·' + segment.text
      return out
    },
    async translateComposition({ text }) {
      calls.compose = (calls.compose ?? 0) + 1
      return 'EN: ' + String(text)
    },
  }
}

/** Start the loopback server with an optional extension token. */
async function start(config = {}) {
  const translator = fakeTranslator()
  const service = createTranslatorServer({
    translator,
    config: { port: 0, target: 'zh', ...config },
    logger: silent,
  })
  const bound = await service.start()
  return { service, translator, origin: bound.origin }
}

const pagePayload = {
  url: 'https://film.example.com/weekly',
  title: 'Film Photography Weekly',
  lang: 'en',
  meta: { description: 'analog film' },
  headings: ['Film Photography Weekly'],
  sample: 'Film grain everywhere.',
}

test('extension bridge: health, context and chunk translation without a page token', async () => {
  const { service, translator, origin } = await start()
  try {
    const health = await fetch(origin + '/ext/health').then((response) => response.json())
    assert.equal(health.ok, true)
    assert.equal(health.target, 'zh')

    const context = await fetch(origin + '/ext/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pagePayload),
    }).then((response) => response.json())
    assert.equal(context.ok, true)
    assert.equal(context.context.glossary.Film, '胶片')
    assert.equal(translator.calls.context, 1)

    const translated = await fetch(origin + '/ext/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: pagePayload.url,
        target: 'zh',
        context: context.context,
        segments: [
          { id: '1', text: 'Film' },
          { id: '2', text: 'Grain' },
        ],
      }),
    }).then((response) => response.json())
    assert.equal(translated.ok, true)
    assert.deepEqual(translated.translations, { 1: '译·Film', 2: '译·Grain' })
    assert.equal(translator.calls.translate, 1)
  } finally {
    await service.stop()
  }
})

test('extension bridge: optional static token is enforced when configured', async () => {
  const { service, origin } = await start({ extensionToken: 'secret-token' })
  try {
    const denied = await fetch(origin + '/ext/health')
    assert.equal(denied.status, 403)

    const allowed = await fetch(origin + '/ext/health', { headers: { 'x-pt-ext-token': 'secret-token' } })
    assert.equal(allowed.status, 200)
    const health = await allowed.json()
    assert.equal(health.ok, true)

    const wrong = await fetch(origin + '/ext/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pt-ext-token': 'nope' },
      body: JSON.stringify(pagePayload),
    })
    assert.equal(wrong.status, 403)
  } finally {
    await service.stop()
  }
})

test('extension bridge: compose translates a Chinese reply draft to English', async () => {
  const { service, translator, origin } = await start()
  try {
    const response = await fetch(origin + '/ext/compose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '这张照片的颗粒感真好！',
        context: { topic: '胶片摄影', domain: '摄影' },
        url: 'https://reddit.com/r/analog/comments/x',
        target: 'en',
      }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.text, 'EN: 这张照片的颗粒感真好！')
    assert.equal(translator.calls.compose, 1)
  } finally {
    await service.stop()
  }
})

test('extension bridge: fixed port falls back when busy', async () => {
  const first = await start({ port: 0 })
  const busyPort = Number(new URL(first.origin).port)
  const second = createTranslatorServer({ translator: fakeTranslator(), config: { port: busyPort }, logger: silent })
  try {
    const bound = await second.start()
    assert.notEqual(bound.port, busyPort, 'falls back to a free port instead of failing to start')
  } finally {
    await second.stop()
    await first.service.stop()
  }
})
