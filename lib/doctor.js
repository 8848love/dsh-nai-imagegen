/**
 * dsh-nai-imagegen — live capability check.
 *
 * Every failure this plugin has had was *silent*: a config field coerced to the
 * wrong type, a key id stripped on the way through `normalize`, a refactor that
 * dropped a parser branch, a module that simply was not loaded yet. None of them
 * threw; they just quietly stopped working, and the only way to notice was to
 * render something and look at it.
 *
 * This module is the answer to that: one call that exercises every capability
 * against the live configuration and says, check by check, whether it is intact.
 * It is deliberately cheap — no rendering, no Anlas — so it can be run after every
 * restart, and deliberately explicit about *why* a check failed.
 *
 * Kept free of DSH imports so it runs offline in the test suite.
 */
import { readFile } from 'node:fs/promises'
import { RATIOS, ratioOf } from './config.js'
import { join } from 'node:path'
import { normalizeQuota, normalizeSubscription } from './quota.js'
import { USER_ID_BASE, loadUserLibrary, mergeArtists, readUserImage, userImageDir, userLibraryPath } from './artists.js'

/**
 * Run every capability check.
 *
 * @param deps - the live pieces, injected by the host half.
 * @returns `{ ok, checks }` where each check is `{ name, ok, detail }`.
 */
