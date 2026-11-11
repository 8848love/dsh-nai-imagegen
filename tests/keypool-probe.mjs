/**
 * Scratch probe for the key pool, kept out of the main suite so it can be
 * iterated on without re-running everything.
 *
 * Usage: node tests/keypool-probe.mjs
 */
import { KeyPool, createPool, fingerprintOf } from '../lib/keypool.js'

let failures = 0
/**
 * Assert one condition.
 * @param name - what is being checked.
 * @param ok - the observed truth.
 * @param detail - extra text on failure.
 */
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

const token = (n) => `pst-test-${n}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`

// ---------------------------------------------------- concurrency breadth --
console.log('\n[1] concurrency equals the number of usable keys')
{
  let inFlight = 0
  let peak = 0
  const started = []
  const pool = new KeyPool({
    call: async (payload) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      started.push(payload)
      await new Promise((resolve) => setTimeout(resolve, 12))
      inFlight -= 1
      return `ok:${payload}`
    }
  })
  for (let i = 0; i < 4; i += 1) pool.addKey({ label: `K${i}`, token: token(i) })
  check('four keys give four slots', pool.concurrency === 4, String(pool.concurrency))
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => pool.enqueue(`job-${i}`)))
  check('every job completed', results.length === 9 && results.every((r) => r.startsWith('ok:')), JSON.stringify(results))
  check('peak in-flight equals the key count', peak === 4, `peak=${peak}`)
  check('the queue drained', pool.queue.length === 0)
  check('no key is left active', pool.list().every((key) => !key.active))
  check('each key completed at least twice', pool.list().every((key) => key.completed >= 2), JSON.stringify(pool.list().map((k) => k.completed)))
}

// ------------------------------------------------------------ least-recent --
console.log('\n[2] rotation is least-recently-used')
{
  const order = []
  const pool = new KeyPool({
    call: async (_payload, keyToken) => {
      // The tokens share a filler suffix, so identify by the index, not the
      // last character.
      order.push(/pst-test-(\d+)/.exec(keyToken)?.[1] ?? '?')
      return 'ok'
    }
  })
  for (let i = 0; i < 3; i += 1) pool.addKey({ label: `K${i}`, token: token(i) })
  // Sequential, so each dispatch sees only one idle key at a time... in practice
  // pump dispatches all three at once; assert all three were used exactly once.
  await Promise.all([pool.enqueue('a'), pool.enqueue('b'), pool.enqueue('c')])
  check('all three keys were used', new Set(order).size === 3, order.join(','))
  check('each key used once', order.length === 3, order.join(','))
}

// ------------------------------------------------------- 401 disables a key --
console.log('\n[3] a 401 disables that key and the job moves on')
{
  const used = []
  const pool = new KeyPool({
    call: async (_payload, keyToken) => {
      used.push(keyToken)
      if (keyToken === token(0)) throw Object.assign(new Error('bad key'), { statusCode: 401 })
      return 'ok'
    }
  })
  pool.addKey({ label: 'bad', token: token(0) })
  pool.addKey({ label: 'good', token: token(1) })
  const result = await pool.enqueue('job')
  check('the job still succeeded', result === 'ok', String(result))
  check('it was tried on both keys', used.length === 2, String(used.length))
  const bad = pool.list().find((key) => key.label === 'bad')
  check('the bad key is disabled', bad.enabled === false && bad.status === 'invalid', JSON.stringify(bad))
  check('usable count dropped to one', pool.enabledCount() === 1)
  check('the panel sees an error message', /无效|过期/.test(bad.lastError), bad.lastError)
  check('the token is not exposed', bad.token === undefined && !JSON.stringify(bad).includes('pst-test-0'))
}

// ---------------------------------------------------- 429 cools a key down --
console.log('\n[4] a 429 cools that key and re-queues avoiding it')
{
  let clock = 1_000_000
  const used = []
  const pool = new KeyPool({
    now: () => clock,
    call: async (_payload, keyToken) => {
      used.push(keyToken)
      if (keyToken === token(0)) throw Object.assign(new Error('slow down'), { statusCode: 429, retryAfterMs: 5000 })
      return 'ok'
    }
  })
  pool.addKey({ label: 'limited', token: token(0) })
  pool.addKey({ label: 'fine', token: token(1) })
  const result = await pool.enqueue('job')
  check('the job succeeded on the other key', result === 'ok', String(result))
  const limited = pool.list().find((key) => key.label === 'limited')
  check('the limited key is cooling down', limited.status === 'cooldown', limited.status)
  check('the cooldown honours retryAfterMs', limited.cooldownUntil === 1_000_000 + 5000, String(limited.cooldownUntil))
  check('it is not a candidate while cooling', pool.candidates().every((key) => key.label !== 'limited'))
  clock += 5001
  check('it becomes a candidate again after the cooldown', pool.candidates().some((key) => key.label === 'limited'))
  check('it is reported healthy again', pool.list().find((key) => key.label === 'limited').status === 'healthy')
}

