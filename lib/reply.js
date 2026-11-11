/**
 * dsh-nai-imagegen — the reply tool.
 *
 * Why a tool at all. The answer area of a turn is painted by the browser half, and the
 * browser half can only read what a tool call carries: an assistant message whose content
 * is ordinary text renders its text, but a message that carries none — a turn spent
 * calling tools and nothing else — is a turn whose answer area stays empty. So the mandate
 * lives in this tool's own description (it is registered, so its schema goes into the
 * system prompt with every other tool's) and the call is the delivery: the model writes
 * the answer into `text`, and the browser half lifts it out of the call and paints it into
 * the turn it belongs to.
 *
 * Why nothing is written. The tool's whole point is that the text goes *out* to the client
 * and nowhere else: no file, no route of its own, no journal. The ledger below keeps
 * counts, a label and a digest — never the prose — so `/status` can answer "did a reply go
 * through, and how big was it" without this half becoming a second copy of the
 * conversation. The call itself is already in the session log because the model made it;
 * storing it again here would be exactly the write the feature exists to avoid.
 */

import { createHash } from 'node:crypto'
import { defineTool } from './tool.js'

/**
 * The wire name of the reply tool.
 *
 * The browser half registers its row view under the same string, and the two are compared
 * by the doctor: a name that drifts is a silent failure in both directions — a host tool
 * nobody renders, and a client view for a name no tool has.
 */
export const REPLY_TOOL_NAME = 'nai_reply'

/** How many replies the host keeps metadata about. */
export const REPLY_LEDGER_LIMIT = 20

/** Above this a caption is cut, because it rides the collapsed row's one line. */
export const REPLY_LABEL_MAX = 60

/**
 * What the model is told, which is the whole mechanism.
 *
 * Written as a mandate rather than a description because that is what it is: the reader
 * does not see message text in a tool-only turn, and a model that does not know this writes
 * a reply into a place nobody is looking. The last sentence is the honest one — no file, no
 * request — so that a model which would rather not hand its answer to a tool can see there
 * is nothing being written down.
 */
export const REPLY_TOOL_DESCRIPTION =
  'Deliver this turn\u2019s reply. The reader sees what this call carries and nothing else: ' +
  'an assistant turn whose only content is message text renders with an empty answer area, ' +
  'so a reply written in the message body is a reply nobody can read. ' +
  'Call this exactly once per reply, with the whole thing — every paragraph, list and code ' +
  'block — inside `text`, and do not repeat it in the message body. ' +
  '`text` is Markdown: headings, lists, fenced code, tables, links, `code`, **emphasis** and ' +
  '~~strikethrough~~ are rendered in the reply window. ' +
  'Nothing is written to disk and no request leaves the host: the text is measured, hashed ' +
  'and dropped when this returns, and the browser half paints it into the turn it belongs to.'

/** Metadata of every reply this process has been handed, newest first. Never the prose. */
const ledger = []
/** How many replies this process has taken, including the ones aged out of `ledger`. */
let replySeq = 0
/** Characters delivered over this process's whole life. */
let replyChars = 0

/**
 * Count a reply the way a reader would.
 *
 * Characters are counted as code points, so an emoji or a rare Han character is one and not
 * two — the number is shown to the user as "how much text arrived", and a count that
 * disagrees with what they can see is worse than no count. Lines ignore a trailing newline,
 * for the same reason: a model that ends its reply with one wrote the lines above it.
 *
 * @param text - the reply body.
 * @returns `{ chars, lines }`.
 */
export function summarizeReply(text) {
  const body = typeof text === 'string' ? text : ''
  const chars = Array.from(body).length
  const trimmed = body.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  const lines = trimmed === '' ? 0 : trimmed.split('\n').length
  return { chars, lines }
}

