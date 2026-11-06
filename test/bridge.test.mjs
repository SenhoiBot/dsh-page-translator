/** Host bridge routes for the built-in browser mode. */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createBrowserBridge } from '../lib/browser-bridge.js'

const silent = { info() {}, warn() {}, error() {} }

/** Fake translator shared by the route tests. */
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
    async translateComposition({ text, tone }) {
      calls.compose = (calls.compose ?? 0) + 1
      calls.tone = tone
      return 'EN: ' + String(text)
    },
  }
}

/** Serve the bridge routes on a throwaway HTTP server. */
async function startBridge(translator) {
  const routes = createBrowserBridge({ translator, config: { target: 'zh' }, logger: silent })
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = routes.find((candidate) => candidate.path === url.pathname)
    if (route === undefined) {
      response.writeHead(404).end()
      return
    }
    route.handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('bridge serves the guest controller script', async () => {
  const bridge = await startBridge(fakeTranslator())
  try {
    const response = await fetch(bridge.origin + '/page-translator/hosted.js')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /javascript/)
    const source = await response.text()
    assert.match(source, /__DSH_PT_PAGE__/)
    assert.match(source, /collect/)
    assert.match(source, /restore/)
  } finally {
    await bridge.close()
  }
})

test('bridge caches page context and chunk translations', async () => {
  const translator = fakeTranslator()
  const bridge = await startBridge(translator)
  try {
    const contextBody = {
      url: 'https://film.example.com/weekly',
      title: 'Film Photography Weekly',
      lang: 'en',
      meta: { description: 'analog film' },
      headings: ['Film Photography Weekly'],
      sample: 'Film grain everywhere.',
    }
    const first = await fetch(bridge.origin + '/page-translator/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(contextBody),
    }).then((response) => response.json())
    assert.equal(first.ok, true)
    assert.equal(first.context.glossary.Film, '胶片')
    assert.equal(first.cached, false)
    assert.equal(translator.calls.context, 1)

    const second = await fetch(bridge.origin + '/page-translator/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(contextBody),
    }).then((response) => response.json())
    assert.equal(second.cached, true)
    assert.equal(translator.calls.context, 1)

    const translateBody = {
      url: 'https://film.example.com/weekly',
      target: 'zh',
      context: first.context,
      segments: [
        { id: '1', text: 'Film' },
        { id: '2', text: 'Grain' },
      ],
    }
    const translated = await fetch(bridge.origin + '/page-translator/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(translateBody),
    }).then((response) => response.json())
    assert.equal(translated.ok, true)
    assert.deepEqual(translated.translations, { 1: '译·Film', 2: '译·Grain' })
    assert.equal(translated.cached, 0)
    assert.equal(translator.calls.translate, 1)

    const cached = await fetch(bridge.origin + '/page-translator/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(translateBody),
    }).then((response) => response.json())
    assert.equal(cached.cached, 2)
    assert.equal(translator.calls.translate, 1)
  } finally {
    await bridge.close()
  }
})

test('bridge rejects malformed JSON with 400', async () => {
  const bridge = await startBridge(fakeTranslator())
  try {
    const response = await fetch(bridge.origin + '/page-translator/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.ok, false)
  } finally {
    await bridge.close()
  }
})

test('bridge translates a reply draft to English (compose route)', async () => {
  const translator = fakeTranslator()
  const bridge = await startBridge(translator)
  try {
    const response = await fetch(bridge.origin + '/page-translator/compose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '这张照片的颗粒感真好！',
        context: { topic: '胶片摄影', domain: '摄影' },
        url: 'https://film.example.com/post/1',
        title: 'Film Photography Weekly',
        target: 'en',
        tone: 'humorous',
      }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.text, 'EN: 这张照片的颗粒感真好！')
    assert.equal(translator.calls.compose, 1)
    assert.equal(translator.calls.tone, 'humorous')
  } finally {
    await bridge.close()
  }
})