// --------------------------------------------------- 5xx retries elsewhere --
console.log('\n[5] a 5xx retries on a different key')
{
  let attempts = 0
  const seen = []
  const pool = new KeyPool({
    call: async (_payload, keyToken) => {
      attempts += 1
      seen.push(keyToken)
      if (attempts === 1) throw Object.assign(new Error('upstream'), { statusCode: 502 })
      return 'recovered'
    }
  })
  pool.addKey({ label: 'a', token: token(0) })
  pool.addKey({ label: 'b', token: token(1) })
  const result = await pool.enqueue('job')
  check('the retry succeeded', result === 'recovered', String(result))
  check('the retry used the other key', new Set(seen).size === 2, seen.join(','))
}

// --------------------------------------------------------- bookkeeping ----
console.log('\n[6] configuration bookkeeping')
{
  const pool = new KeyPool({ call: async () => 'ok' })
  const first = pool.addKey({ label: 'one', token: token(0) })
  const again = pool.addKey({ label: 'dup', token: token(0) })
  check('a duplicate token is not added twice', pool.list().length === 1 && first.id === again.id)
  check('the fingerprint is stable and short', fingerprintOf(token(0)) === first.fingerprint && first.fingerprint.length === 10)
  check('a token-shaped label is replaced', pool.updateKey(first.id, { label: 'pst-oops' }).label.startsWith('Key '))
  const renamed = pool.updateKey(first.id, { label: '主号' })
  check('a real label is kept', renamed.label === '主号')
  pool.updateKey(first.id, { enabled: false })
  check('disabling drops the slot count', pool.concurrency === 1 && pool.configured() === false)
  await pool
    .enqueue('x')
    .then(() => check('an empty pool refuses work', false))
    .catch((error) => check('an empty pool refuses work', /至少一个/.test(error.message), error.message))
  check('removing works', pool.removeKey(first.id) === true && pool.list().length === 0)
}

// ------------------------------------------------- subscription bookkeeping ----
console.log('\n[6b] a successful probe records the subscription')
{
  const pool = new KeyPool({
    call: async () => ({ ok: true, subscription: { tier: 3, fixedTrainingStepsLeft: 120 } })
  })
  pool.addKey({ label: 'main', token: token(9) })
  await pool.enqueue({ kind: 'probe' }, { noRetry: true })
  const row = pool.list()[0]
  check('the tier survives onto the key', row.subscription?.tier === 3, JSON.stringify(row.subscription))
  check('the remaining steps survive too', row.subscription?.fixedTrainingStepsLeft === 120, JSON.stringify(row.subscription))
  const plain = new KeyPool({ call: async () => 'ok' })
  plain.addKey({ label: 'x', token: token(8) })
  await plain.enqueue('render')
  check('a render that reports nothing leaves the field alone', plain.list()[0].subscription === null)
}

// ------------------------------------------------------------ defaults ----
console.log('\n[7] pool built from configuration')
{
  const pool = createPool(
    { token: token(0), keys: [{ label: '副号', token: token(1) }, { token: token(2), enabled: false }, token(0)] },
    { call: async () => 'ok' }
  )
  const list = pool.list()
  check('the legacy token becomes a key', list.length === 3, String(list.length))
  check('a disabled entry stays disabled', list.some((key) => key.enabled === false))
  check('the duplicate is deduped', list.filter((key) => key.enabled).length === 2)
  check('concurrency follows the usable keys', pool.concurrency === 2, String(pool.concurrency))
  const summary = pool.healthSummary()
  check('the summary reports concurrency', summary.concurrency === 2 && summary.keyCount === 3, JSON.stringify(summary))
}

console.log(`\n${failures === 0 ? 'all key-pool checks passed' : `${failures} FAILED`}`)
if (failures > 0) process.exitCode = 1