/**
 * A short digest of a reply's text.
 *
 * Kept so a delivered reply can be recognized again — the same words produce the same
 * digest, and the browser half can be asked whether it is holding that text — without this
 * half keeping the words themselves.
 *
 * @param text - the reply body.
 * @returns twelve hex characters of its SHA-256.
 */
export function replySha(text) {
  return createHash('sha256')
    .update(typeof text === 'string' ? text : '', 'utf8')
    .digest('hex')
    .slice(0, 12)
}

/**
 * Remember that a reply went through — its size, its caption and its digest.
 *
 * @param text - the reply body.
 * @param label - the model's optional one-line caption.
 * @returns the entry as it was recorded.
 */
export function recordReply(text, label) {
  const body = typeof text === 'string' ? text : ''
  const { chars, lines } = summarizeReply(body)
  const caption = typeof label === 'string' ? label.trim() : ''
  const entry = {
    seq: (replySeq += 1),
    at: new Date().toISOString(),
    chars,
    lines,
    sha: replySha(body),
    label: caption === '' ? null : Array.from(caption).slice(0, REPLY_LABEL_MAX).join(''),
    blank: body.trim() === ''
  }
  replyChars += chars
  ledger.unshift(entry)
  if (ledger.length > REPLY_LEDGER_LIMIT) ledger.length = REPLY_LEDGER_LIMIT
  return entry
}

/**
 * The reply ledger, as `/status` reports it.
 *
 * Every field is a number, a timestamp, a digest or the model's own caption — the shape is
 * the promise that this half cannot leak a reply it was handed.
 *
 * @returns the summary plus the remembered entries.
 */
export function replyLedger() {
  const newest = ledger[0] ?? null
  return {
    count: replySeq,
    remembered: ledger.length,
    totalChars: replyChars,
    lastAt: newest?.at ?? null,
    lastChars: newest?.chars ?? 0,
    lastLines: newest?.lines ?? 0,
    lastSha: newest?.sha ?? null,
    lastLabel: newest?.label ?? null,
    entries: ledger.map((entry) => ({ ...entry }))
  }
}

/**
 * Forget every reply this process has taken.
 *
 * For tests and for a restart of the bookkeeping, not for a session: nothing else calls it,
 * and calling it mid-session would only make `/status` look younger than the process.
 */
export function resetReplies() {
  ledger.length = 0
  replySeq = 0
  replyChars = 0
}

/**
 * Build the tool the host registers.
 *
 * The body validates what it cannot record honestly — an empty reply is not a reply — and
 * otherwise does nothing but count. Its result is a receipt: the model needs to know the
 * text arrived whole, and the number is the only way it can check.
 *
 * @returns the registry-ready definition.
 */
export function createReplyTool() {
  return defineTool({
    name: REPLY_TOOL_NAME,
    description: REPLY_TOOL_DESCRIPTION,
    parameters: {
      text: {
        type: 'string',
        required: true,
        description:
          'The whole reply, as Markdown. Every paragraph belongs here; a reply split across several calls reads as several replies.'
      },
      label: {
        type: 'string',
        description:
          'Optional one-line caption for the collapsed row (60 characters at most), e.g. “三张图已出好”. Never a substitute for `text`.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          chars: { type: 'integer' },
          lines: { type: 'integer' },
          sha: { type: 'string' }
        },
        required: ['ok', 'chars', 'lines', 'sha']
      },
      render: (_args, value) => [
        { type: 'text', text: `已送达回复窗口：${value.chars} 字 / ${value.lines} 行　sha ${value.sha}　（未写任何文件）` }
      ]
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const text = typeof args.text === 'string' ? args.text : ''
      if (text.trim() === '') {
        throw new Error(`${REPLY_TOOL_NAME}: text 是空的 —— 这一轮的回复正文要整段放进 text，空字符串等于没有回复。`)
      }
      const entry = recordReply(text, args.label)
      return { ok: true, chars: entry.chars, lines: entry.lines, sha: entry.sha }
    }
  })
}
