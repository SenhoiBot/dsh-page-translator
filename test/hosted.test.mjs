/** Guest-page controller (built-in browser mode) tests in jsdom. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'page-script-hosted.js'), 'utf8')
const requireFromSuperagent = createRequire(join(here, '..', '..', '..', 'dsh-superagent', 'package.json'))
const { JSDOM } = requireFromSuperagent('jsdom')

const PAGE = `<!doctype html><html lang="en"><head><title>Film Photography Weekly</title>
<meta name="description" content="analog film community"></head><body>
<h1>Film Photography Weekly</h1>
<p id="a">Film grain and film rolls.</p>
<p id="b">Film</p><p id="c">Film</p>
<code>const film = 1</code>
<textarea>textarea text stays</textarea>
<p id="zh">这已经是中文，不需要翻译</p>
</body></html>`

/** Boot the controller in a fresh page and return its API. */
function boot() {
  return bootWithHint(null)
}

/** Boot with an optional renderer position hint (the bridge restore path). */
function bootWithHint(position) {
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only', url: 'https://film.example.com/weekly' })
  if (position !== null) dom.window.__DSH_PT_PILL_POS__ = position
  dom.window.eval(source)
  return { dom, window: dom.window, document: dom.window.document, api: dom.window.__DSH_PT_PAGE__ }
}

/** Dispatch a pointer event into the jsdom guest page (jsdom has no layout). */
function pointer(window, target, type, x, y) {
  target.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: 0,
      isPrimary: true,
    }),
  )
}

test('controller installs the pill and exposes the bridge contract', () => {
  const { document, api, window } = boot()
  assert.ok(api, 'window.__DSH_PT_PAGE__ is installed')
  assert.equal(typeof api.poll, 'function')
  assert.equal(typeof api.collect, 'function')
  assert.equal(typeof api.apply, 'function')
  assert.equal(typeof api.restore, 'function')
  assert.equal(typeof api.status, 'function')
  assert.equal(api.ping(), true)
  assert.ok(document.querySelector('#dsh-pt-root'), 'pill is appended to the page')
  assert.equal(document.querySelectorAll('#dsh-pt-root svg path').length, 4, 'translate glyph is the pill icon')
  assert.equal(document.querySelector('#dsh-pt-dot'), null, 'the old status dot is gone')
  // Re-injection is idempotent.
  assert.equal(window.eval(source), 'ready')
})

test('collect reports unique segments and page context', () => {
  const { api } = boot()
  const info = api.collect()
  assert.ok(Array.isArray(info.segments))
  const texts = info.segments.map((segment) => segment.text)
  assert.ok(texts.includes('Film Photography Weekly'))
  assert.ok(texts.includes('Film grain and film rolls.'))
  assert.ok(!texts.some((text) => text.includes('const film')), 'code is not translated')
  assert.ok(!texts.some((text) => text.includes('textarea')), 'textarea is not translated')
  assert.ok(!texts.includes('这已经是中文，不需要翻译'), 'already-Chinese text is skipped')
  const film = info.segments.filter((segment) => segment.text === 'Film')
  assert.equal(film.length, 1, 'duplicate strings collapse into one segment')
  assert.equal(info.context.url, 'https://film.example.com/weekly')
  assert.equal(info.context.title, 'Film Photography Weekly')
  assert.ok(info.total >= 3)
})

test('pill click produces translate then restore requests, apply/restore edit in place', () => {
  const { document, api } = boot()
  const pill = document.querySelector('#dsh-pt-root')
  pill.click()
  assert.equal(api.poll(), 'translate')
  assert.equal(api.poll(), null)

  const info = api.collect()
  const table = {}
  for (const segment of info.segments) table[segment.id] = '译:' + segment.text
  const applied = api.apply(table)
  assert.ok(applied > 0)
  assert.equal(document.querySelector('#a').textContent, '译:Film grain and film rolls.')
  assert.equal(document.querySelector('#b').textContent, '译:Film')
  assert.equal(document.querySelector('code').textContent, 'const film = 1')

  // The pill reports "done", and the next click asks for a restore.
  api.status('done', '已译文', '胶片摄影')
  assert.equal(pill.getAttribute('data-state'), 'done')
  pill.click()
  assert.equal(api.poll(), 'restore')
  const restored = api.restore()
  assert.ok(restored > 0)
  assert.equal(document.querySelector('#a').textContent, 'Film grain and film rolls.')
  assert.equal(document.querySelector('#b').textContent, 'Film')
  api.status('idle', '译')
  assert.equal(pill.getAttribute('data-state'), 'idle')
})

test('pill ignores clicks while busy', () => {
  const { document, api } = boot()
  const pill = document.querySelector('#dsh-pt-root')
  api.status('busy', '翻译中…')
  pill.click()
  assert.equal(api.poll(), null)
})

