/** HTML rewrite tests: script/CSP stripping, base injection, boot payload. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractPageMeta, rewriteHtml, htmlToText } from '../lib/html-rewrite.js'

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<title>Film Photography Weekly</title>
<meta name="description" content="A community for analog film shooters.">
<meta property="og:site_name" content="Film Photo Club">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<script>alert(1)</script>
<link rel="stylesheet" href="/style.css" integrity="sha384-abc">
</head><body>
<header><h1>Film Photography Weekly</h1></header>
<main><p>Film grain, film rolls, and the joy of analog cameras.</p><h2>Developing at home</h2></main>
</body></html>`

test('rewrite strips scripts, CSP and integrity, keeps layout tags', () => {
  const out = rewriteHtml(PAGE, { finalUrl: 'https://film.example.com/weekly', token: 'tok123', target: 'zh' })
  assert.ok(!/<script[^>]*>alert/.test(out), 'author script is removed')
  assert.ok(!/Content-Security-Policy/i.test(out), 'CSP meta is removed')
  assert.ok(!/integrity\s*=/i.test(out), 'integrity attribute is removed')
  assert.match(out, /<base href="https:\/\/film\.example\.com\/weekly">/)
  assert.match(out, /<link rel="stylesheet" href="\/style\.css"/)
  assert.match(out, /<h1>Film Photography Weekly<\/h1>/)
  assert.match(out, /__DSH_PT_BOOT__/)
  assert.match(out, /src="\/pt\.js"/)
  const boot = /window\.__DSH_PT_BOOT__=(\{.*?\})<\/script>/.exec(out)
  assert.ok(boot, 'boot payload present')
  const parsed = JSON.parse(boot[1])
  assert.equal(parsed.token, 'tok123')
  assert.equal(parsed.pageUrl, 'https://film.example.com/weekly')
  assert.equal(parsed.target, 'zh')
  assert.equal(parsed.proxyOrigin, '')
})

test('rewrite points the injected script at the proxy origin, not the target site', () => {
  const out = rewriteHtml(PAGE, {
    finalUrl: 'https://film.example.com/weekly',
    token: 'tok',
    target: 'zh',
    assetOrigin: 'http://127.0.0.1:4567',
  })
  assert.match(out, /src="http:\/\/127\.0\.0\.1:4567\/pt\.js"/)
  assert.match(out, /"proxyOrigin":"http:\/\/127\.0\.0\.1:4567"/, 'boot carries the proxy origin for absolute API calls')
})

test('rewrite inserts base without head if needed', () => {
  const out = rewriteHtml('<p>hello</p>', { finalUrl: 'https://a.example/x', token: 't', target: 'zh' })
  assert.ok(out.startsWith('<base href="https://a.example/x">'))
  assert.match(out, /<script id="dsh-pt-script" src="\/pt.js"><\/script>$/)
})

test('extractPageMeta reads title, lang, meta, headings and sample', () => {
  const meta = extractPageMeta(PAGE, 'https://film.example.com/weekly')
  assert.equal(meta.title, 'Film Photography Weekly')
  assert.equal(meta.lang, 'en')
  assert.equal(meta.meta.description, 'A community for analog film shooters.')
  assert.equal(meta.meta.siteName, 'Film Photo Club')
  assert.deepEqual(meta.headings.slice(0, 2), ['Film Photography Weekly', 'Developing at home'])
  assert.match(meta.sample, /Film grain/)
})

test('htmlToText collapses tags and entities', () => {
  assert.equal(htmlToText('<p>a &amp; b</p><script>x</script><b>c</b>'), 'a & b c')
})
