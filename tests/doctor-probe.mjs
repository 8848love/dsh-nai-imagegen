#!/usr/bin/env node
/**
 * Run the capability doctor against the live configuration, from the test suite.
 *
 * The doctor is otherwise reachable only through `nai_doctor`, which runs inside the
 * DSH process — and that process holds whatever modules it loaded at start-up. So a
 * change to the doctor itself is checkable only by restarting DSH, which is exactly
 * the situation the doctor exists to report ("code is newer than the process"). This
 * runs the same checks out of process, so a broken check is caught before the restart
 * rather than after it.
 *
 * Read-only, like the doctor: it renders nothing, spends nothing, writes nothing.
 * Run with `--quiet` to print only the total.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { MODE_NAMES, load, outputDirOf } from '../lib/config.js'
import { proxyFor } from '../lib/nai.js'
import { listLibraries, lookup, resolveCharacter } from '../lib/library.js'
import { digest } from '../lib/util.js'
import { loadIndex, readArtistImage, searchArtists } from '../lib/artists.js'
import { createPool } from '../lib/keypool.js'
import { runDoctor } from '../lib/doctor.js'

let passed = 0
const failures = []
const ok = (name, theAnswer, detail = '') => {
  if (theAnswer === true) passed += 1
  else failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * The host's `settingsFor`, replicated.
 *
 * Deliberately duplicated rather than exported from `index.js`: that module imports
 * `defineTool` and registers onto a live DSH context on load, so importing it here
 * would drag the whole host half into the suite.
 *
 * @param config - the loaded configuration.
 * @param mode - `illustration` or `comic`.
 * @returns the effective settings for that mode.
 */
function modeSettingsFor(config, mode) {
  const overrides = (config.modes ?? {})[mode] ?? {}
  const pick = (field) => (overrides[field] === undefined || overrides[field] === null ? config[field] : overrides[field])
  return {
    mode,
    artistId: overrides.artistId ?? config.artistId,
    width: pick('width'),
    height: pick('height'),
    steps: pick('steps'),
    scale: pick('scale'),
    ucPreset: pick('ucPreset'),
    model: pick('model'),
    sampler: pick('sampler'),
    negativePrompt: pick('negativePrompt'),
    maxImagesPerCall: overrides.maxImagesPerCall ?? config.maxImagesPerCall,
    recipe: overrides.recipe ?? null
  }
}

const config = await load()
const report = await runDoctor({
  config,
  // A pool is part of the surface being checked, but the doctor must never spend a
  // render on it, so the call is a tripwire rather than a real request.
  pool: createPool(
    { token: String(config.token ?? ''), keys: config.keys ?? [] },
    {
      call: () => {
        throw new Error('the doctor must not render')
      }
    }
  ),
  proxy: proxyFor(config),
  loadIndex,
  searchArtists,
  readArtistImage,
  listLibraries,
  lookup,
  resolveCharacter,
  digest,
  clientSource: await readFile(new URL('../client.js', import.meta.url), 'utf8').catch(() => ''),
  outputDir: await outputDirOf(config),
  packageRoot: fileURLToPath(new URL('..', import.meta.url)),
  modeSettings: MODE_NAMES.map((name) => modeSettingsFor(config, name))
})

// The count is asserted, not just the outcome: as the suite grows the doctor is the
// single place a new capability is registered, and a check that silently stopped
// running would still leave `ok` true.
ok('the doctor reports a full sweep of checks', report.checks.length >= 70, String(report.checks.length))
ok('the doctor found no duplicate check names', new Set(report.checks.map((row) => row.name)).size === report.checks.length)
for (const row of report.checks) ok(`doctor: ${row.name}`, row.ok, row.detail)
ok(
  'the doctor passes end to end',
  report.ok === true,
  report.checks.filter((row) => !row.ok).map((row) => row.name).join(', ')
)
ok('the doctor reports the real config', typeof config === 'object' && config !== null)

if (!process.argv.includes('--quiet')) {
  for (const row of report.checks) {
    console.log(`${row.ok ? '  ok  ' : ' FAIL '} ${row.name}${row.detail === '' ? '' : `  (${row.detail})`}`)
  }
}
console.log(`\n${passed} passed, ${failures.length} failed`)
for (const line of failures) console.log(`  FAIL ${line}`)
process.exit(failures.length === 0 ? 0 : 1)
