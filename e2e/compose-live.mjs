/**
 * Live check of the reply composer with the real host model.
 *
 * Usage: node e2e/compose-live.mjs --host http://127.0.0.1:<port> [--url <page>] [--text <draft>] [--tone natural|casual|humorous|technical]
 */
import { extractPageMeta } from '../lib/html-rewrite.js'

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const host = String(arg('host', '')).replace(/\/$/, '')
const pageUrl = String(arg('url', 'https://filmphotographyproject.com/'))
const singleText = String(arg('text', ''))
const tone = String(arg('tone', 'natural'))
if (host === '') {
  console.error('missing --host')
  process.exit(2)
}

const original = await fetch(pageUrl, {
  headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131 Safari/537.36' },
}).then((response) => response.text())
const meta = extractPageMeta(original, pageUrl)

const context = await fetch(host + '/page-translator/context', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: pageUrl,
    title: meta.title,
    lang: meta.lang,
    meta: meta.meta,
    headings: meta.headings,
    sample: meta.sample,
  }),
}).then((response) => response.json())
console.log('context topic:', context.context?.topic)

const drafts =
  singleText !== ''
    ? [singleText]
    : [
        '看到这组照片仿佛是让我置身于某个人的大脑中窥探他的梦境。绝对的好照片，这是一枚报恩的镜头，不要修理他！',
        '这张照片的颗粒感真好！请问用的是什么胶卷？',
      ]
for (const draft of drafts) {
  const started = Date.now()
  const response = await fetch(host + '/page-translator/compose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: draft,
      context: context.context,
      url: pageUrl,
      title: meta.title,
      target: 'en',
      tone,
    }),
  })
  const data = await response.json()
  console.log(`\ntone    : ${tone}`)
  console.log(`draft   : ${draft}`)
  if (!data.ok) {
    console.log('error   :', JSON.stringify(data))
    continue
  }
  console.log(`reply   : ${data.text}`)
  console.log(`time    : ${Date.now() - started} ms`)
}
