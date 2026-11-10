/**
 * Static manifest checks that do not need the Harness: package metadata,
 * bundle patch, locale metadata, icon, and the zero-external-import rule.
 * Run: node test/manifest.mjs
 */
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const failures = []

async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL  ${name}`)
    console.error(error?.stack || error)
  }
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await check('package name ends in dsh-handoff-hub', () => {
  assert.match(pkg.name, /(?:^|\/)dsh-handoff-hub$/)
  assert.equal(pkg.type, 'module')
})

await check('entry, locale, icon and browser client are exported and shipped', () => {
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.ok(pkg.exports['./locale/*.json'])
  for (const required of ['index.js', 'client.js', 'lib', 'cordis.patch.yml', 'locale', 'icon.svg', 'README.md']) {
    assert.ok(pkg.files.includes(required), `files must include ${required}`)
  }
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
})

await check('bundle patch inserts one matching row', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /-\s*insert:/)
  assert.match(patch, /id:\s*handoff-hub/)
  assert.ok(patch.includes(`name: '${pkg.name}'`), `patch must name ${pkg.name}`)
  assert.match(patch, /directory:\s*'work\/handoff'/)
})

await check('locale files carry plugin metadata', async () => {
  for (const locale of ['en', 'zh']) {
    const document = JSON.parse(await readFile(join(root, 'locale', `${locale}.json`), 'utf8'))
    assert.equal(typeof document.meta?.title, 'string')
    assert.ok(document.meta.title.length > 0)
    assert.equal(typeof document.meta?.description, 'string')
    assert.ok(document.meta.description.length > 0)
  }
})

await check('icon is an SVG within the 256 KiB limit', async () => {
  const info = await stat(join(root, 'icon.svg'))
  assert.ok(info.size >= 32 && info.size <= 256 * 1024, `icon size ${info.size}`)
  const text = await readFile(join(root, 'icon.svg'), 'utf8')
  assert.match(text, /<svg[\s>]/)
})

await check('runtime files import only Node built-ins and local modules', async () => {
  const files = [
    'index.js',
    'lib/room.js',
    'lib/util.js',
    'lib/config.js',
    'lib/prompts.js',
    'lib/watch.js',
    'lib/panel.js'
  ]
  for (const file of files) {
    const source = await readFile(join(root, file), 'utf8')
    for (const match of source.matchAll(/^\s*import\s[^\n]*?from\s+['"]([^'"]+)['"]/gm)) {
      const specifier = match[1]
      const allowed = specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')
      assert.ok(allowed, `${file} imports non-local module ${specifier}`)
    }
  }
})

await check('browser client registers the package id and both panel slots', async () => {
  const source = await readFile(join(root, 'client.js'), 'utf8')
  assert.ok(source.includes(`id: '${pkg.name}'`), `client loader id must be ${pkg.name}`)
  assert.ok(source.includes('__ModuleLoader__.load'))
  assert.ok(source.includes("name: 'sidebar.panellist'"))
  assert.ok(source.includes("name: 'main'"))
  assert.ok(source.includes("key: 'handoff-hub'"))
  assert.ok(!/^\\s*import\\s/m.test(source), 'client.js must stay a plain loader factory')
})

await check('README documents the four tools and the room layout', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  for (const name of ['handoff_board', 'handoff_join', 'handoff_nudge', 'handoff_leave']) assert.ok(readme.includes(name), name)
  assert.ok(readme.includes('.handoff-hub'))
  assert.ok(readme.includes('work/handoff'))
})

if (failures.length > 0) {
  console.error(`\n${failures.length} manifest check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nALL MANIFEST CHECKS PASSED')
}