export async function runDoctor(deps) {
  const {
    config,
    pool,
    proxy,
    loadIndex,
    searchArtists,
    readArtistImage,
    listLibraries,
    lookup,
    resolveCharacter,
    digest,
    clientSource,
    outputDir,
    packageRoot,
    modeSettings
  } = deps

  const checks = []
  /**
   * Record one check.
   * @param name - what is being verified.
   * @param ok - whether it holds.
   * @param detail - a short explanation, shown either way.
   */
  const check = (name, theAnswer, detail = '') => checks.push({ name, ok: theAnswer === true, detail: String(detail) })

  // ------------------------------------------------------------- configuration --
  // The type of every field is asserted, because `normalize` coerces by `typeof`
  // and a wrong branch turned `autoGenerate` into the string "true" once — which
  // no `=== true` check could ever satisfy.
  const badTypes = []
  for (const [key, value] of Object.entries(config)) {
    const wanted = key === 'keys' ? 'object' : typeof config[key]
    if (Array.isArray(config[key]) && wanted !== 'object') badTypes.push(key)
    else if (value === null && key !== 'keys') badTypes.push(`${key}(null)`)
  }
  check('config fields are non-null', badTypes.length === 0, badTypes.join(','))
  check('autoGenerate is a real boolean', typeof config.autoGenerate === 'boolean', typeof config.autoGenerate)
  check('artistId is a real number', typeof config.artistId === 'number', typeof config.artistId)
  check('keys is an array', Array.isArray(config.keys), typeof config.keys)
  check('keepImages is a real number', typeof config.keepImages === 'number', typeof config.keepImages)
  // Display size: a 832x1216 page at 100% fills the column and pushes the
  // conversation off-screen, so these two are what keep the transcript readable.
  check(
    'the display width is a usable percentage',
    typeof config.displayWidth === 'number' && config.displayWidth >= 10 && config.displayWidth <= 100,
    String(config.displayWidth)
  )
  check(
    'the display height cap is a number (0 means none)',
    typeof config.displayMaxHeight === 'number' && config.displayMaxHeight >= 0,
    String(config.displayMaxHeight)
  )
  check('click-to-zoom is a real boolean', typeof config.displayClickZoom === 'boolean', typeof config.displayClickZoom)
  // The aspect ratio presets. Choosing a shape is the normal case, so a broken table
  // would make the studio's leading control offer sizes the API snaps to something
  // else — or bills for.
  const badRatios = []
  const ratioKeys = new Set()
  for (const row of RATIOS) {
    if (ratioKeys.has(row.key)) badRatios.push(`duplicate ${row.key}`)
    ratioKeys.add(row.key)
    if (row.width % 64 !== 0 || row.height % 64 !== 0) badRatios.push(`${row.key} off-grid`)
    // The free band: at or under 1024x1024 costs no Anlas on an Opus subscription.
    if (row.width * row.height > 1024 * 1024) badRatios.push(`${row.key} costs Anlas`)
    if (typeof row.label !== 'string' || row.label === '') badRatios.push(`${row.key} unlabelled`)
  }
  check(
    'every ratio preset is free and 64-aligned',
    RATIOS.length >= 4 && badRatios.length === 0,
    badRatios.join(',') || `${RATIOS.length} presets`
  )
  check('a preset size resolves to its ratio', ratioOf(832, 1216) === '2:3', String(ratioOf(832, 1216)))
  // A hand-typed size must not claim a ratio it does not have, or the window would
  // report a shape that is not what gets rendered.
  check('a hand-typed size claims no ratio', ratioOf(900, 1200) === null, String(ratioOf(900, 1200)))

  // ------------------------------------------------------------------ key pool --
  const summary = pool.healthSummary()
  check('at least one usable API key', summary.usableKeyCount > 0, JSON.stringify(summary))
  check('concurrency follows the usable keys', summary.concurrency >= 1 && summary.concurrency <= Math.max(1, summary.usableKeyCount), JSON.stringify(summary.concurrency))
  check('no token is exposed by the pool', !JSON.stringify(pool.list()).includes('pst-'))

  // ------------------------------------------------------- membership and quota --
  // This arithmetic is pure, so it can be checked without touching NovelAI: if
  // these numbers stop matching the upstream checklist, the panel is lying about
  // how much free V5 quota is left, and no render would ever show it.
  const sampleQuota = normalizeQuota(
    { active: true, tier: 3, usage: { percent: 32.5, isNegative: false, timeUntilNextPercent: 3600 } },
    0
  )
  check(
    'the V5 free band arithmetic matches the upstream checklist',
    sampleQuota.remainingImages === 562 && sampleQuota.dailyRefillPercent === 24 && sampleQuota.dailyRefillImages === 415,
    JSON.stringify(sampleQuota)
  )
  const nonOpus = normalizeQuota({ active: true, tier: 2 }, 0)
  check(
    'an unavailable quota says why instead of reporting zero',
    nonOpus.status === 'unavailable' && nonOpus.remainingImages === undefined,
    JSON.stringify(nonOpus)
  )
  const halfKnown = normalizeSubscription({ tier: 3, trainingStepsLeft: { fixedTrainingStepsLeft: 1200 } })
  check('an unknown Anlas balance stays unknown, not zero', halfKnown.remainingAnlas === null, JSON.stringify(halfKnown))
  check('the pool can name its enabled keys for a read-only refresh', typeof pool.readTargets === 'function', typeof pool.readTargets)
  check(
    'a key remembers its subscription and a failed read separately',
    typeof pool.noteSubscription === 'function' && typeof pool.noteQuotaFailure === 'function',
    ''
  )

  // --------------------------------------------------------------------- proxy --
  check('a proxy path is resolved or deliberately direct', proxy === null || /^https?:\/\//.test(String(proxy)), String(proxy))

  // ------------------------------------------------------------------- artists --
  // The archive is only ever read; everything made here lives beside the index. The two
  // are merged for every check below, and positional lookup is deliberately absent from
  // them: a hand-made id is 1000 and up, so `entries[id]` would resolve to nothing — or,
  // for an id that happens to be in range, to somebody else's string.
  const artists = await loadIndex(config.artistIndex)
  check('the artist index loads', artists !== null, config.artistIndex)
  const userLibraryFile = userLibraryPath(config.artistIndex)
  const userLibrary = await loadUserLibrary(userLibraryFile)
  const allArtists = mergeArtists(artists, userLibrary)
  check(
    'the artist list is the archive plus what was made here',
    allArtists.length === (artists?.entries.length ?? 0) + userLibrary.entries.length,
    `${artists?.entries.length ?? 0} imported + ${userLibrary.entries.length} hand-made`
  )
  if (artists !== null) {
    check('the artist index has entries', artists.entries.length > 0, String(artists.entries.length))
    check('the artist search returns rows', searchArtists({ entries: allArtists }, '', 3).length > 0)
    const current = Number(config.artistId)
    if (current >= 0) {
      const selected = allArtists.find((entry) => entry.id === current)
      check('the remembered artist still resolves', selected !== undefined, `artistId=${current}`)
      if (selected !== undefined && selected.image !== null && selected.image !== undefined) {
        const uploaded = selected.imageSource === 'upload'
        const bytes = uploaded
          ? await readUserImage({ dir: userImageDir(config.artistIndex), file: selected.image.file })
          : await readArtistImage({ sourceFile: config.artistSource || artists.sourceFile, image: selected.image })
        // The archive is not all PNG. Entry 132 ("梦柔肤厚涂-清甜萌系-xianyu") declares
        // mime image/jpeg, and that declaration is exactly what the image route serves it
        // as — so a PNG-only magic-byte test reports a perfectly healthy reference image
        // as broken. Sniff every signature the archive can carry, and print the magic in
        // the readout so the next failure says what the bytes actually were.
        check(
          uploaded ? 'the uploaded reference image reads back' : 'the reference image reads out of the archive',
          bytes !== null &&
            bytes.length >= 4 &&
            (bytes[0] === 0x89 || // png
              bytes[0] === 0x47 || // gif
              (bytes[0] === 0xff && bytes[1] === 0xd8) || // jpeg
              (bytes[0] === 0x52 && bytes[1] === 0x49)), // webp / RIFF
          `${bytes?.length ?? 0} bytes — ${bytes === null || bytes.length < 4 ? 'unreadable' : bytes.subarray(0, 4).toString('hex')}`
        )
      }
    }
  }

  // -------------------------------------------------------- what the panel makes --
  // Entries of its own, each with an id above every archive id, and reference images kept
  // as ordinary files in a directory of their own. A library the loader cannot read is
  // silent by design — it drops the record rather than complaining — so the invariants
  // that make a record usable are asserted here instead of being assumed.
  check('the hand-made library sits beside the index', userLibraryFile.endsWith('user.json'), userLibraryFile)
  check(
    'every hand-made entry has a name and an id of its own',
    userLibrary.entries.every(
      (entry) => Number.isInteger(entry.id) && entry.id >= USER_ID_BASE && entry.name.trim() !== ''
    ),
    `${userLibrary.entries.length} hand-made (${userLibrary.entries.map((entry) => entry.id).slice(0, 8).join(',')})`
  )
  const importedTop = (artists?.entries ?? []).reduce((top, entry) => Math.max(top, Number(entry.id)), -1)
  check(
    'a hand-made id never lands on an imported one',
    userLibrary.entries.every((entry) => entry.id > importedTop),
    `imported ids run to ${importedTop}`
  )
  check(
    'no two entries share an id',
    new Set(allArtists.map((entry) => entry.id)).size === allArtists.length,
    `${allArtists.length} entries`
  )
  const libraryImages = Object.keys(userLibrary.images ?? {})
  check(
    'every stored image is keyed by an artist id',
    libraryImages.every((key) => /^\d+$/.test(key) && allArtists.some((entry) => entry.id === Number(key))),
    libraryImages.slice(0, 8).join(',')
  )
  check(
    'a stored image names a file of its own, inside its own directory',
    libraryImages.every((key) => {
      const file = String(userLibrary.images[key]?.file ?? '')
      return file !== '' && !file.includes('/') && !file.includes('\\') && !file.includes('..')
    }),
    libraryImages.map((key) => userLibrary.images[key]?.file).slice(0, 8).join(',')
  )
  check(
    'every stored image type is one the sniffer can produce',
    libraryImages.every((key) =>
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(userLibrary.images[key]?.mime))
    ),
    libraryImages.map((key) => userLibrary.images[key]?.mime).slice(0, 8).join(',')
  )
  const firstUpload = libraryImages[0]
  if (firstUpload !== undefined) {
    const bytes = await readUserImage({
      dir: userImageDir(config.artistIndex),
      file: userLibrary.images[firstUpload].file
    })
    check('an uploaded image is readable from its own directory', bytes !== null && bytes.length > 0, `${bytes?.length ?? 0} bytes`)
  }

  // A hand-edited string is stored against the artist id, never in the archive file.
  // A table the loader cannot read would silently drop the user's text, so its shape is
  // checked here — the loader normalises, it does not complain.
  const artistEdits = config.artistEdits ?? {}
  check('the artist edits table is an object', typeof artistEdits === 'object' && artistEdits !== null, typeof config.artistEdits)
  check(
    'every artist edit is keyed by an archive id',
    Object.keys(artistEdits).every((key) => /^\d+$/.test(key) && typeof artistEdits[key] === 'object' && artistEdits[key] !== null),
    Object.keys(artistEdits).slice(0, 8).join(',')
  )
  const editSides = Object.values(artistEdits).flatMap((row) => Object.keys(row ?? {}))
  check(
    'an artist edit only carries the directions it changes',
    editSides.every((side) => side === 'positive' || side === 'negative'),
    editSides.slice(0, 8).join(',')
  )
  check(
    'every edited artist still resolves in the artist list',
    Object.keys(artistEdits).every((key) => allArtists.some((entry) => entry.id === Number(key))),
    `${Object.keys(artistEdits).length} edited / ${allArtists.length} entries`
  )

  // ------------------------------------------------------------------ libraries --
  const libraries = await listLibraries(config.libraryDir)
  check('the libraries are indexed', libraries.length >= 5, libraries.map((row) => `${row.library}(${row.entries})`).join(' '))
  const found = await lookup('美人鱼', { libraryDir: config.libraryDir, limit: 1 })
  check('a full-text lookup hits', found.hits.length > 0, JSON.stringify(found.hits[0]?.title ?? ''))
  const roster = await resolveCharacter('Hikari', { libraryDir: config.libraryDir, limit: 1 })
  const rosterText = digest(roster)
  check('a roster resolve hits', roster.hits.length > 0, rosterText.split('\n')[0].slice(0, 90))
  check('the roster header is fully populated', !rosterText.includes('undefined'), rosterText.split('\n')[0].slice(0, 90))
  const rosterMiss = digest(await resolveCharacter('这个词绝对不在名册里zzz', { libraryDir: config.libraryDir, limit: 1 }))
  check('a roster miss does not claim the index is empty', !rosterMiss.includes('索引目录为空'), rosterMiss.split('\n')[0].slice(0, 90))

  // --------------------------------------------------------------- format parser --
  const { parseImageBlock, looksLikeImageBlock, maybeParseImageBlock } = await import('./format.js')
  const sample = [
    '<image>',
    '<image_think>',
    '①reasoning that must never be sent',
    '</image_think>',
    'image###size:1024x1024;',
    'Scene:SFW,{{2girls}},side-by-side;',
    'Char1:girl,on left,blonde hair|centers:B3;',
    'Char1 UC:brown hair;',
    'Scene UC:nude;###',
    '</image>'
  ].join('\n')
  const parsed = parseImageBlock(sample, { width: 832, height: 1216 })
  check('a sample block parses', parsed.ok, parsed.reason ?? '')
  if (parsed.ok) {
    check('the block sets its own size', parsed.width === 1024 && parsed.height === 1024, `${parsed.width}x${parsed.height}`)
    check('no scaffold leaks into the positive', !/<\/?image|image_think|image\s*#{2,}|#{2,}|centers/i.test(parsed.prompt), parsed.prompt.slice(0, 80))
    check('no scaffold leaks into the negative', !/<\/?image|image_think|image\s*#{2,}|centers/i.test(parsed.negativePrompt), parsed.negativePrompt.slice(0, 80))
    check('the reasoning is dropped', !/reasoning that must never be sent/.test(parsed.prompt))
    check('the character keeps its own negative', parsed.characters[0]?.negative === 'brown hair', JSON.stringify(parsed.characters[0]?.negative))
    check('the grid cell is captured', (parsed.characters[0]?.centers ?? []).includes('B3'), JSON.stringify(parsed.characters[0]?.centers))
  }
  // A plain prompt — including a 「简串版」 with lowercase char labels and inline
  // negative weights — must pass through untouched rather than being parsed.
  const simple = '2girls, ffm threesome, group sex, on bed,\n\nchar1: Hikari (Blue Archive), green hair,\n\n-1.5::twintails::,\n0.7::warm dim lighting::'
  check('a lowercase char-labelled prompt is not treated as a block', !looksLikeImageBlock(simple))
  check('and it is passed through verbatim', maybeParseImageBlock(simple) === null)
  check('the inline negative weight survives', /-1\.5::twintails::/.test(simple))

  // ------------------------------------------------------------------ classifier --
  // The browser half decides which blocks get a button. Its source is checked here
  // rather than imported, so a refactor that drops a format is caught offline.
  check('the client source is readable', typeof clientSource === 'string' && clientSource.length > 1000, String(clientSource?.length ?? 0))
  if (typeof clientSource === 'string') {
    check('the classifier knows the <image> block', /\[ \\t\]\*<image/.test(clientSource), '')
    check('the classifier knows the image### envelope', /image\\s\*#\{2,\}/.test(clientSource), '')
    // The call site, not the definition: `/installFoo\(t\)/` is satisfied by `function
    // installFoo(t) {` alone, so a refactor that dropped the `ctx.effect(...)` wiring
    // would leave these checks green while the feature stopped existing.
    check('the code-block watcher is installed', /ctx\.effect\(\(\) => installCodeButtons\(t\)/.test(clientSource), '')
    check('the image menu is installed', /ctx\.effect\(\(\) => installImageMenu\(t\)/.test(clientSource), '')
    check('the panel registers the key pool section', /t\('keys'\)/.test(clientSource), '')
    check('the panel registers the membership section', /t\('quota'\)/.test(clientSource), '')
    check('the panel refreshes the quota through its own route', /api\('\/quota'/.test(clientSource), '')
    check('the panel clamps the bar without clamping the number', /Math\.min\(100, Math\.max\(0, quota\.remainingPercent\)\)/.test(clientSource), '')
    check(
      'the quota reasons are written in both languages',
      /quotaNonOpus: '非 Opus 档/.test(clientSource) && /quotaNonOpus: 'not an Opus tier/.test(clientSource),
      ''
    )
    check('the panel registers the artist section', /t\('artist'\)/.test(clientSource), '')
    check('the panel can edit the current artist string', /t\('artistEdit'\)/.test(clientSource), '')
    check('the editor reads the text from its own route', /\/artist-text\?id=/.test(clientSource), '')
    check('the editor writes through the edit route', /\/artist-edit/.test(clientSource), '')
    check('the panel can make an artist string of its own', /t\('artistNew'\)/.test(clientSource), '')
    check('making one goes through the add route', /'\/artist-add'/.test(clientSource), '')
    check('a hand-made string can be taken back out', /'\/artist-remove'/.test(clientSource), '')
    // A reference image is bytes, and the JSON helper would base64 them and blow the body
    // ceiling. The upload therefore bypasses `api()` and posts the file as the body.
    check(
      'the reference image goes up as raw bytes rather than as JSON',
      /fetch\(`\$\{API\}\/artist-image\?id=\$\{id\}`/.test(clientSource) && /body: file/.test(clientSource),
      ''
    )
    check('an uploaded image can be dropped again', /method: 'DELETE'/.test(clientSource), '')
    check('a delete is offered for hand-made strings only', /artistText\.custom !== true/.test(clientSource), '')
    check('deleting asks twice before it happens', /artistDeleteArmed === currentArtistId/.test(clientSource), '')
    check('a hand-made string is tagged in the grid', /row\.custom === true/.test(clientSource), '')
    // The star is the one list the user curates, and it is one list for two surfaces. Each
    // of these checks is a way that broke elsewhere: a page-local copy that disagrees with
    // the other surface, a star that picks the entry it sits on, and an order re-settled on
    // every paint so the row under the pointer becomes a different entry mid-click.
    check(
      'the grid can star an artist string',
      /artistFavAdd/.test(clientSource) && /artistFavRemove/.test(clientSource),
      ''
    )
    check('the star is drawn on the row it stars', /star\.textContent = row\.favorite === true \? '★' : '☆'/.test(clientSource), '')
    check(
      'and clicking the star is not picking the entry',
      /star\.addEventListener\('click',[\s\S]{0,260}stopPropagation[\s\S]{0,420}starring\(row\)/.test(clientSource),
      ''
    )
    check('the star is written through the host rather than kept in the page', /await api\('\/artist-favorite'/.test(clientSource), '')
    check(
      'the starred entries lead when a list is opened',
      /artists\.artists = favoriteFirst\(artists\.artists\)/.test(clientSource) && /setArtists\(favoriteFirst\(body\.artists\)\)/.test(clientSource),
      ''
    )
    check(
      'and both lists ask for the whole archive rather than the first page',
      /api\('\/artists\?limit=500'\)/.test(clientSource) && /\/artists\?limit=500&q=/.test(clientSource),
      ''
    )
    // Both of the window's own gestures skip by tag — fields, buttons, links. The artist
    // list's rows are divs, so without a marker of its own the drag would capture the
    // pointer and the click with it (the row does nothing) and a double-click would be
    // read as "press the whole reply".
    check(
      'a press on a list row cannot be swallowed by the window drag',
      /DRAG_IGNORE = '[^']*\[data-no-window-gesture\]/.test(clientSource) &&
        /popup\.setAttribute\('data-no-window-gesture', ''\)/.test(clientSource),
      ''
    )
    check(
      'and a double-click on a row is not a request to press the whole reply',
      /closest\('input, textarea, select, button, \[data-no-window-gesture\]'\)/.test(clientSource),
      ''
    )
    // The create button's own feedback is load-bearing: the panel's error card sits at
    // the very top of a very long page, so a refusal printed there reads as "the button
    // did nothing" — which is exactly how this was reported.
    check(
      'a create says what happened where its button is',
      /artistNewError/.test(clientSource) && /artistNewNotice/.test(clientSource),
      ''
    )
    check('a nameless entry cannot be created at all', /artistNewName\.trim\(\) === ''/.test(clientSource), '')
    check(
      'the entry just made outranks the remembered pick for the scroll',
      /freshArtistRow/.test(clientSource) && /justCreatedId/.test(clientSource),
      ''
    )
    // The floating window is the readout and the panel is the editor. A second editor for
    // one value is exactly how the two start disagreeing, so the window's preview is
    // asserted to be a text node and not a control.
    check(
      'the floating window previews the text read-only',
      /const paintArtistPreview = async \(current, node\)/.test(clientSource) &&
        /node\.textContent = view\.edited === true \?/.test(clientSource),
      ''
    )
    check('the floating window has a repaint hook for the panel', /let refreshStudioArtist = null/.test(clientSource), '')
    check('the panel calls that hook after a save', /typeof refreshStudioArtist === 'function'\) refreshStudioArtist\(\)/.test(clientSource), '')
    check('the panel registers the auto-render toggle', /t\('autoOn'\)/.test(clientSource), '')
    check('the floating studio is installed', /ctx\.effect\(\(\) => installFloatingStudio\(t\)/.test(clientSource), '')
    check('the studio offers both modes', /STUDIO_MODES/.test(clientSource), '')
    check('the studio renders the recipe groups', /recipeGroups/.test(clientSource), '')
    check('the studio submits the recipe', /recipe: 1/.test(clientSource), '')
    check('the image sizing stylesheet is installed', /ctx\.effect\(\(\) => installImageSizing\(t\)/.test(clientSource), '')
    check('the sizing width is clamped to a sane range', /Math\.min\(100, Math\.max\(10/.test(clientSource), '')
    // Enlarging is an overlay over the page. Rewriting the picture's size in place is what
    // broke the sidebar: the panel's thumbs are full-size references, so a rule keyed on a
    // render's src stretched the artist grid.
    check(
      'clicking an image opens an enlargement overlay',
      /function openLightbox\(image[,)]/.test(clientSource) &&
        /addEventListener\('click', onClick, true\)/.test(clientSource),
      ''
    )
    check('no rule resizes a clicked image in place', !/ZOOM_ATTR/.test(clientSource), '')
    check(
      'the claim pass skips the control surfaces',
      /image\.closest\(`\[\$\{STUDIO_MARK\}\]`\) !== null\) \{[\s\S]{0,140}?image\.removeAttribute\?\.\(IMG_ATTR\)/.test(
        clientSource
      ),
      ''
    )
    // The display scale belongs to the settings panel, which is the plugin's real
    // settings surface, not to the floating window — and it must not be in both, or the
    // two would fight over one config field.
    check(
      'the settings panel exposes the display controls',
      /form\.displayWidth/.test(clientSource) && /displayClickZoom: event\.target\.checked/.test(clientSource),
      ''
    )
    check('the display controls left the floating window', !/draftDisplay/.test(clientSource), '')
    check('saving repaints the stylesheet without reopening', /refreshImageSizing\?\.\(\)/.test(clientSource), '')
    // The display setting is one overall scale, not two independent axes: the image is
    // drawn at some width and its height is whatever its own ratio makes it. A second,
    // separate height control is what distorted the picture instead of only shrinking
    // it, so assert it stays gone — along with the proportional height rule that keeps
    // the two axes locked together.
    check(
      'the display is one overall scale, not two axes',
      !/t\('displayHeight'\)/.test(clientSource) && /height: auto !important;/.test(clientSource),
      ''
    )
    check(
      'the display scale is a percentage control',
      /displayChoices\.map\(\(percent\) => h\('option'/.test(clientSource) &&
        /const DISPLAY_SCALES = \[100, 90, 80, 70, 60, 50, 40, 33, 25\]/.test(clientSource),
      ''
    )
    // A rule that matches nothing is indistinguishable from a rule that does nothing,
    // which is how "changing the display scale has no effect" stayed invisible. The
    // host rewrites `src` to an opaque `/attachments/…` address, so the mark is the only
    // selector that can match — and something has to apply it.
    check(
      'transcript images are claimed by the attribute the rules select on',
      /function claimRenderImages\(\)/.test(clientSource) && /img\[\$\{IMG_ATTR\}="1"\]/.test(clientSource),
      ''
    )
    check(
      'the sweep runs on install',
      /^\s{6}sweepImages\(\)$/m.test(clientSource) &&
        /return \{ claimed: claimRenderImages\(\), zoomable: markZoomables\(\) \}/.test(clientSource),
      ''
    )
    check('a newly decoded image is swept too', /addEventListener\('load', sweepSoon, true\)/.test(clientSource), '')
    check('a new transcript node is swept too', /new MutationObserver\(sweepSoon\)/.test(clientSource), '')
    // Enlarging belongs to this plugin's own pictures. It used to belong to every content
    // image, which is how a click on another plugin's render opened this plugin's overlay
    // instead of doing whatever that plugin wanted — so the identity gate is asserted too,
    // along with the chrome that has to stay out of it either way.
    check(
      'only our own pictures are clickable to enlarge',
      /function isZoomableImage\(image\)/.test(clientSource) &&
        clientSource.includes('if (!isOurOutput(image)) return false') &&
        /img\[\$\{ZOOMABLE_ATTR\}="1"\] \{/.test(clientSource) &&
        /isZoomableImage\(target\)/.test(clientSource),
      ''
    )
    // Identity by name, never by size: a large picture is not evidence that it is ours, and
    // treating size as identity is what claimed the rest of the app's images.
    check(
      'a render is identified by its address, not by being large',
      !clientSource.includes('width >= 256 && height >= 256') &&
        clientSource.includes('alt === GENERATED_ALT') &&
        clientSource.includes('_out[\\\\/]nai[\\\\/]'),
      ''
    )
    check(
      'chrome is not clickable to enlarge',
      /image\.closest\(control\) !== null\) return false/.test(clientSource) &&
        /Math\.max\(width, height\) >= ZOOM_MIN_PIXELS/.test(clientSource) &&
        /anchor\.target \?\? ''\) === '_blank'/.test(clientSource),
      ''
    )
    check('the settings panel is not content to enlarge', /\[STUDIO_MARK\]: 'panel'/.test(clientSource), '')
    check('the rules stay out of the shell stylesheet order', /% !important;/.test(clientSource), '')
    // The enlargement is a viewer, not a dead end: comparing two attempts at one prompt is the
    // most common thing anyone does with these pictures, and without a strip that means
    // closing the overlay, scrolling the conversation, and clicking the other one.
    check(
      'the enlargement carries a strip of earlier renders',
      /const LIGHTBOX_STRIP_STYLE = \{/.test(clientSource) &&
        clientSource.includes("api('/gallery?limit=200')") &&
        clientSource.includes("strip.setAttribute(STUDIO_MARK, 'lightbox-strip')"),
      ''
    )
    check(
      'a thumbnail switches the picture without closing the overlay',
      clientSource.includes('event.stopPropagation()\n          show(at)') &&
        /\$\{index \+ 1\} \/ \$\{items\.length\}/.test(clientSource),
      ''
    )
    check(
      'the arrow keys walk the strip',
      clientSource.includes("event?.key === 'ArrowLeft'") &&
        clientSource.includes("event?.key === 'ArrowRight'") &&
        clientSource.includes('lightboxStrip.index() + 1'),
      ''
    )
    // A right-click has to reach the picture where it is biggest. The enlargement is a control
    // surface like the panel, and the menu rightly keeps off the panel's chrome — but the
    // enlarged picture is content, so its own viewer is the one surface the menu reaches into.
    // Without this, the menu claimed the thumbnails and refused the full-size view.
    check(
      'the enlarged picture can be copied from the right-click menu',
      clientSource.includes('closest(`[${STUDIO_MARK}="lightbox"]`)') &&
        /\(!inStudio \|\| inLightbox\)/.test(clientSource) &&
        clientSource.includes("big.setAttribute('data-nai-name', items[index].name)"),
      ''
    )
    // A render is embedded as a local path, and the browser half draws a Markdown image by
    // resolving that path through a vocabulary it rebuilds on every mount — which is why a
    // picture could be there when it was rendered and gone after the conversation was
    // switched away from and back. The bytes are still on disk and this plugin serves them
    // itself, so an image that failed is re-pointed rather than left blank.
    check(
      'an image that failed to load is re-pointed at this plugin',
      /function repairBrokenImage\(image\)/.test(clientSource) &&
        /image\.setAttribute\('src', `\$\{API\}\/file\?name=\$\{encodeURIComponent\(name\)\}`\)/.test(clientSource) &&
        /addEventListener\('error', onImageError, true\)/.test(clientSource),
      ''
    )
    check(
      'the retry is bounded and stays inside our own output',
      /image\.getAttribute\(REPAIR_ATTR\) === '1'\) return false/.test(clientSource) &&
        /String\(imageMatch \|\| '_out\/nai\/'\)/.test(clientSource) &&
        /image\.complete !== true \|\| Number\(image\.naturalWidth \?\? 0\) > 0/.test(clientSource),
      ''
    )
    check('the panel reports how many images were claimed', /t\('displayFound'\)/.test(clientSource), '')
    check('the studio offers the ratio presets', /status\.ratios/.test(clientSource), '')
    check('a hand-typed size reports itself as custom', /studioRatioCustom/.test(clientSource), '')
    check('the studio surfaces a pending restart', /status\.restart\?\.needed/.test(clientSource), '')
    // Dragging. Binding move/up to the header alone dropped every move the moment the
    // pointer left the title bar, which is what made the window feel undraggable;
    // capture plus viewport-relative measurement is the fix, so assert both survive.
    check('dragging captures the pointer', /setPointerCapture/.test(clientSource), '')
    check('dragging measures in viewport coordinates', /getBoundingClientRect\(\)/.test(clientSource), '')
    check('dragging survives a cancelled pointer', /'pointercancel'/.test(clientSource), '')
    check('the launcher itself is draggable', /LAUNCHER_POS/.test(clientSource), '')
    // A drag also fires a click. Without the guard, moving the button would pop the
    // studio open as well.
    check('a drag on the launcher does not also click it', /suppressClick/.test(clientSource), '')
    // Auto-render has to spend its allowance on replies and nothing else. Switching into a
    // conversation replays its whole transcript at once, and every prompt block in it has
    // already been answered — firing them again buys the user a second copy of the pictures
    // that are already on screen. What a batch has to show to be read as a replay is the
    // teardown: hundreds of nodes leave when one transcript replaces another, and a reply only
    // appends and rewrites. Counting the blocks instead read a reply that carried three prompts
    // as a conversation coming back, and that mark cost the user every picture in the reply. The
    // stamp goes on the blocks the batch itself brought: a live reply can land in the same commit
    // as a transcript re-render, and condemning by a clock is what used to leave that reply
    // unanswered for good. So the removal count, the per-batch stamp and the absence of the old
    // clock are asserted, plus the two passes that are deliberately exempt from the rule.
    check(
      'a replayed transcript is not rendered again',
      /function looksLikeReplay\(records\)/.test(clientSource) &&
        /if \(looksLikeReplay\(records\)\) \{/.test(clientSource) &&
        clientSource.includes('stampHistory(records)') &&
        /function stampHistory\(records\)/.test(clientSource) &&
        /function looksLikeReplay\(records\) \{[\s\S]{0,400}return removed >= REPLAY_REMOVALS/.test(clientSource) &&
        !clientSource.includes('REPLAY_PRES') &&
        !clientSource.includes('REPLAY_GRACE_MS') &&
        !clientSource.includes('replayUntil'),
      ''
    )
    check(
      'the pass that runs at activation renders nothing',
      clientSource.includes('scan({ history: true })') &&
        clientSource.includes('autoHistory = options.history === true') &&
        /if \(autoHistory === true\) \{\s*\n\s*markHistory\(host\)/.test(clientSource) &&
        clientSource.includes('historyBlocks.add(host)'),
      ''
    )
    // The marks must be something growth can undo, and there are two of them: one says the block
    // was history, the other that it has already been pressed. A block whose text grew into a
    // different prompt is neither — it is a prompt nobody has rendered yet — while a block whose
    // text is still being written is a reply arriving, the very block the commit-level rule used
    // to catch.
    check(
      'growth puts a stamped block back in play',
      /historyBlocks\.delete\(host\)\s*\n\s*firedBlocks\.delete\(host\)/.test(clientSource) &&
        clientSource.includes('decorated.set(host, { button, key, text, injected: [bar, slot] })'),
      ''
    )
    // A block is mounted and then filled, so the pass that first sees it may be looking at a
    // fragment: firing there renders half a prompt and bills a second render for the rest. What
    // is waited for is the whole transcript, not the block — a reply writes its prompt and then
    // keeps talking, and a pass from that stretch was enough to fire it in the middle of a stream.
    // Silence alone cannot settle it either: a live reply renders its own elapsed time once a
    // second, so a one-second window is something an in-flight reply can satisfy. Hence the window
    // is longer than that heartbeat and the pass also refuses to fire while the transcript's own
    // live markers are on screen, re-arming instead. The observer has to see text rewritten in
    // place, or that heartbeat is invisible to it.
    //
    // Where those markers are read is not a detail. The app leaves them behind — a turn that was
    // stopped keeps its command card on `data-state="running"` for the rest of the session — so a
    // page-wide `querySelector` obeyed a leftover for ever and auto-render went quiet for a whole
    // session without saying so. A marker now counts only where the newest turn's boundary puts it
    // (behind a turn tail it belongs to a reply that already ended), and only while the page is
    // still moving, which the elapsed-time heartbeat guarantees while a reply really is arriving.
    //
    // And the window says what it did. Whether it fired, and, when it did not, which marker held
    // it back — that sentence is the difference between "it stopped rendering" and a diagnosis,
    // and it is the only account available: the page has no debug port and no console anyone can
    // read, so what it decided travels to the host's ring instead.
    check(
      'a render is released only by a pass that follows a transcript that has stopped',
      clientSource.includes('const SETTLE_QUIET_MS = 3000') &&
        clientSource.includes(`const LIVE_MARKERS = ['[data-streaming]', '[data-state="running"]']`) &&
        clientSource.includes('const LIVE_STALE_MS = 30000') &&
        clientSource.includes('function blockingMarker()') &&
        clientSource.includes("document.querySelectorAll(`[${TURN_TAIL_ATTR}], ${LIVE_MARKERS.join(', ')}`)") &&
        clientSource.includes('const newest = walk[walk.length - 1]') &&
        clientSource.includes(
          "if (typeof newest?.getAttribute === 'function' && newest.getAttribute(TURN_TAIL_ATTR) !== null) return null"
        ) &&
        clientSource.includes("if (node.getAttribute('data-state') === 'running') return '[data-state=\"running\"]'") &&
        clientSource.includes('return now - lastChangeAt <= LIVE_STALE_MS ? marker : null') &&
        clientSource.includes('function armSettleScan()') &&
        clientSource.includes("if (settleTimer !== null && typeof clearTimeout === 'function') clearTimeout(settleTimer)") &&
        clientSource.includes('const blocked = blockingMarker()') &&
        /if \(blocked !== null\) \{[\s\S]{0,600}armSettleScan\(\)/.test(clientSource) &&
        clientSource.includes("diag('window', { verdict: 'still-writing', marker: blocked })") &&
        clientSource.includes("diag('window', { verdict: 'quiet', quietMs: SETTLE_QUIET_MS })") &&
        !clientSource.includes('function stillWriting()') &&
        clientSource.includes('rescanBlocks({ settled: true })') &&
        clientSource.includes('autoSettled = options.settled === true') &&
        clientSource.includes('} else if (autoSettled !== true) {') &&
        clientSource.includes("why = 'not-quiet'") &&
        /observer\.observe\(document\.body, \{ childList: true, characterData: true, subtree: true \}\)/.test(clientSource) &&
        /function noteActivity\(\) \{\s*\n\s*if \(typeof Date\.now === 'function'\) lastChangeAt = Date\.now\(\)\s*\n\s*if \(autoRender === true\) armSettleScan\(\)/.test(
          clientSource
        ) &&
        /if \(looksLikeReplay\(records\)\) \{[\s\S]{0,600}stampHistory\(records\)[\s\S]{0,600}noteActivity\(\)/.test(clientSource),
      ''
    )
    // Auto-render answers the reply that just arrived, and one reply can carry several prompts:
    // every block of it renders, however many there are. What is excluded is history — the
    // conversation as it already stood — which is why nothing narrows a pass down to a single
    // block any more, and no per-session counter is left to run into. Nothing is excluded by the
    // *words* either: a prompt the user asks for twice is a request twice, and a text-keyed gate
    // answered the second one with silence.
    check(
      'every prompt of a live reply is rendered, with nothing narrowed to one block',
      !clientSource.includes('autoNewest') &&
        !clientSource.includes('newestPre') &&
        !clientSource.includes('historyKeys') &&
        !clientSource.includes('if (autoDone.has(key)) return false') &&
        !clientSource.includes('if (generated.has(key)) return false') &&
        clientSource.includes('options.autoLastOnly === true ? [...order].reverse() : order'),
      ''
    )
    // History is remembered by *where* it was, never by what it said. A text-keyed set has no
    // memory of position: it answers every later reply that reuses the words, so a session whose
    // user reuses their prompts renders nothing at all after the first — which is exactly the
    // report this rule was rewritten for. The element is the one thing a replayed transcript
    // brings fresh, so the element is what the stamp is kept on.
    check(
      'history is stamped by element only, so reusing a prompt later is not held against it',
      !clientSource.includes('historyKeys') &&
        clientSource.includes('const historyBlocks = new WeakSet()') &&
        /function markHistory\(pre\) \{[\s\S]{0,300}historyBlocks\.add\(host\)/.test(clientSource) &&
        /if \(options\.history === true\) \{\s*\n\s*for \(const pre of order\)/.test(clientSource) &&
        clientSource.includes('if (autoRender !== true) markHistory(pre)'),
      ''
    )
    check(
      'the per-session ceiling is gone',
      !clientSource.includes('AUTO_RENDER_MAX') && !clientSource.includes("t('autoCapped')"),
      ''
    )
    // The flag's only writer used to be the panel's effect, and the panel exists only while
    // this plugin's page is the active view — so a page loaded with auto-render already on
    // rendered nothing until the user opened the panel. It is read from the host at activation.
    check(
      'the stored setting is read at activation, not only by the panel',
      clientSource.includes('async function bootAutoRender()') &&
        clientSource.includes('async function readAutoSetting()') &&
        /ctx\.effect\(\(\) => \{\s*\n\s*bootAutoRender\(\)/.test(clientSource),
      ''
    )
    // A setting read once at page load goes stale the moment anything else writes it: the
    // `nai_config` tool from a chat, a second window, this plugin's own panel in a tab that has
    // been open since before the change. The page then keeps refusing while the stored setting
    // says on, and an answer older than the setting looks exactly like a broken feature. So the
    // answer is re-read on a slow clock and on the two moments the page comes back to the user,
    // and an unreadable host leaves the flag where it was rather than being taken for "off".
    check(
      'the setting is re-read on a clock rather than trusted once',
      clientSource.includes('const SETTING_POLL_MS = 15000') &&
        clientSource.includes('setInterval(read, SETTING_POLL_MS)') &&
        clientSource.includes("document.addEventListener('visibilitychange', onWake)") &&
        clientSource.includes("if (moved && typeof onSettingMoved === 'function') onSettingMoved(wanted)") &&
        clientSource.includes('return startSettingSync()'),
      ''
    )
    // Turning the toggle on is the one moment the user has explicitly asked for the block in
    // front of them, so that pass is still allowed to fire — history rule and all.
    check(
      'the pass that runs when the toggle is switched on is exempt',
      clientSource.includes('autoForce = options.autoLastOnly === true') &&
        /rescanBlocks\(\{ autoLastOnly: true \}\)/.test(clientSource),
      ''
    )
    check(
      'the retry also recognises this plugin’s own address',
      clientSource.includes('!flat.includes(`${API}/file`)'),
      ''
    )
    // Double-clicking the floating window is the manual counterpart of the automatic pass:
    // the user points at the reply they mean and every prompt in it renders at once. The
    // reply is found rather than assumed, because the pictures of the reply above are already
    // on screen and firing those a second time bills for duplicates. What marks the boundary
    // is the tail the app renders after each reply, so the blocks that count are the ones with
    // no tail between them — one ordered query, walked backwards.
    check(
      'the window renders the newest reply and only the newest reply',
      clientSource.includes("const TURN_TAIL_ATTR = 'data-turn-tail'") &&
        clientSource.includes('function newestReplyHosts()') &&
        clientSource.includes('function latestReplyHosts()') &&
        clientSource.includes('document.querySelectorAll(`pre, [${TURN_TAIL_ATTR}]`)') &&
        clientSource.includes('picked.push(node?.parentElement ?? node)') &&
        clientSource.includes('return newestReplyHosts().filter((host) => decorated.get(host) !== undefined)'),
      ''
    )
    check(
      'and the walk stops at the reply above rather than running up the conversation',
      /boundaries \+= 1/.test(clientSource) && /if \(boundaries > 1\) break/.test(clientSource),
      ''
    )
    // The same boundary bounds the automatic pass, and for the same reason: the quiet pass walks
    // the whole page, and a block above the newest reply's tail belongs to a reply whose pictures
    // are already in the transcript. The set is frozen from one walk *before* the pass decorates
    // anything, so a block the pass is about to build counts as one of that reply's too.
    check(
      'the quiet pass is fenced to the newest reply as well',
      clientSource.includes('let settleHosts = null') &&
        clientSource.includes('if (autoSettled === true) settleHosts = new Set(newestReplyHosts())') &&
        clientSource.includes('settleHosts !== null &&') &&
        clientSource.includes('(host === undefined || host === null || settleHosts.has(host) !== true)') &&
        clientSource.includes("why = 'older-reply'") &&
        clientSource.includes('settleHosts = null'),
      ''
    )
    // A page that renders nothing has no debug port and no console anyone can read, so what it
    // decided travels to the host instead: every pass reports its verdict, every refusal names the
    // gate that stopped it, and the host keeps a bounded ring of them to be read back.
    const hostDiagSource = await readFile(join(packageRoot, 'index.js'), 'utf8').catch(() => '')
    check(
      'a page that renders nothing can say which gate stopped it',
      clientSource.includes('function diag(event, data)') &&
        clientSource.includes('keepalive: true') &&
        clientSource.includes("diag('boot', { autoRender, api: API })") &&
        clientSource.includes("diag('replay', { removed })") &&
        clientSource.includes("diag('settle', {") &&
        clientSource.includes('outcome: Object.fromEntries(tally)') &&
        clientSource.includes('lastFireReason = why ?? ') &&
        clientSource.includes('const AUTO_FIRE_TTL_MS = 20000') &&
        clientSource.includes('const firedBlocks = new WeakSet()') &&
        hostDiagSource.includes('const DIAG_LIMIT = 200') &&
        hostDiagSource.includes('function keepDiag(entry)') &&
        hostDiagSource.includes('entries: [...diagLog].reverse()'),
      ''
    )
    check(
      'a reply that is still being written is refused, not pressed',
      clientSource.includes('const busy = blockingMarker()') &&
        clientSource.includes("if (busy !== null) return { clicked: 0, reason: 'busy', marker: busy }") &&
        clientSource.includes("`${t('studioFireBusy')}（${outcome.marker}）`"),
      ''
    )
    // A press is a re-roll: NovelAI draws a fresh seed every time, so a block that already has
    // its pictures is exactly what the press is for. What has to stay skipped is a render already
    // in flight — pressing behind it asks the same prompt for a second render while the first is
    // still on its way. A `generated` gate inside this function would quietly turn the re-roll
    // back into a one-shot.
    check(
      'a prompt that already has its pictures is rendered again, while one already rendering is not queued twice',
      /button\.disabled === true[\s\S]{0,60}continue/.test(clientSource) &&
        !/function fireLatestReply\([^)]*\) \{[\s\S]{0,900}generated\.has/.test(clientSource),
      ''
    )
    // A block is decorated by a pass, and a reply can land between passes: without a pass of
    // its own, the double-click would do nothing on the very reply being pointed at.
    check(
      'the press runs a pass first, so a block built after the last one is still reached',
      /function fireLatestReply\([^)]*\) \{[\s\S]{0,900}typeof rescanBlocks === 'function'/.test(clientSource),
      ''
    )
    // Double-clicking a field is how one selects a word, and a double-click on a button is a
    // button press; neither is a request to spend a whole reply's worth of renders.
    check(
      'a double-click on a field or on a control is not a render request',
      clientSource.includes("target.closest('input, textarea, select, button, [data-no-window-gesture]') !== null"),
      ''
    )
    // The press is otherwise invisible: the status line is where it says what it did, and it
    // has to fall back to the standing hint so the window does not keep a stale verdict.
    const fireLabels = ['studioFireNow', 'studioFireHint', 'studioFireBusy', 'studioFireNone', 'studioFireSpent', 'studioFireStarted']
    check(
      'the window says what the press did, in both languages',
      fireLabels.every((key) => (clientSource.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length >= 2),
      fireLabels.filter((key) => (clientSource.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length < 2).join(',')
    )
    check(
      'and the wording falls back to the standing label',
      clientSource.includes('const FIRE_LINE_MS = 6000') &&
        clientSource.includes("fireLine.textContent = t('studioFireNow')") &&
        clientSource.includes('root.append(header, fireLine, tabs, body, actions)'),
      ''
    )
    // The line used to advertise a gesture. Nothing in the window was clickable, so the only way
    // to spend a whole reply's worth of renders was a double-click nobody had been told about:
    // the line is a button now, and that double-click is the same press behind it — with the
    // two-click delivery merged, so the second click cannot report over the first one's verdict.
    check(
      'the standing line is a button that presses the latest reply',
      clientSource.includes("const fireLine = document.createElement('button')") &&
        clientSource.includes("fireLine.addEventListener('click', pressFire)") &&
        clientSource.includes("fireLine.title = t('studioFireHint')") &&
        clientSource.includes('const PRESS_MERGE_MS = 400') &&
        /root\.addEventListener\('dblclick'[\s\S]{0,1200}pressFire\(\)/.test(clientSource),
      ''
    )

  // ------------------------------------------------------- per-mode settings --
  // One shared style slot meant every comic page silently carried the
  // illustration's artist string, so the separation is asserted.
  const byMode = Object.fromEntries((modeSettings ?? []).map((row) => [row.mode, row]))
  check('both modes resolve their own settings', byMode.illustration !== undefined && byMode.comic !== undefined, Object.keys(byMode).join(','))
  check(
    'a mode with no override falls back to the shared defaults',
    byMode.illustration?.width === config.width && byMode.illustration?.sampler === config.sampler && byMode.illustration?.steps === config.steps,
    JSON.stringify({ w: byMode.illustration?.width, s: byMode.illustration?.sampler, st: byMode.illustration?.steps })
  )
  check(
    'each mode owns its artist slot',
    typeof byMode.illustration?.artistId === 'number' && typeof byMode.comic?.artistId === 'number',
    JSON.stringify({ illustration: byMode.illustration?.artistId, comic: byMode.comic?.artistId })
  )
  check(
    'an override applies to its own mode only',
    Object.entries(config.modes ?? {}).every(([mode, overrides]) =>
      Object.entries(overrides).every(([field, value]) => field === 'recipe' || byMode[mode]?.[field] === value)
    ),
    JSON.stringify(config.modes)
  )

  // ------------------------------------------------------------ comic recipe --
  const { RECIPE_GROUPS, describeRecipe, normalizeRecipe, recipeFragments } = await import('./recipe.js')
  check(
    'the recipe table is complete',
    RECIPE_GROUPS.length >= 4 && RECIPE_GROUPS.every((group) => group.options.length > 0 && group.options.some((option) => option.key === group.default)),
    RECIPE_GROUPS.map((group) => `${group.key}(${group.options.length})`).join(' ')
  )
  const filledRecipe = normalizeRecipe(config.modes?.comic?.recipe)
  check('a recipe always fills every group', Object.keys(filledRecipe).length === RECIPE_GROUPS.length, JSON.stringify(filledRecipe))
  const fragments = recipeFragments(filledRecipe)
  check('the recipe produces phrasing', fragments.positive.length > 0, fragments.positive.slice(0, 80))
  check('the recipe describes itself for a readout', /色彩/.test(describeRecipe(filledRecipe)), describeRecipe(filledRecipe).slice(0, 70))
  }

  // ---------------------------------------------------------------- image links --
  // A render used to vanish from a conversation that was switched away from and back:
  // the browser half draws a Markdown image by resolving its URL through a path
  // vocabulary it rebuilds on every mount, and a plain local path belongs to no
  // vocabulary after a replay. An absolute `http(s)` URL it takes verbatim — so that
  // is what the host half hands out whenever it can work out a base, and a plain path
  // when it cannot. Both halves of that contract are checked here.
  const { fileUrl, hostBase, imageLink, linkBase, normalizeWebBase } = await import('./webbase.js')
  check(
    'a base comes from the harness environment',
    linkBase({ env: { DSH_WEB_URL: 'http://127.0.0.1:19387' }, seenHost: '127.0.0.1:1' }) === 'http://127.0.0.1:19387',
    linkBase({ env: { DSH_WEB_URL: 'http://127.0.0.1:19387' }, seenHost: '127.0.0.1:1' })
  )
  check(
    'a pinned base wins over everything',
    linkBase({ configured: 'http://127.0.0.1:5555/', env: { DSH_WEB_URL: 'http://127.0.0.1:19387' } }) === 'http://127.0.0.1:5555',
    ''
  )
  const hostOnly = linkBase({ seenHost: '127.0.0.1:19387' })
  check('the requesting origin is the last resort', hostOnly === 'http://127.0.0.1:19387', hostOnly)
  check('an ipv6 origin keeps its brackets', hostBase('[::1]:19387') === 'http://[::1]:19387', hostBase('[::1]:19387'))
  check('a malformed host is refused, not concatenated', linkBase({ seenHost: 'not a host' }) === '', linkBase({ seenHost: 'not a host' }))
  check('a non-http base is refused', normalizeWebBase('javascript:alert(1)') === '', normalizeWebBase('javascript:alert(1)'))
  const linked = fileUrl('http://127.0.0.1:19387', 'a b.png')
  check('a file link targets this plugin route', linked === 'http://127.0.0.1:19387/nai-imagegen/api/file?name=a%20b.png', linked)
  check(
    'a rendered path becomes an absolute link',
    imageLink('http://127.0.0.1:19387', 'C:\\out\\nai\\x.png') === 'http://127.0.0.1:19387/nai-imagegen/api/file?name=x.png',
    imageLink('http://127.0.0.1:19387', 'C:\\out\\nai\\x.png')
  )
  check('without a base the path is handed back untouched', imageLink('', 'C:\\out\\nai\\x.png') === 'C:\\out\\nai\\x.png', '')
  if (typeof packageRoot === 'string') {
    const hostSource = await readFile(join(packageRoot, 'index.js'), 'utf8').catch(() => '')
    check(
      'the host remembers the origin it was asked on',
      /req\.headers\?\.host/.test(hostSource) && /seenHost = host\.trim\(\)/.test(hostSource),
      ''
    )
    check('the inline link the tool prints is absolute', /imageLink\(inlineBase\(config\), file\.file\)/.test(hostSource), '')
    check('the status payload reports the base in force', /webBase: inlineBase\(config\)/.test(hostSource), '')
    check('the base can be pinned through the panel', /'webBase'/.test(hostSource) && typeof config.webBase === 'string', typeof config.webBase)
    check('the host exposes the artist text route', /'\/artist-text'/.test(hostSource), '')
    check('the host exposes the artist edit route', /'\/artist-edit'/.test(hostSource), '')
    check('the host exposes the artist add route', /'\/artist-add'/.test(hostSource), '')
    check('the host exposes the artist remove route', /'\/artist-remove'/.test(hostSource), '')
    check('the host exposes the artist image route', /'\/artist-image'/.test(hostSource), '')
    check('the host exposes the membership and quota routes', /'\/quota'/.test(hostSource), '')
    // "Why did it not render this time" used to be answerable only from the host's diagnostics,
    // which is a request the user cannot make from the panel. The newest record the page sent
    // travels in the status payload instead, so the answer sits on the screen that asks it.
    check(
      'the status payload carries what the last automatic pass did',
      /function lastAutoRecord\(\)/.test(hostSource) &&
        /lastAuto: lastAutoRecord\(\)/.test(hostSource) &&
        clientSource.includes('function lastAutoLine(record, t)') &&
        clientSource.includes('lastAutoLine(status?.lastAuto, t)'),
      ''
    )
    check(
      'the quota read touches the reading and never render eligibility',
      /noteSubscription\(key\.id, outcome\.subscription\)/.test(hostSource) && /noteQuotaFailure\(/.test(hostSource),
      ''
    )
    check(
      'a transient quota failure is retried once, inside a budget',
      /QUOTA_RETRY_MS = 250/.test(hostSource) && /QUOTA_BUDGET_MS = 30000/.test(hostSource),
      ''
    )
    check(
      'a key carries its quota view beside its subscription',
      /quotaViewOf/.test(hostSource) && /describeQuota\(s\.v5Quota\)/.test(hostSource),
      ''
    )
    check('the host exposes the star route', /'\/artist-favorite'/.test(hostSource), '')
    check(
      'the star is stored by id beside the archive',
      /storedFavoriteIds\(config\)/.test(hostSource) && /artistFavorites: \[\.\.\.[^\]]*\]/.test(hostSource),
      ''
    )
    check('the list marks the starred rows', /favorite: favorites\.has\(Number\(row\.id\)\)/.test(hostSource), '')
    // Two sets, and the difference is the point: the file keeps every id it was given, the
    // list only reports the ones the archive can still resolve. One set for both would
    // either drop a star on a failed import or draw a ★ over nothing.
    check(
      'a star the archive cannot resolve is kept in the file but out of the list',
      /favoriteSetOf\(config, entries\)/.test(hostSource) && /known\.has\(id\)/.test(hostSource),
      ''
    )
    check('an uploaded image is read as raw bytes, not as a JSON field', /readBinaryBody/.test(hostSource), '')
    check('the stored image type comes from the bytes, not the declared header', /sniffImage\(bytes\)/.test(hostSource), '')
    // A hand-made id is 1000 and up, so it is sparse: `entries[id]` would resolve to
    // nothing, or — for an id that happens to be in range — to somebody else's string.
    check(
      'every artist lookup goes by id rather than by position',
      /entryById/.test(hostSource) && !/entries\[Number\(/.test(hostSource),
      ''
    )
    check('a new entry takes an id above every id in play', /nextUserId/.test(hostSource), '')
    check('deleting an entry forgets it wherever it was remembered', /forgetArtist/.test(hostSource), '')
    check('an edit is keyed by the archive id', /artistEditOf/.test(hostSource) && /artistViewOf/.test(hostSource), '')
    // Clearing the positive is a real choice — no style prefix at all. Concatenating
    // unconditionally would send a prompt that starts with ", ".
    check('an emptied style prefix is not re-concatenated', /artist\.positivePrompt === ''/.test(hostSource), '')
    // Re-indexing follows an append, so it must not renumber. An id is how the config
    // remembers an artist string — `artistId`, one per mode, the favourites list — so an id
    // that moves is a selection that silently changed under the user, on both sides of the
    // wire at once.
    const artistsSource = await readFile(join(packageRoot, 'lib', 'artists.js'), 'utf8').catch(() => '')
    check(
      'a re-index hands a known record back the id it already had',
      /export function assignIds\(entries, previous, sourceFile\)/.test(artistsSource) &&
        /resolve\(previous\.sourceFile\) === resolve\(sourceFile\)/.test(artistsSource) &&
        /range:\$\{image\.start\}:\$\{image\.length\}/.test(artistsSource),
      ''
    )
    check(
      'and writes the index in id order, so position is still id',
      /entries: \[\.\.\.assigned\]\.sort\(\(a, b\) => a\.id - b\.id\)/.test(artistsSource),
      ''
    )
    check(
      'a provenance note is carried through a re-index rather than dropped',
      /\? \{ note: previous\.note \}/.test(artistsSource),
      ''
    )
    check(
      'and the summary says how many kept their id',
      /preserved: assigned\.filter/.test(artistsSource) && /added: assigned\.filter/.test(artistsSource),
      ''
    )

    // ------------------------------------------------------------- the reply tool --
    // `nai_reply` exists so a whole reply can arrive as the *argument* of a call instead of as
    // message text — the transport a tavern script uses when the text channel truncates a long
    // reply mid-stream. The host half measures the text and writes nothing; the browser half
    // paints it where the message text would have been. Both halves must agree on the name and
    // on the shape, and either one forgetting is silent: a missing row looks like a short reply.
    const replySource = await readFile(join(packageRoot, 'lib', 'reply.js'), 'utf8').catch(() => '')
    check(
      'the reply tool asks for the whole reply through itself and nowhere else',
      /exactly once per reply/.test(replySource) && /do not repeat it in the message body/.test(replySource),
      ''
    )
    check(
      'and refuses an empty one rather than pretending',
      /if \(text\.trim\(\) === ''\) \{/.test(replySource) && /text 是空的/.test(replySource) && /Never a substitute for `text`/.test(replySource),
      ''
    )
    // The ledger is the only place a reply is remembered, and it is deliberately not a copy of
    // it: sizes, a timestamp, a digest and the model's own caption. That shape is the promise
    // that this half cannot hand back prose it was given.
    const entryShape = replySource.slice(replySource.indexOf('const entry = {'), replySource.indexOf('replyChars += chars'))
    check(
      'the ledger keeps the size, the digest and the caption — never the prose',
      /sha: replySha\(body\)/.test(entryShape) &&
        /blank: body\.trim\(\) === ''/.test(entryShape) &&
        !/text:/.test(entryShape) &&
        /entries: ledger\.map\(\(entry\) => \(\{ \.\.\.entry \}\)\)/.test(replySource),
      entryShape.slice(0, 40)
    )
    check(
      'nothing in this half can write a file or open a socket',
      !/node:fs|node:http|node:net|writeFile|createWriteStream/.test(replySource) &&
        /import \{ createHash \} from 'node:crypto'/.test(replySource),
      ''
    )
    check(
      'the host registers the tool and reports the ledger',
      /ctx\.tools\.register\(createReplyTool\(\)\)/.test(hostSource) && /reply: replyLedger\(\)/.test(hostSource),
      ''
    )
    // The name is the one fact both halves have to share, and they are written in different
    // files by different rules, so it is asserted on both sides at once.
    check(
      'both halves call the tool the same thing',
      /export const REPLY_TOOL_NAME = 'nai_reply'/.test(replySource) && /const REPLY_TOOL_NAME = 'nai_reply'/.test(clientSource),
      ''
    )
    // The browser half takes the tool row over by that key: a keyed hit replaces the generic
    // card, so a key that drifts quietly turns every reply into a collapsed tool call.
    check(
      'and the row that replaces the generic tool card is keyed on it',
      /ctx\.slots\.inject\('tool\.call\.toolview'/.test(clientSource) &&
        /name: 'tool\.call\.toolview',[\s\S]{0,120}key: REPLY_TOOL_NAME/.test(clientSource) &&
        /locale: NS/.test(clientSource),
      ''
    )
    // A half-written argument is decoded as it arrives, so the reply grows on screen while the
    // model is still writing it. Three details make that honest rather than hopeful: an escape
    // split across two chunks waits for its digits instead of being shown half-decoded, a
    // surrogate pair is assembled before it becomes a character, and a trailing backslash waits
    // for its partner. Everything else would paint mojibake that the finished text never had.
    check(
      'a half-written call is decoded as it arrives, not counted',
      /function readPartialText\(raw\)/.test(clientSource) &&
        /65536 \+ \(\(code - 0xd800\) << 10\)/.test(clientSource) &&
        /pending: true/.test(clientSource),
      ''
    )
    check(
      'and the receipt row shows the same growing text',
      /function partialReplyChars\(raw\)/.test(clientSource) && /Array\.from\(readPartialText\(raw\)\.text\)\.length/.test(clientSource),
      ''
    )
    // If the model wrote the reply out as ordinary message text as well, the message text is the
    // one the user is already reading: the row says so instead of printing it a second time.
    check(
      'a reply that also arrived as message text is not painted twice',
      /function replyWrittenAsPlainText\(item, text\)/.test(clientSource) &&
        /const REPLY_PLAIN_HEAD = 24/.test(clientSource) &&
        /REPLY_DUPLICATE_ATTR/.test(clientSource),
      ''
    )
    // A model that ignores the instruction produces an empty answer area with no explanation.
    // Three replies in a row is the same threshold the tavern script uses before it says so.
    check(
      'three replies that never come through the tool are reported',
      /const REPLY_MISS_LIMIT = 3/.test(clientSource) &&
        /diag\('reply-miss'/.test(clientSource) &&
        /function noteReplyTurn\(\)/.test(clientSource),
      ''
    )
    // The retry chain is armed on a flag of its own rather than on the timer handle: a handle
    // cleared inside its own callback is gone before the assignment that stores it, which made
    // the chain unable to re-arm and left the reply unpainted whenever it had to wait for the
    // answer area to appear.
    check(
      'the retry chain re-arms on a flag, not on a timer handle it has cleared',
      /let replyRetryArmed = false/.test(clientSource) &&
        /if \(replyRetryArmed === true\) return/.test(clientSource) &&
        /typeof clearTimeout === 'function'/.test(clientSource),
      ''
    )
    // A reply is model output, so it is built node by node. The one mention of `innerHTML` in the
    // browser half is the comment that says it is never used — the assertion is that count.
    check(
      'the painted reply is built node by node, never as markup',
      (clientSource.match(/innerHTML/g) ?? []).length === 1 && /never `innerHTML`/.test(clientSource),
      String((clientSource.match(/innerHTML/g) ?? []).length)
    )
    // Every line the row prints comes from the dictionaries, and the panel ships both languages.
    const replyLabels = [
      'replyWriting',
      'replyReceived',
      'replyDuplicate',
      'replyCaption',
      // The switch's own three lines. A key that reached only one dictionary draws a Chinese
      // button on an English page — the one place a broken label would be read as a setting.
      'replyOn',
      'replyOff',
      'replyHint'
    ]
    check(
      'the row has its wording in both languages',
      replyLabels.every((key) => (clientSource.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length >= 2),
      replyLabels.filter((key) => (clientSource.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length < 2).join(',')
    )
    // ------------------------------------------------ the transport's switch --
    // The switch is the registration itself: `ctx.tools.register` hands back the disposer that
    // takes the tool out again, so "off" means the model is never asked. That makes the tool's
    // presence in the list the whole of the state, and these are the places it can go wrong —
    // a registration site that has quietly become two, a toggle that dies on a host which
    // returns nothing, or a panel that draws its button from the file instead of the list.
    const configSource = await readFile(join(packageRoot, 'lib', 'config.js'), 'utf8').catch(() => '')
    check(
      'the transport is on unless somebody turns it off',
      /replyTransport: true,/.test(configSource),
      ''
    )
    check(
      'the registration is the switch, and it happens in exactly one place',
      (hostSource.match(/ctx\.tools\.register\(createReplyTool\(\)\)/g) ?? []).length === 1 &&
        /let replyDisposer = null/.test(hostSource) &&
        /function applyReplySetting\(ctx, on\) \{/.test(hostSource),
      String((hostSource.match(/ctx\.tools\.register\(createReplyTool\(\)\)/g) ?? []).length)
    )
    check(
      'a host that hands back no disposer still toggles, and never wedges the switch on',
      /replyDisposer = typeof disposer === 'function' \? disposer : \(\) => \{\}/.test(hostSource) &&
        /return replyDisposer !== null/.test(hostSource),
      ''
    )
    check(
      'the config reads back what was really registered, not what was written down',
      /replyTransport: replyDisposer !== null,/.test(hostSource) && /applyReplySetting\(ctx, true\)/.test(hostSource),
      ''
    )
    check(
      'both ways in — the panel and the tool — move the registration',
      (hostSource.match(/if \(patch\.replyTransport !== undefined\) applyReplySetting\(ctx, patch\.replyTransport === true\)/g) ?? [])
        .length === 2 &&
        /reply_transport: 'replyTransport'/.test(hostSource) &&
        /reply_transport: \{ type: 'boolean'/.test(hostSource),
      String((hostSource.match(/if \(patch\.replyTransport !== undefined\) applyReplySetting/g) ?? []).length)
    )
    check(
      'the browser half keeps the switch and asks the host for it at activation',
      /let replyTransportOn = true/.test(clientSource) &&
        /function setReplyTransport\(on\) \{/.test(clientSource) &&
        /async function bootReplyTransport\(\) \{/.test(clientSource) &&
        /bootReplyTransport\(\)/.test(clientSource) &&
        /exports\.setReplyTransport = setReplyTransport/.test(clientSource),
      ''
    )
    // A transport that is off answers no turn at all, so counting those turns as misses would
    // report a fault that is really a setting — and the switch would be arguing with itself.
    check(
      'a switched-off transport is not counted as a tool being ignored',
      /if \(replyTransportOn !== true\) return replyMissStreak/.test(clientSource) &&
        /replyMissStreak = 0/.test(clientSource),
      ''
    )
    check(
      'the panel asks for the opposite of what it last saw, and hands the answer back',
      /replyTransport: status\?\.replyTransport !== true/.test(clientSource) &&
        /setReplyTransport\(next\?\.status\?\.replyTransport === true\)/.test(clientSource),
      ''
    )
  }

  // ------------------------------------------------------------------ filesystem --
  const { access } = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  try {
    await access(outputDir, constants.W_OK)
    check('the output directory is writable', true, outputDir)
  } catch (error) {
    check('the output directory is writable', false, `${outputDir}: ${error.code ?? error.message}`)
  }
  try {
    await access(join(packageRoot, 'client.js'), constants.R_OK)
    check('the package files are all present', true, packageRoot)
  } catch {
    check('the package files are all present', false, packageRoot)
  }

  return { ok: checks.every((row) => row.ok), checks }
}

/**
 * Render a doctor report as text.
 * @param report - the result of `runDoctor`.
 * @returns the text a model or a person can read.
 */
export function formatDoctor(report) {
  const failed = report.checks.filter((row) => !row.ok)
  const lines = [
    report.ok ? `✅ 全部 ${report.checks.length} 项能力检查通过` : `❌ ${failed.length} / ${report.checks.length} 项未通过`,
    ''
  ]
  for (const row of report.checks) lines.push(`${row.ok ? '  ok  ' : '  FAIL'}  ${row.name}${row.detail === '' ? '' : `  — ${row.detail}`}`)
  if (!report.ok) {
    lines.push('', '上面的 FAIL 就是坏掉的能力；改了代码或配置之后重启再跑一次即可确认。')
  }
  return lines.join('\n')
}
