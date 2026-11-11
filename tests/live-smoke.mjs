/**
 * Real-call smoke test for dsh-nai-imagegen.
 *
 * Runs the plugin's own library code against the live NovelAI API — no stub, no
 * mocking. The token arrives through the environment and is never printed, never
 * written to disk by this script, and never echoed in an error message.
 *
 * Shape of the run:
 *   1. probe  — reads the subscription record (spends nothing)
 *   2. render — one 832x1216 @28-step image, the Opus free band
 *   3. probe  — again, to report the Anlas delta from the training-step counter
 *
 * Usage:  NAI_TOKEN=… node tests/live-smoke.mjs [outputDir]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { metadataOf, persist, probe, generate, proxyFor } from '../lib/nai.js'

const token = (process.env.NAI_TOKEN ?? '').trim()
if (!token) {
  console.error('NAI_TOKEN is not set')
  process.exit(2)
}

const baseUrl = process.env.NAI_BASE ?? 'https://image.novelai.net'
const outputDir = process.argv[2] ?? join(process.cwd(), '_out', 'nai')
// The point of the tunnel: no launch-time flags. `NAI_PROXY` can force a value
// or `off`; otherwise the machine's own system proxy is used.
const proxy = proxyFor({ proxy: process.env.NAI_PROXY ?? 'auto' })
console.log(`proxy: ${proxy ?? '(direct connection)'}`)

/** Render the subscription reading as a short line. */
const describe = (result) => {
  if (!result.ok) return `${result.stage}: ${result.detail}`
  const s = result.subscription ?? {}
  const steps = (s.fixedTrainingStepsLeft ?? 0) + (s.purchasedTrainingStepsLeft ?? 0)
  return `ok  tier=${s.tier}  steps=${steps}  usage=${s.usagePercent}%  (HTTP ${result.status})`
}

// ------------------------------------------------------------------ probe --
console.log('=== 1. probe (spends nothing) ===')
const before = await probe({ baseUrl, token, proxy })
console.log(`  ${describe(before)}`)
if (!before.ok) {
  console.error('  probing failed; not attempting a render')
  process.exit(1)
}

// ----------------------------------------------------------------- render --
// A transparent-background tachie of 橘光, using the roster's official tag, the
// petite-body correction the project insists on, and a negative that keeps her
// distinct from her twin (twintails belong to 橘望).
const prompt = [
  '1girl, solo, single character',
  'full body, full body shot, entire body visible, head to toe, feet visible',
  'hikari \\(blue_archive\\)',
  'green hair, yellow eyes, pointy ears, long hair, green halo, demon tail',
  'military uniform, peaked cap, black hat, white gloves, long sleeves, white pantyhose',
  'petite, small breasts',
  'standing, looking at viewer, slight smile, blush',
  '1.3::full body::',
  'transparent background, alpha transparency, has alpha'
].join(', ')

const negativePrompt = [
  'huge breasts, large breasts, voluptuous, wide hips, mature female, twintails',
  'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit',
  'fewer digits, cropped, worst quality, low quality, jpeg artifacts',
  'signature, watermark, username, blurry'
].join(', ')

const request = {
  prompt,
  negativePrompt,
  model: process.env.NAI_MODEL ?? 'nai-diffusion-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  sampler: 'k_euler_ancestral',
  ucPreset: 3,
  nSamples: 1
}

console.log('\n=== 2. render (832x1216 @28 steps — the free band) ===')
console.log(`  model  ${request.model}`)
console.log(`  prompt ${prompt.slice(0, 150)}…`)
const started = Date.now()
let images
try {
  images = await generate({ baseUrl, token, proxy, ...request })
} catch (error) {
  console.error(`  render failed: ${error.message}`)
  process.exit(1)
}
console.log(`  received ${images.length} image(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`  first bytes: ${images[0].subarray(0, 8).toString('hex')}`)

// ------------------------------------------------------------- provenance --
const meta = metadataOf(images[0])
console.log('\n=== 3. provenance read back out of the PNG ===')
console.log(`  software ${meta.software}`)
console.log(`  model    ${meta.model}`)
console.log(`  seed     ${meta.seed}`)
console.log(`  steps    ${meta.steps}`)
console.log(`  size     ${meta.width}x${meta.height}`)
console.log(`  scale    ${meta.scale}`)

// ------------------------------------------------------------------ write --
await mkdir(outputDir, { recursive: true })
const written = await persist({ outputDir, images, request })
console.log('\n=== 4. written ===')
for (const file of written) console.log(`  ${file.file}  ${file.bytes} bytes`)

// ------------------------------------------------------------ alpha check --
// "transparent background" is the whole point of this render, so the alpha
// channel is inspected rather than trusted.
const { inflateSync } = await import('node:zlib')
let offset = 8
let colourType = null
let ihdrWidth = 0
let ihdrHeight = 0
while (offset + 8 <= images[0].length) {
  const length = images[0].readUInt32BE(offset)
  const type = images[0].toString('ascii', offset + 4, offset + 8)
  if (type === 'IHDR') {
    ihdrWidth = images[0].readUInt32BE(offset + 8)
    ihdrHeight = images[0].readUInt32BE(offset + 12)
    colourType = images[0][offset + 17]
  }
  if (type === 'IEND') break
  offset += 12 + length
}
console.log('\n=== 5. PNG structure ===')
console.log(`  IHDR ${ihdrWidth}x${ihdrHeight}  colourType=${colourType} (6 = truecolour with alpha)`)

// ------------------------------------------------------------------ delta --
console.log('\n=== 6. probe again (Anlas delta) ===')
const after = await probe({ baseUrl, token, proxy })
console.log(`  ${describe(after)}`)
const stepsOf = (result) => {
  const s = result.subscription ?? {}
  return (s.fixedTrainingStepsLeft ?? 0) + (s.purchasedTrainingStepsLeft ?? 0)
}
if (before.ok && after.ok) {
  console.log(`  training steps: ${stepsOf(before)} -> ${stepsOf(after)}  (delta ${stepsOf(after) - stepsOf(before)})`)
}

await writeFile(join(outputDir, 'last-run.txt'), `${written.map((f) => f.file).join('\n')}\n`, 'utf8')
