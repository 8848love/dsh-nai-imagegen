/**
 * dsh-nai-imagegen — a local stand-in for the host's `defineTool`.
 *
 * Why this exists instead of `import { defineTool } from '@deepseek-ai/dsh-tools'`:
 *
 * a `link:`-installed bundle cannot resolve host packages. The profile's
 * `node_modules` does not carry them (its `pnpm-workspace.yaml` sets
 * `autoInstallPeers: false`, and non-peer dependencies do not pull
 * `@deepseek-ai/dsh-tools` in), and whatever host-module mapping the launcher
 * installs did not reach this package. The failure is not subtle: the Loader
 * reports
 *
 *     nai-imagegen (dsh-nai-imagegen): failed to import
 *
 * and the whole plugin — tools and panel alike — goes with it.
 *
 * The workspace's proven-working hand-written bundle (`bundle-chat-delete`)
 * imports nothing from the host for this reason. This module is what makes that
 * possible here while keeping the ergonomics.
 *
 * The host helper does two things this reproduces:
 *
 *   1. expand the argument shorthand into the JSON Schema the model is shown,
 *   2. validate arguments before the body runs.
 *
 * It additionally carries presentation hooks (`presentCall`, `projectContent`,
 * `finalizeContent`, `isConcurrencySafe`, `deferLoading`, `timeoutMs`) that this
 * plugin does not use, so they are deliberately absent rather than stubbed.
 */

/** Primitive shape checks, mirroring the host's post-expansion validation. */
const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  array: (value) => Array.isArray(value),
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Expand the authoring shorthand into the JSON Schema the model is shown.
 *
 * Input (what the tool files below write):
 *
 *     { prompt: { type: 'string', required: true, description: '…' } }
 *
 * Output (what the registry and the model expect):
 *
 *     { type: 'object', additionalProperties: false,
 *       properties: { prompt: { type: 'string', description: '…' } },
 *       required: ['prompt'] }
 *
 * `additionalProperties: false` is what makes an invented argument a visible
 * error instead of a silently ignored key.
 *
 * @param spec - the per-argument shorthand, possibly empty.
 * @returns the object schema.
 */
export function parametersToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [name, field] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = field ?? {}
    properties[name] = rest
    if (isRequired === true) required.push(name)
  }
  const schema = { type: 'object', additionalProperties: false, properties }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * Expand the return-value shorthand into JSON Schema. The declared shapes here
 * are already JSON Schema, so this only supplies a default.
 * @param spec - the value schema, possibly absent.
 * @returns the value schema.
 */
export function valueToJsonSchema(spec) {
  if (spec === undefined || spec === null) return { type: 'string' }
  return spec
}

/**
 * Check arguments against the expanded schema.
 * @param schema - the object schema from `parametersToJsonSchema`.
 * @param args - the model-supplied arguments.
 * @returns one message per violation; empty when the call is well formed.
 */
export function validateArguments(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['arguments must be an object']
  }
  const violations = []
  for (const name of schema.required ?? []) {
    if (args[name] === undefined || args[name] === null) violations.push(`${name} is required`)
  }
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const value = args[name]
    if (value === undefined || value === null) continue
    const check = TYPE_CHECKS[field?.type]
    if (check !== undefined && !check(value)) {
      violations.push(`${name} must be ${field.type}`)
      continue
    }
    if (Array.isArray(field?.enum) && !field.enum.includes(value)) {
      violations.push(`${name} must be one of ${field.enum.join(', ')}`)
    }
  }
  return violations
}

/**
 * Build a registry-ready tool definition.
 *
 * @param options - `name`, `description`, the argument shorthand under
 *   `parameters`, an `output` declaration carrying a value schema and a text
 *   `render`, and the `execute(args, exec)` body.
 * @returns the definition to hand to `ctx.tools.register()`.
 */
export function defineTool(options) {
  const parameters = parametersToJsonSchema(options.parameters)
  const outputSchema = valueToJsonSchema(options.output?.schema)
  const render =
    options.output?.render ??
    ((_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }])

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => render(args, value)
    },
    async execute(args, exec) {
      const violations = validateArguments(parameters, args ?? {})
      if (violations.length > 0) {
        throw new Error(`${options.name}: invalid arguments — ${violations.join('; ')}`)
      }
      return options.execute(args ?? {}, exec)
    }
  }
}
