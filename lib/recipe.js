/**
 * dsh-nai-imagegen — the comic recipe.
 *
 * The 「NAI5分格漫画」 preset drives a model through a comic console with a handful
 * of switches: 色彩, 页数, 分镜, 留白, and the extras a page needs. Each one does
 * its work by contributing phrasing to the prompt, so each one is modelled here as
 * a group of options, and each option carries the fragments it adds.
 *
 * Declaring the table once is the point: the host appends the fragments and the
 * floating window renders the dropdowns, and both read the same list. Writing the
 * labels in the window and the fragments in the host is how the two drift apart —
 * the panel would offer an option the renderer had never heard of.
 *
 * What each switch actually changes in the picture:
 *
 *   - **色彩** — greyscale and screentone versus full colour. The strongest of the
 *     four: it changes the medium, not just the mood.
 *   - **页数** — how many `<image>` pages the *writing* model should produce, plus
 *     the panel density per page. The count is an instruction to the writer; the
 *     density is what reaches NovelAI.
 *   - **分镜** — pacing and framing vocabulary.
 *   - **留白** — the page margin: a closed frame, full bleed, or no border at all.
 *
 * Zero external dependencies.
 */

/**
 * The recipe groups, in the order the console shows them.
 *
 * `default` is what an unset option means, so a config that predates the recipe —
 * or a user who never opened the window — still renders something sensible.
 */
export const RECIPE_GROUPS = [
  {
    key: 'color',
    label: '色彩',
    default: 'full',
    options: [
      {
        key: 'full',
        label: '全彩漫画',
        positive: 'full color, vibrant colors',
        negative: 'monochrome, greyscale, limited palette'
      },
      {
        key: 'mono',
        label: '黑白脱色',
        // Weighted. A bare `monochrome` lost to the artist string's colour bias on
        // one page and won on the next, using the same value both times — the
        // palette tag has to outrank the style, and the exclusion has to be stated
        // in the negative as well as the positive.
        positive: '1.4::monochrome::, 1.4::greyscale::, 1.2::screentone::, 1.2::black and white::, 1.2::high contrast ink::, no color',
        negative: '1.3::full color::, 1.3::vibrant colors::, 1.2::colored::, 1.2::blue hair::, 1.2::pink hair::'
      }
    ]
  },
  {
    key: 'pages',
    label: '页数',
    default: '4',
    // How many `<image>` pages the **writing** model should produce. It never
    // reaches the image API, so changing it cannot change a single render — which
    // looked like a broken switch until the window said so.
    note: '只决定要写几页，不改变单页画面',
    options: [
      { key: '4', label: '4 页', pages: 4, positive: 'multi-page comic, several panels per page' },
      { key: '2', label: '2 页', pages: 2, positive: 'two-page comic, several panels per page' },
      { key: '6', label: '6 页', pages: 6, positive: 'multi-page comic, several panels per page' },
      { key: 'auto', label: '动态页数', pages: 0, positive: 'multi-page comic, several panels per page' }
    ]
  },
  {
    key: 'pacing',
    label: '分镜',
    default: 'daily',
    options: [
      { key: 'daily', label: '日常', positive: 'slice of life pacing, calm composition, even panel rhythm' },
      { key: '4koma', label: '经典四格', positive: '4-koma, four equal panels, vertical strip, ki-sho-ten-ketsu, even rectangular frames' },
      { key: 'shounen', label: '少年热血', positive: 'action manga, dynamic paneling, speed lines, impact frame, dramatic angle, diagonal layout' },
      { key: 'seinen', label: '悬疑推理', positive: 'seinen manga, suspenseful paneling, detailed linework, slow visual beats, heavy shadow' },
      { key: 'eromanga', label: '本子肉感', positive: 'eromanga, soft shading, glistening skin, close framing, generous curves' },
      { key: 'romance', label: '恋爱少女', positive: 'shoujo manga, sparkle, soft focus, decorative screentone, gentle expression, floating flowers' },
      { key: 'comedy', label: '喜剧日常', positive: 'gag manga, exaggerated reaction faces, chibi insert, sweatdrop, comedic timing' }
    ]
  },
  {
    key: 'margin',
    label: '留白',
    default: 'closed',
    options: [
      { key: 'closed', label: '封闭内枠', positive: 'white margin, black panel border, even gutter, closed inner frame' },
      { key: 'bleedTB', label: '天地出血', positive: 'full bleed top and bottom, panels running off the page edge' },
      { key: 'bleedFull', label: '沉浸全出血', positive: 'full bleed, edge to edge, no margin, borderless panels' },
      { key: 'blackline', label: '纯黑线无白边', positive: 'black line frame only, no white margin, tight crop' }
    ]
  },
  {
    key: 'bubble',
    label: '气泡',
    default: 'on',
    options: [
      { key: 'on', label: '带气泡', positive: 'speech bubble, bubble tail pointing to the speaker' },
      // "no speech bubble" as a *positive* reads as a request to draw one; the
      // exclusion belongs in the negative.
      { key: 'off', label: '不带气泡', positive: '', negative: 'speech bubble, thought bubble, text box' }
    ]
  },
  {
    key: 'dialogue',
    label: '对白语言',
    default: 'zh',
    // Steers the language of lettering *when the page has any*. It does not make
    // the model draw text: the quoted lines from the page's `Text:` fields do that.
    note: '只在有台词时管字形，不会让模型凭空画字',
    options: [
      // These steer the language of lettering *when there is any*. A bare
      // `simplified chinese text` reads as "draw text" and produced exactly that —
      // garbled lettering across the top of a page that had no dialogue at all.
      // Weighted down, and the other language excluded instead, which is what
      // actually steers it.
      { key: 'zh', label: '简体中文', positive: '0.6::chinese text::', negative: 'english text, japanese text' },
      { key: 'ja', label: '日文', positive: '0.6::japanese text::, japanese manga lettering', negative: 'english text, chinese text' }
    ]
  }
]

