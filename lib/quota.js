/**
 * dsh-nai-imagegen — NovelAI membership, Anlas balance and V5 free quota.
 *
 * One official request answers both questions: `GET /user/subscription` carries
 * the membership record *and* the V5 usage meter, so a render-free probe can
 * report the whole picture at once.
 *
 * Every rule below exists because the plausible alternative is a confident
 * wrong number:
 *
 *   - Anlas is `fixedTrainingStepsLeft + purchasedTrainingSteps`. It is **not**
 *     the V5 free image count, and it is not `priority`, `taskPriority` or
 *     `maxPriorityActions`. One unknown component makes the total unknown —
 *     `Number(value) || 0` would turn `""`, `false` and `null` into a
 *     confident "0 Anlas".
 *   - `usage.percent` may exceed 100, and may be negative (`isNegative`). The
 *     text keeps the real percentage; only the progress bar clamps.
 *   - `usage.timeUntilNextPercent` is a **duration in seconds** for the next
 *     single percent — not a timestamp, and not a countdown to a whole percent.
 *   - `17.3` images per percent is the official display estimate of the day it
 *     was measured, not a promise about any parameter set: everything derived
 *     from it is marked `estimated` and never used to gate a render.
 *   - An unavailable quota renders as *unknown*, never as "0 images left".
 *
 * The upstream specification is shipped with this package as
 * `NOVELAI-SUBSCRIPTION-QUOTA-REPLICATION.md`; §2–§5 of it are the source of
 * the field rules and of the multi-key aggregation contract.
 */

/** Estimated free images per percent, as displayed by the official site. */
export const V5_IMAGE_COEFFICIENT = 17.3
/** The model the free band belongs to. */
export const V5_MODEL = 'nai-diffusion-5-full'
/** Human-facing model version of that band. */
export const V5_MODEL_VERSION = '5.0'
/** Marks a quota as coming from the subscription record, not from a task. */
export const QUOTA_SOURCE = 'subscription-usage'
/** Below this a Unix timestamp is read as seconds, above it as milliseconds. */
const MS_THRESHOLD = 1e12
/** Seconds in a day, for the recovery estimate. */
const DAY_SECONDS = 86400

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * Read one Anlas component.
 *
 * Accepts a finite number or a non-empty numeric string and rejects booleans,
 * arrays, objects and blanks — those must stay "unknown" rather than collapse
 * into a zero balance.
 *
 * @param value - the raw field.
 * @returns the balance, clamped at zero, or `null` when it is unknown.
 */
export function normalizeAnlas(value) {
  const parsed = isFiniteNumber(value)
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, parsed)
}

/**
 * Read an expiry stamp.
 *
 * The official record uses Unix **seconds**; a value that is already in
 * milliseconds passes through untouched.
 *
 * @param value - the raw field.
 * @returns milliseconds since the epoch, or `null`.
 */
export function normalizeExpiry(value) {
  const parsed = isFiniteNumber(value)
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  return parsed < MS_THRESHOLD ? parsed * 1000 : parsed
}

/**
 * Normalize the V5 free quota out of a subscription record.
 *
 * The four gates are checked in order, because each one means something
 * different to the person reading the panel: no subscription, a tier without
 * the free band, a record without a usage meter, and a usage meter whose fields
 * cannot be trusted. All four answer `unavailable` with a `reason`; only a
 * valid, actually-zero quota says `0`.
 *
 * @param subscription - the parsed subscription record.
 * @param now - the read time, for `refreshedAt`.
 * @returns the normalized quota.
 */
export function normalizeQuota(subscription, now = Date.now()) {
  const base = {
    modelVersion: V5_MODEL_VERSION,
    model: V5_MODEL,
    source: QUOTA_SOURCE,
    refreshedAt: now
  }
  const unavailable = (reason) => ({ ...base, status: 'unavailable', reason })
  if (subscription?.active === false) return unavailable('inactive')
  if (!isFiniteNumber(subscription?.tier) || subscription.tier < 3) return unavailable('non-opus')
  const usage = subscription?.usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return unavailable('missing-usage')
  if (!isFiniteNumber(usage.percent) || typeof usage.isNegative !== 'boolean') {
    return unavailable('invalid-usage')
  }
  const remainingPercent = usage.isNegative ? 0 : Math.max(0, usage.percent)
  const seconds = usage.timeUntilNextPercent
  // A missing or unusable duration is *unknown* recovery, not a paused one, and
  // a real zero means recovery is paused right now.
  const dailyRefillPercent = isFiniteNumber(seconds)
    ? seconds <= 0
      ? 0
      : Math.round((DAY_SECONDS / seconds) * 10) / 10
    : null
  const remainingImages = Math.round(V5_IMAGE_COEFFICIENT * remainingPercent)
  const dailyRefillImages =
    dailyRefillPercent === null ? null : Math.round(V5_IMAGE_COEFFICIENT * dailyRefillPercent)
  if (!Number.isSafeInteger(remainingImages) || (dailyRefillImages !== null && !Number.isSafeInteger(dailyRefillImages))) {
    return unavailable('invalid-usage')
  }
  return {
    ...base,
    status: 'ok',
    remainingPercent,
    remainingImages,
    estimated: true,
    isNegative: usage.isNegative,
    timeUntilNextPercent: isFiniteNumber(seconds) ? seconds : null,
    dailyRefillPercent,
    dailyRefillImages
  }
}

