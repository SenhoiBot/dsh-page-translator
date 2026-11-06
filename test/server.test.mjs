/** Loopback server tests: rewritten proxy page, token auth, context/translate API, cache. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTranslatorServer } from '../lib/server.js'

const PAGE_HTML = `<!doctype html><html lang="en"><head><title>Film Photography Weekly</title>
<meta name="description" content="analog film community">
<script>alert('x')</script></head><body><h1>Film Photography Weekly</h1><p>Film grain everywhere.</p></body></html>`

/** Fake host translator; records calls. */
function fakeTranslator() {
  const calls = { context: 0, translate: 0 }
  return {
    calls,
    async analyzeContext(page) {
      calls.context += 1
      return { topic: '胶片摄影社区', domain: '胶片摄影', tone: '技术', glossary: { Film: '胶片' }, notes: '' }
    },
    async translateChunk({ segments }) {
      calls.translate += 1
      const out = {}
      for (const segment of segments) out[segment.id] = '译·' + segment.text
      return out
    },
  }
}

/** Fake upstream page fetch. */
async function fakeFetch(url) {
  return new Response(PAGE_HTML, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/** Quiet logger. */
const silent = { info() {}, warn() {}, error() {} }

test('server: proxy page, token auth, context and chunk translation', async () => {
  const translator = fakeTranslator()
  const service = createTranslatorServer({ translator, config: { port: 0, target: 'zh' }, logger: silent, fetchImpl: fakeFetch })
  try {
    const { origin, port } = await service.start()
    assert.ok(port > 0)

    const health = await fetch(origin + '/health').then((response) => response.json())
    assert.equal(health.ok, true)

    const pageResponse = await fetch(origin + '/p?url=' + encodeURIComponent('https://film.example.com/weekly'))
    assert.equal(pageResponse.status, 200)
    const page = await pageResponse.text()
    assert.match(page, /<base href="https:\/\/film\.example\.com\/weekly">/)
    assert.match(page, /__DSH_PT_BOOT__/)
    assert.ok(page.includes('src="' + origin + '/pt.js"'), 'injected script points at the proxy origin')
    assert.ok(!/alert\('x'\)/.test(page), 'author script stripped')
    const token = JSON.parse(/window\.__DSH_PT_BOOT__=(\{.*?\})<\/script>/.exec(page)[1]).token
    assert.equal(typeof token, 'string')

    const script = await fetch(origin + '/pt.js').then((response) => response.text())
    assert.match(script, /collectSegments/)

    // Without the per-process token the API refuses.
    const unauthorized = await fetch(origin + '/api/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://film.example.com/weekly' }),
    })
    assert.equal(unauthorized.status, 403)

    const contextResponse = await fetch(origin + '/api/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pt-token': token },
      body: JSON.stringify({
        url: 'https://film.example.com/weekly',
        title: 'Film Photography Weekly',
        lang: 'en',
        meta: { description: 'analog film community' },
        headings: ['Film Photography Weekly'],
        sample: 'Film grain everywhere.',
      }),
    })
    const contextData = await contextResponse.json()
    assert.equal(contextResponse.status, 200)
    assert.equal(contextData.ok, true)
    assert.equal(contextData.context.topic, '胶片摄影社区')
    assert.equal(contextData.context.glossary.Film, '胶片')
    assert.equal(translator.calls.context, 1)

    // Same page again is served from the context cache.
    const cachedContext = await fetch(origin + '/api/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pt-token': token },
      body: JSON.stringify({ url: 'https://film.example.com/weekly' }),
    }).then((response) => response.json())
    assert.equal(cachedContext.cached, true)
    assert.equal(translator.calls.context, 1)

    const translateResponse = await fetch(origin + '/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pt-token': token },
      body: JSON.stringify({
        url: 'https://film.example.com/weekly',
        target: 'zh',
        context: contextData.context,
        segments: [
          { id: '1', text: 'Film' },
          { id: '2', text: 'Grain' },
        ],
      }),
    })
    const translated = await translateResponse.json()
    assert.equal(translateResponse.status, 200)
    assert.deepEqual(translated.translations, { 1: '译·Film', 2: '译·Grain' })
    assert.equal(translated.cached, 0)

    // Second identical request is fully cached and does not call the model again.
    const second = await fetch(origin + '/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pt-token': token },
      body: JSON.stringify({
        url: 'https://film.example.com/weekly',
        target: 'zh',
        segments: [
          { id: '1', text: 'Film' },
          { id: '2', text: 'Grain' },
        ],
      }),
    }).then((response) => response.json())
    assert.equal(second.cached, 2)
    assert.equal(translator.calls.translate, 1)

    const state = await fetch(origin + '/api/state', { headers: { 'x-pt-token': token } }).then((response) => response.json())
    assert.equal(state.ok, true)
    assert.equal(state.port, port)
  } finally {
    await service.stop()
  }
})

test('server: non-HTML upstream and unknown routes fail softly', async () => {
  const translator = fakeTranslator()
  const service = createTranslatorServer({
    translator,
    config: { port: 0 },
    logger: silent,
    fetchImpl: async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  try {
    const { origin } = await service.start()
    const page = await fetch(origin + '/p?url=' + encodeURIComponent('https://example.com/api'))
    assert.equal(page.status, 502)
    assert.match(await page.text(), /不是 HTML 页面/)

    const missing = await fetch(origin + '/nope')
    assert.equal(missing.status, 404)

    const badUrl = await fetch(origin + '/p?url=not-a-url')
    assert.equal(badUrl.status, 502)
  } finally {
    await service.stop()
  }
})