test('reply composer sends a draft and shows the English result', () => {
  const { document, api } = boot()
  const input = document.querySelector('#dsh-pt-compose-input')
  const send = document.querySelector('#dsh-pt-compose-send')
  const tone = document.querySelector('#dsh-pt-compose-tone')
  assert.ok(input, 'compose input exists next to the pill')
  assert.ok(send, 'send button exists')
  assert.ok(tone, 'tone selector exists')
  assert.equal(input.placeholder, '中文 → English')
  assert.equal(tone.value, 'natural')

  input.value = '这张照片的颗粒感真好！'
  tone.value = 'humorous'
  send.click()
  const draft = api.pollCompose()
  assert.equal(draft.text, '这张照片的颗粒感真好！', 'draft is handed to the plugin')
  assert.equal(draft.tone, 'humorous', 'tone is handed to the plugin')
  assert.equal(api.pollCompose(), null, 'draft is consumed once')

  api.composeResult('The grain in this shot is gorgeous, I swear!')
  const panel = document.querySelector('#dsh-pt-compose-panel')
  assert.ok(panel, 'result panel exists')
  assert.equal(panel.style.display, 'block')
  assert.equal(document.querySelector('#dsh-pt-compose-text').textContent, 'The grain in this shot is gorgeous, I swear!')

  // The panel itself is not page content: collect must ignore it.
  const collected = api.collect()
  assert.ok(!collected.segments.some((segment) => segment.text.includes('gorgeous')))
})

test('compose errors surface in the panel and re-enable the send button', () => {
  const { document, api } = boot()
  const input = document.querySelector('#dsh-pt-compose-input')
  const send = document.querySelector('#dsh-pt-compose-send')
  input.value = '你好'
  send.click()
  assert.equal(send.disabled, true)
  api.composeError('模型调用失败')
  assert.equal(send.disabled, false)
  assert.match(document.querySelector('#dsh-pt-compose-text').textContent, /翻译失败/)
})

test('progress label and follow() handle content added after translation', async () => {
  const { document, api } = boot()
  const info = api.collect()
  const table = {}
  for (const segment of info.segments) table[segment.id] = '译·' + segment.text
  api.apply(table)
  api.status('done', '已译 100%')

  api.progress('更新中 0%')
  assert.equal(document.querySelector('#dsh-pt-label').textContent, '更新中 0%')

  // Simulate Reddit infinite scroll / SPA navigation appending new English text.
  const added = document.createElement('p')
  added.id = 'new'
  added.textContent = 'New comment from Reddit'
  document.body.appendChild(added)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const follow = api.follow()
  assert.ok(follow, 'follow reports new segments')
  assert.ok(follow.segments.some((segment) => segment.text === 'New comment from Reddit'))
  const segment = follow.segments.find((candidate) => candidate.text === 'New comment from Reddit')
  api.apply({ [segment.id]: '来自 Reddit 的新评论' })
  assert.equal(added.textContent, '来自 Reddit 的新评论')
  assert.equal(api.follow(), null, 'nothing new on the next poll')

  // Restore still works after follow updates.
  api.restore()
  assert.equal(added.textContent, 'New comment from Reddit')
})

test('drag moves the pill with left/top, clamps to the viewport and never toggles', () => {
  const { document, api, window } = boot()
  const pill = document.querySelector('#dsh-pt-root')
  api.setPillPosition({ x: 100, y: 100 })
  assert.equal(pill.style.left, '100px')
  assert.equal(pill.style.top, '100px')
  assert.equal(pill.style.right, 'auto', 'the first drag switches from right to left')
  assert.equal(pill.style.bottom, 'auto', 'the first drag switches from bottom to top')

  // A press below the drag threshold keeps the click behaviour.
  pointer(window, pill, 'pointerdown', 120, 120)
  pointer(window, pill, 'pointermove', 122, 121)
  pointer(window, pill, 'pointerup', 122, 121)
  pill.click()
  assert.equal(api.poll(), 'translate', 'a small pointer move is still a click')
  api.status('idle', '译')

  // A real drag moves the pill and must not toggle translation.
  pointer(window, pill, 'pointerdown', 120, 120)
  pointer(window, pill, 'pointermove', 300, 400)
  pointer(window, pill, 'pointerup', 300, 400)
  assert.equal(pill.style.left, '280px', 'left follows the pointer delta')
  assert.equal(pill.style.top, '380px', 'top follows the pointer delta')
  assert.deepEqual({ ...api.pollPillPosition() }, { x: 280, y: 380 }, 'the drag result is reported once')
  assert.equal(api.pollPillPosition(), null, 'a drag result is consumed once')
  pill.click()
  assert.equal(api.poll(), null, 'the click synthesized after a drag must not toggle')
  pill.click()
  assert.equal(api.poll(), 'translate', 'the next click toggles again')
  api.status('idle', '译')

  // Dragging past the viewport edge clamps with an 8px margin.
  pointer(window, pill, 'pointerdown', 300, 400)
  pointer(window, pill, 'pointermove', 5000, 5000)
  pointer(window, pill, 'pointerup', 5000, 5000)
  assert.equal(pill.style.left, '1016px', 'right edge clamp (1024 - 8)')
  assert.equal(pill.style.top, '760px', 'bottom edge clamp (768 - 8)')
  assert.deepEqual({ ...api.pollPillPosition() }, { x: 1016, y: 760 })

  // Negative deltas clamp at the top-left margin too.
  pointer(window, pill, 'pointerdown', 300, 300)
  pointer(window, pill, 'pointermove', -2000, -2000)
  pointer(window, pill, 'pointerup', -2000, -2000)
  assert.equal(pill.style.left, '8px')
  assert.equal(pill.style.top, '8px')
})

