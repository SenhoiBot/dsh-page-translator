/** Client-half tests: module descriptor, no panel/entry, built-in browser bridge. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * Load client.js with a fake module loader and run its apply with a fake context.
 * @returns {{disposers: Array<() => void>}}
 */
function loadClient() {
  const disposers = []
  const state = { descriptor: null }
  const window = {
    __ModuleLoader__: {
      load(descriptor) {
        state.descriptor = descriptor
      },
    },
  }
  const document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, textContent: '', remove() {}, style: {} }),
    head: { appendChild() {} },
    body: null,
  }
  const require = () => {
    throw new Error('client must not require any module')
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', 'document', source)(window, require, document)
  const descriptor = state.descriptor
  assert.ok(descriptor, 'module descriptor is registered')
  assert.equal(descriptor.id, '@local/dsh-page-translator')

  const module = descriptor.factory(require)
  assert.deepEqual(module.inject, [], 'no client services are needed')

  module.apply({
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  })
  return { disposers }
}

test('client module installs the built-in browser bridge only', () => {
  const { disposers } = loadClient()
  try {
    assert.ok(disposers.length >= 1, 'the webview observer effect is installed')
  } finally {
    for (const dispose of disposers) dispose()
  }
})

test('client module no longer registers a panel, sidebar entry or locale', () => {
  assert.ok(!/sidebar\.panellist/.test(source), 'no sidebar entry')
  assert.ok(!/ctx\.slots/.test(source), 'no slot registrations')
  assert.ok(!/locale/.test(source), 'no locale dictionaries')
  assert.ok(!/React|createElement/.test(source), 'no React UI is built')
})

test('client module speaks the webview + host-route contract', () => {
  assert.match(source, /webview\[data-sidebar-browser-frame="webview"\]/)
  assert.match(source, /executeJavaScript/)
  assert.match(source, /\/page-translator\/hosted\.js/)
  assert.match(source, /installBuiltinBrowserBridge/)
})

test('client module is a loader script, not an ES module', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.ok(!/^\s*import\s/m.test(source), 'no top-level ESM imports')
  assert.ok(!/\bexport\b/.test(source), 'no top-level ESM exports')
})