/**
 * Whether a value is a usable option for a group.
 * @param groupKey - the group.
 * @param value - the candidate.
 * @returns true when the option exists.
 */
export function isRecipeOption(groupKey, value) {
  const group = RECIPE_GROUPS.find((row) => row.key === groupKey)
  if (group === undefined) return false
  return group.options.some((option) => option.key === value)
}

/**
 * Fill a stored recipe with the defaults for anything unset or unknown.
 *
 * @param recipe - the stored selections, possibly partial or stale.
 * @returns a complete recipe.
 */
export function normalizeRecipe(recipe) {
  const out = {}
  for (const group of RECIPE_GROUPS) {
    const value = recipe === null || typeof recipe !== 'object' ? undefined : recipe[group.key]
    out[group.key] = isRecipeOption(group.key, value) ? String(value) : group.default
  }
  return out
}

/**
 * Turn a recipe into the prompt fragments it contributes.
 *
 * @param recipe - the stored selections.
 * @returns `{ positive, negative, pages }`.
 */
export function recipeFragments(recipe) {
  const filled = normalizeRecipe(recipe)
  const positive = []
  const negative = []
  let pages = 0
  for (const group of RECIPE_GROUPS) {
    const option = group.options.find((row) => row.key === filled[group.key])
    if (option === undefined) continue
    if (option.positive) positive.push(option.positive)
    if (option.negative) negative.push(option.negative)
    if (Number.isFinite(option.pages)) pages = option.pages
  }
  return { positive: positive.join(', '), negative: negative.join(', '), pages }
}

/**
 * A one-line description of a recipe, for a status readout.
 * @param recipe - the stored selections.
 * @returns the text.
 */
export function describeRecipe(recipe) {
  const filled = normalizeRecipe(recipe)
  return RECIPE_GROUPS.map((group) => {
    const option = group.options.find((row) => row.key === filled[group.key])
    return `${group.label}:${option?.label ?? filled[group.key]}`
  }).join('　')
}