/**
 * Normalize a whole subscription record: membership, Anlas and V5 quota.
 *
 * Returns `null` for a body that is not an object, because every caller here
 * treats "no subscription" as a state to display rather than an exception to
 * throw; the probe path must never fail because a record was unreadable.
 *
 * @param data - the parsed response body.
 * @param now - the read time.
 * @returns the normalized record, or `null`.
 */
export function normalizeSubscription(data, now = Date.now()) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const training = data.trainingStepsLeft
  const fixed = normalizeAnlas(training?.fixedTrainingStepsLeft ?? training?.fixedTrainingSteps)
  const purchased = normalizeAnlas(training?.purchasedTrainingSteps ?? training?.purchasedTrainingStepsLeft)
  // Both components or nothing: a one-sided total is a number the user would
  // read as their whole balance.
  const total = fixed === null || purchased === null ? null : fixed + purchased
  const tier = data.tier ?? data.subscriptionTier
  return {
    active: data.active !== false,
    tier: isFiniteNumber(tier) ? tier : null,
    expiresAt: normalizeExpiry(data.expiresAt ?? data.expires_at),
    fixedAnlas: fixed,
    purchasedAnlas: purchased,
    remainingAnlas: total !== null && Number.isFinite(total) ? total : null,
    v5Quota: normalizeQuota(data, now)
  }
}

/**
 * Add up what several keys know, without inventing anything.
 *
 * Percentages are never added across keys — several keys are not necessarily
 * several accounts — and only known image counts are summed. Zero known values
 * is `null` (unknown), not `0`.
 *
 * @param keys - per-key views carrying a `v5Quota`.
 * @returns the summary the panel and the route report.
 */
export function summarizeQuota(keys = []) {
  const list = Array.isArray(keys) ? keys : []
  let queried = 0
  let successful = 0
  let failed = 0
  let known = 0
  let images = 0
  let refreshedAt = null
  for (const key of list) {
    const quota = key?.v5Quota
    const status = typeof quota?.status === 'string' ? quota.status : 'unqueried'
    if (status !== 'unqueried') queried += 1
    if (status === 'ok' || status === 'unavailable') successful += 1
    if (status === 'error') failed += 1
    if (status === 'ok' && quota.source === QUOTA_SOURCE && Number.isFinite(quota.remainingImages)) {
      known += 1
      images += quota.remainingImages
    }
    if (isFiniteNumber(quota?.refreshedAt) && (refreshedAt === null || quota.refreshedAt > refreshedAt)) {
      refreshedAt = quota.refreshedAt
    }
  }
  return {
    keyCount: list.length,
    queriedKeyCount: queried,
    successfulKeyCount: successful,
    failedKeyCount: failed,
    knownRemainingKeyCount: known,
    remainingImages: known === 0 ? null : images,
    refreshedAt
  }
}

/** Why a quota is unavailable, in the words the panel and the tool use. */
export const QUOTA_REASON = {
  inactive: '订阅未生效',
  'non-opus': '非 Opus 档，没有 V5 免费额度',
  'missing-usage': '订阅记录里没有 usage 字段',
  'invalid-usage': '额度字段异常，读数不可信',
  unqueried: '尚未查询',
  error: '查询失败'
}

/**
 * One Chinese line for a quota, for the host-side tool text.
 *
 * The browser builds its own bilingual strings; this exists so `nai_probe` can
 * answer "how much free quota is left?" without the panel.
 *
 * @param quota - a normalized quota.
 * @returns the line.
 */
export function describeQuota(quota) {
  if (!quota || typeof quota !== 'object') return '额度：尚未查询'
  if (quota.status === 'error') {
    return `额度：查询失败${quota.code ? `（${quota.code}）` : ''}`
  }
  if (quota.status !== 'ok') {
    const reason = QUOTA_REASON[quota.reason] ?? quota.reason ?? '未知原因'
    return `额度：不可用（${reason}）`
  }
  const parts = [`额度：${quota.remainingPercent}%（约 ${quota.remainingImages} 张）`]
  if (quota.dailyRefillPercent === null) {
    parts.push('官方未返回恢复速度')
  } else if (quota.remainingPercent < 100 && quota.dailyRefillPercent > 0) {
    parts.push(`每日恢复 ${quota.dailyRefillPercent}%（约 ${quota.dailyRefillImages} 张）`)
  } else {
    parts.push('额度恢复暂停')
  }
  if (quota.isNegative) parts.push('已超额')
  return parts.join('，')
}
