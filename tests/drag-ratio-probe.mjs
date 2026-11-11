/**
 * dsh-nai-imagegen — probes for the aspect-ratio presets, the restart signal and the
 * two draggable things.
 *
 * These are source-level assertions on top of the behavioural suite: the studio and the
 * launcher are DOM code that only exists in a browser, and a regression there is silent
 * (a control that does nothing) rather than loud (an exception). Pinning the wiring is
 * what keeps it from silently reverting.
 *
 * Run: node tests/drag-ratio-probe.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RATIOS, defaults, load, ratioOf, save } from '../lib/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = await readFile(join(root, 'client.js'), 'utf8')
const host = await readFile(join(root, 'index.js'), 'utf8')

let passed = 0
let failed = 0
/**
 * Record one assertion.
 * @param name - what is being checked.
 * @param ok - whether it holds.
 * @param detail - shown either way.
 */
function ok(name, theAnswer, detail = '') {
  if (theAnswer === true) {
    passed++
    return
  }
  failed++
  console.log(`  ✗ ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

// --------------------------------------------------------------- ratio presets --
ok('the ratio table is not empty', RATIOS.length >= 4, String(RATIOS.length))
const duplicateKeys = RATIOS.length !== new Set(RATIOS.map((row) => row.key)).size
ok('ratio keys are unique', duplicateKeys === false)
for (const row of RATIOS) {
  ok(`${row.key} sides are multiples of 64`, row.width % 64 === 0 && row.height % 64 === 0, `${row.width}x${row.height}`)
  // The free band. Anything larger bills Anlas on an Opus subscription, which would be
  // a surprising thing for a preset labelled as a shape to do.
  ok(`${row.key} stays inside the free band`, row.width * row.height <= 1024 * 1024, String(row.width * row.height))
  ok(`${row.key} covers the origin`, row.width > 0 && row.height > 0)
  ok(`${row.key} has a label`, typeof row.label === 'string' && row.label !== '')
}
for (const row of RATIOS) {
  ok(`ratioOf finds ${row.key}`, ratioOf(row.width, row.height) === row.key, String(ratioOf(row.width, row.height)))
}
// The whole point of the custom entry: a hand-typed size is not a preset, and claiming
// the nearest one would misreport what is about to be rendered.
ok('ratioOf refuses a non-preset size', ratioOf(900, 1200) === null, String(ratioOf(900, 1200)))
ok('ratioOf refuses a partial match', ratioOf(832, 1024) === null, String(ratioOf(832, 1024)))
ok('ratioOf coerces numeric strings', ratioOf('832', '1216') === '2:3', String(ratioOf('832', '1216')))
ok('ratioOf tolerates non-numbers', ratioOf(undefined, null) === null)

// ------------------------------------------------------------------- config --
const shipped = defaults()
ok('displayClickZoom ships as a boolean', typeof shipped.displayClickZoom === 'boolean', typeof shipped.displayClickZoom)
ok('displayClickZoom ships on', shipped.displayClickZoom === true)
const before = await load()
ok('the stored displayClickZoom is a boolean', typeof before.displayClickZoom === 'boolean', typeof before.displayClickZoom)
// Round-trip it, because `normalize` coerces by type and a boolean reaching the string
// branch becomes "true", which no `=== true` check can ever satisfy.
await save({ displayClickZoom: false })
const off = await load()
ok('displayClickZoom survives a save as a boolean', typeof off.displayClickZoom === 'boolean', typeof off.displayClickZoom)
ok('displayClickZoom can be turned off', off.displayClickZoom === false)
await save({ displayClickZoom: true })
ok('displayClickZoom can be turned back on', (await load()).displayClickZoom === true)

// -------------------------------------------------------------- host wiring --
ok('the host imports the ratio table', /RATIOS/.test(host) && /from '\.\/lib\/config\.js'/.test(host))
ok('the host publishes the ratios to the panel', /ratios: RATIOS\.map/.test(host))
ok('the host measures staleness', /async function staleCode\(\)/.test(host))
ok('the host compares against the process start', /process\.uptime\(\)/.test(host))
ok('the host publishes the restart signal', /restart: await staleCode\(\)/.test(host))
ok('the host publishes clickZoom', /clickZoom: config\.displayClickZoom !== false/.test(host))
// The display is one overall scale, so the retired cap must not be forwarded from the
// config either: a cap nothing in the window can set would still crop every page on
// load, which is the exact failure the second control was removed to prevent.
ok(
  'the host does not forward the retired height cap',
  /maxHeight: 0,/.test(host) && !/maxHeight: config\.displayMaxHeight/.test(host)
)
ok('staleness watches the entry point', /'index\.js'/.test(host) && /MODULE_FILES/.test(host))
ok('staleness watches the browser half', /'client\.js',/.test(host))

// ------------------------------------------------------------- studio wiring --
ok('the studio offers a ratio select', /status\.ratios/.test(client))
ok('the ratio select fills both dimensions', /current\.width = entry\.width/.test(client) && /current\.height = entry\.height/.test(client))
ok('the ratio select repaints on change', /if \(entry === undefined\) return\n          current\.width/.test(client))
ok('a typed size moves the ratio select', /if \(field\.key === 'width' \|\| field\.key === 'height'\) syncRatio\(\)/.test(client))
ok('the custom ratio names its own size', /studioRatioCustom/.test(client))
ok('the restart warning is rendered', /status\.restart\?\.needed === true/.test(client))
ok('i18n has the ratio label', /studioRatio: '比例'/.test(client) && /studioRatio: 'Ratio'/.test(client))
ok('i18n has the restart warning', /restartNeeded:/.test(client))

// ------------------------------------------------------------ display scale --
// One overall factor. The image is drawn at some width and its height is whatever its
// own ratio makes it, so a second independent height control is precisely what would
// distort it — `height: auto` is the rule that keeps the two axes locked together.
ok('the display is a single overall scale', !/t\('displayHeight'\)/.test(client))
ok('the display height follows the image ratio', /'  height: auto !important;'/.test(client))
ok('the scale lives in the settings panel, not the floating window', /const displayScale = Number\(form\.displayWidth/.test(client))
ok('the scale control is a percentage select', /displayChoices\.map\(\(percent\) => h\('option'/.test(client))
ok('the scale offers a usable range', /const DISPLAY_SCALES = \[100, 90, 80, 70, 60, 50, 40, 33, 25\]/.test(client))
ok('a hand-typed scale is still selectable', /\[\.\.\.DISPLAY_SCALES, displayScale\]/.test(client))
ok('the display controls left the floating window', !/draftDisplay/.test(client) && !/studioDisplay/.test(client))
ok('the panel saves the scale as a number', /'keepImages', 'displayWidth'\]/.test(client))
ok('saving the panel repaints the stylesheet', /refreshImageSizing\?\.\(\)/.test(client))
ok('the retired cap is not read back from the config', !/maxHeight: Number\(status\.display\?\.maxHeight/.test(client))
ok('the scale is labelled as a scale', /displayWidth: '显示比例'/.test(client) && /displayWidth: 'Display scale'/.test(client))
ok('the default scale is the documented 60', defaults().displayWidth === 60, String(defaults().displayWidth))
// Enlarging is an overlay over the page, never a change to the picture's own layout: a
// rule that rewrites the size of a clicked image moves the whole conversation around and
// fights any container that sized it — which is exactly what broke the sidebar grid.
ok('nothing resizes a clicked image in place', !/ZOOM_ATTR/.test(client))
ok('the enlargement is an overlay over the page', /position: 'fixed'/.test(client) && /zIndex: '2147483000'/.test(client))
ok(
  'the overlay shows the picture that was clicked',
  /function openLightbox\(image[,)]/.test(client) && /image\?\.currentSrc/.test(client)
)
ok('the overlay picture cannot be shrunk by the scale', /setProperty\(property, value, 'important'\)/.test(client))
ok('the overlay is a control surface of its own', /overlay\.setAttribute\(STUDIO_MARK, 'lightbox'\)/.test(client))
ok('clicking the backdrop closes the overlay', /overlay\.addEventListener\('click', closeLightbox\)/.test(client))
ok('escape closes the overlay', /event\?\.key === 'Escape'/.test(client))
ok('closing really removes it', /lightbox\.remove\(\)/.test(client))

// ------------------------------------------------------------- the strip --
// The enlargement is a viewer, not a dead end. Comparing two attempts at one prompt is the
// single most common thing anyone does with these pictures, and without a strip that means
// closing this, scrolling the conversation and clicking the other one.
ok('the enlargement carries a strip of earlier renders', /const LIGHTBOX_STRIP_STYLE = \{/.test(client) && client.includes("api('/gallery?limit=200')"))
ok('the strip is a control surface of its own', client.includes("strip.setAttribute(STUDIO_MARK, 'lightbox-strip')"))
ok('the strip shows which picture is on screen', /\$\{index \+ 1\} \/ \$\{items\.length\}/.test(client))
ok(
  'a thumbnail switches the picture without closing the overlay',
  /thumb\.addEventListener\('click', \(event\) => \{/.test(client) && client.includes('event.stopPropagation()\n          show(at)')
)
ok(
  'the arrow keys walk the strip',
  client.includes("event?.key === 'ArrowLeft'") &&
    client.includes("event?.key === 'ArrowRight'") &&
    client.includes('lightboxStrip.index() + 1')
)
ok('the picture is never covered by the strip', client.includes("padding: '104px 2vw 3vh'") && client.includes("maxHeight: 'calc(100vh - 140px)'"))
ok('the strip goes away with the overlay', client.includes('if (lightboxStrip !== null) lightboxStrip = null'))

// --------------------------------------------------------- click to enlarge --
// This plugin's own pictures answer a click. Another plugin's picture is that plugin's to
// handle, so it must not; and chrome must not either, because `width: 100%` on an icon in a
// toolbar wrecks the layout it sits in.
ok('any content image is zoomable', /function isZoomableImage\(image\)/.test(client))
ok('only this plugin’s own pictures are zoomable', client.includes('if (!isOurOutput(image)) return false'))
ok('a render is identified by name, not by size', !client.includes('width >= 256 && height >= 256'))
ok('the zoom selector is the mark, not our own output', /img\[\$\{ZOOMABLE_ATTR\}="1"\] \{/.test(client))
ok('our own window is not zoomable', /image\.closest\(`\[\$\{STUDIO_MARK\}\]`\)/.test(client))
ok('an icon inside a control is not zoomable', /image\.closest\(control\) !== null\) return false/.test(client))
ok('a tiny image is not zoomable', /Math\.max\(width, height\) >= ZOOM_MIN_PIXELS/.test(client))
ok('the settings panel is not treated as content', /\[STUDIO_MARK\]: 'panel'/.test(client))
ok('a picture wrapped in a plain link still enlarges', /const anchor = image\.closest\('a\[href\]'\)/.test(client))
ok('a link that opens elsewhere is left alone', /anchor\.target \?\? ''\) === '_blank'/.test(client))
ok('the claimed count is state, not a render side effect', /setClaimed\(claimRenderImages\(\)\)/.test(client))
ok('the count is reported in the panel', /t\('displayFound'\)\}：\$\{claimed\}/.test(client))
ok(
  'the new state hook sits below every slot the fixtures seed',
  /const \[newLabel, setNewLabel\] = React\.useState\(''\)[\s\S]{0,400}?const \[claimed, setClaimed\] = React\.useState\(0\)/.test(client)
)
ok('an undecoded image is left for a later pass', /if \(width === 0 && height === 0\) return false/.test(client))
ok('every image on the page gets swept', /function markZoomables\(\)/.test(client) && /querySelectorAll\('img'\)/.test(client))
ok('a stale mark is dropped when an image stops qualifying', /removeAttribute\?\.\(ZOOMABLE_ATTR\)/.test(client))
ok('a click opens the overlay', /openLightbox\(target[,)]/.test(client))
ok('a click before the sweep still enlarges', /if \(!isZoomableImage\(target\)\) return/.test(client))
ok('the enlargement can be switched off', /if \(!clickZoomOn\) return/.test(client))
ok('switching it off drops the zoom rules', /if \(display\?\.clickZoom !== false\) \{/.test(client))
ok('the switch is saved from the panel', /displayClickZoom: event\.target\.checked/.test(client))

// ------------------------------------------------------------- image claiming --
// The host serves the bytes under an opaque `/attachments/v1/objects/…` address, so a
// selector on the output path matches nothing. The mark is the only thing that can
// match — and since git-blame cannot tell a rule that matches nothing from a rule that
// does nothing, the claim pass is pinned here rather than trusted.
ok('the claim pass exists', /function claimRenderImages\(\)/.test(client))
ok('the claim pass marks by the attribute the rules select on', /img\[\$\{IMG_ATTR\}="1"\]/.test(client))
ok('the claim pass reuses the menu predicate', /if \(!isOurOutput\(image\)\) continue/.test(client))
ok('one sweep does both jobs', /return \{ claimed: claimRenderImages\(\), zoomable: markZoomables\(\) \}/.test(client))
// The panel's thumbnails are full-size reference images, so the intrinsic-size test would
// claim them and the scale would then stretch the artist grid.
ok(
  'the claim pass leaves the control surfaces alone',
  /image\.closest\(`\[\$\{STUDIO_MARK\}\]`\) !== null\) \{[\s\S]{0,140}?image\.removeAttribute\?\.\(IMG_ATTR\)/.test(client)
)
ok('the menu does not adopt a control-surface thumbnail', /const inStudio =/.test(client) && /\(!inStudio \|\| inLightbox\) && isOurOutput\(candidate\)/.test(client))
// The viewer is the exception: a control surface that holds content, and the place the picture
// is biggest — the one spot where a refusal to claim it means refusing the very picture someone
// opened full size in order to copy.
ok(
  'and reaches into the viewer, the one surface that is content',
  /const inLightbox =/.test(client) &&
    client.includes('closest(`[${STUDIO_MARK}="lightbox"]`)') &&
    /\(!inStudio \|\| inLightbox\)/.test(client)
)
ok('the sweep runs when the stylesheet is installed', /^\s{6}sweepImages\(\)$/m.test(client))
ok('a newly decoded image is swept in the capture phase', /addEventListener\('load', sweepSoon, true\)/.test(client))
ok('a new transcript node is swept too', /new MutationObserver\(sweepSoon\)/.test(client))
ok('the sweep is debounced, not per mutation', /if \(sweepPending\) return/.test(client))
ok('the sweep listeners are removed on dispose', /removeEventListener\('load', sweepSoon, true\)/.test(client))
ok('the rules outrank a later stylesheet', /% !important;/.test(client))
// "No image matched" and "the rule lost" look identical on screen; the count is the
// difference, so it has to be shown and it has to be able to say something.
ok('the panel reports how many images were claimed', /t\('displayFound'\)/.test(client))
ok('that report is filled in from the live document', /\$\{t\('displayFound'\)\}：\$\{claimed\}/.test(client))
ok('the report is translated both ways', /displayFound: '已识别正文图片'/.test(client) && /displayFound: 'Images claimed'/.test(client))

// --------------------------------------------------------------- drag wiring --
// Both draggables: capture, so the pointer is not lost the moment it leaves the node;
// viewport coordinates, because `offsetLeft` is relative to the offset parent and a
// fixed element has none; and a cancel listener, so a dropped pointer cannot leave a
// drag stuck on.
ok('the studio window captures the pointer', /root\.setPointerCapture/.test(client))
ok('the studio window measures in viewport coordinates', /const rect = root\.getBoundingClientRect\(\)/.test(client))
ok('the studio window no longer reads offsetLeft for the drag', !/dragging = \{ x: event\.clientX[\s\S]{0,120}offsetLeft/.test(client))
ok('the studio window handles a cancelled pointer', /root\.addEventListener\('pointercancel', endDrag\)/.test(client))
ok('the studio window drags from anywhere', /root\.addEventListener\('pointerdown', beginDrag\)/.test(client))
ok('the drag ignores the controls', /DRAG_IGNORE/.test(client) && /closest\(DRAG_IGNORE\)/.test(client))

ok('the launcher captures the pointer', /launcher\.setPointerCapture/.test(client))
ok('the launcher measures in viewport coordinates', /const rect = launcher\.getBoundingClientRect\(\)/.test(client))
ok('the launcher handles a cancelled pointer', /launcher\.addEventListener\('pointercancel', endLauncherPress\)/.test(client))
ok('the launcher position is remembered', /LAUNCHER_POS/.test(client) && /localStorage\?\.setItem/.test(client))
ok('the launcher position is restored', /applyLauncherPos\(readLauncherPos\(\)\)/.test(client))
// An off-screen saved position would look like the plugin had disappeared, so it is
// discarded rather than honoured.
ok('an off-screen saved position is discarded', /left > viewportWidth - 20/.test(client))
ok('a drag suppresses the click that follows', /if \(suppressClick\)/.test(client) && /suppressClick = true/.test(client))
ok('a small wobble still counts as a click', /DRAG_SLOP/.test(client))
ok('the launcher asks for no touch gestures', /touch-action:none/.test(client))
ok('the launcher no longer pins itself to the corner in cssText', !/style\.cssText =[\s\S]{0,200}right:18px;bottom:18px/.test(client))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