test('pointerdown on an interactive control never starts a pill drag', () => {
  const { document, api, window } = boot()
  const pill = document.querySelector('#dsh-pt-root')
  api.setPillPosition({ x: 100, y: 100 })
  const targets = [
    document.querySelector('#dsh-pt-compose-input'),
    document.querySelector('#dsh-pt-compose-tone'),
    document.querySelector('#dsh-pt-compose-send'),
  ]
  for (const target of targets) {
    pointer(window, target, 'pointerdown', 120, 120)
    pointer(window, target, 'pointermove', 900, 900)
    pointer(window, target, 'pointerup', 900, 900)
    assert.equal(pill.style.left, '100px', target.id + ' keeps its native pointer behaviour')
    assert.equal(pill.style.top, '100px')
  }
  assert.equal(api.pollPillPosition(), null, 'no drag was reported')
})

test('the renderer position hint restores the pill and setPillPosition clamps it', () => {
  const { document, api } = bootWithHint({ x: 40, y: 50 })
  const pill = document.querySelector('#dsh-pt-root')
  assert.equal(pill.style.left, '40px', 'saved left is restored on install')
  assert.equal(pill.style.top, '50px')
  assert.equal(pill.style.right, 'auto')
  assert.deepEqual({ ...api.pillPosition() }, { x: 40, y: 50 })

  assert.equal(api.setPillPosition({ x: -100, y: 5000 }), true)
  assert.deepEqual({ ...api.pillPosition() }, { x: 8, y: 760 }, 'restored/clamped positions honour the margin')
  assert.equal(pill.style.left, '8px')
  assert.equal(pill.style.top, '760px')

  assert.equal(api.setPillPosition(null), false, 'garbage input is a no-op')
  assert.deepEqual({ ...api.pillPosition() }, { x: 8, y: 760 })
})

test('a viewport resize re-clamps a dragged pill', () => {
  const { document, api, window } = boot()
  const pill = document.querySelector('#dsh-pt-root')
  api.setPillPosition({ x: 900, y: 600 })
  assert.deepEqual({ ...api.pillPosition() }, { x: 900, y: 600 })
  Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true })
  window.dispatchEvent(new window.Event('resize'))
  assert.deepEqual({ ...api.pillPosition() }, { x: 492, y: 392 }, 'resize clamps into the smaller viewport')
  assert.equal(pill.style.left, '492px')
  assert.equal(pill.style.top, '392px')
})

test('the reply panel anchors to the dragged pill instead of the corner', () => {
  const { document, api } = boot()
  const pill = document.querySelector('#dsh-pt-root')
  api.setPillPosition({ x: 100, y: 100 })
  api.composeResult('The grain in this shot is gorgeous.')
  const panel = document.querySelector('#dsh-pt-compose-panel')
  assert.ok(panel, 'result panel exists')
  assert.equal(panel.style.display, 'block')
  assert.equal(panel.style.right, 'auto', 'the panel is no longer pinned to the right corner')
  assert.equal(panel.style.bottom, 'auto')
  assert.equal(panel.style.left, '100px', 'panel aligns with the pill horizontally')
  assert.equal(panel.style.top, '92px', 'panel sits just above the pill (100 - 8px gap)')

  // Pure placement: flips below when there is no room above.
  const hooks = document.defaultView.__DSH_PT_TEST_HOSTED__
  assert.ok(hooks, 'pure position helpers are exposed for tests')
  assert.deepEqual({ ...hooks.clampPillPosition(-10, 900, 300, 34, 1024, 768, 8) }, { x: 8, y: 726 })
  const above = hooks.computePanelPlacement({ left: 100, top: 700, width: 200, height: 34 }, 380, 200, 1024, 768, 8, 8)
  assert.equal(above.side, 'above')
  assert.equal(above.left, 100)
  assert.equal(above.top, 492)
  const below = hooks.computePanelPlacement({ left: 100, top: 20, width: 200, height: 34 }, 380, 200, 1024, 768, 8, 8)
  assert.equal(below.side, 'below', 'no room above flips the panel below the pill')
  assert.equal(below.top, 62)
  assert.equal(hooks.dragThreshold, 5)
})
