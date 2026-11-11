/**
 * dsh-nai-imagegen — one-shot bootstrap from a git checkout.
 *
 * The normal install path (`install.mjs`) assumes the package already sits
 * somewhere permanent and only points the profile at it. This script closes the
 * remaining gap: it takes a freshly cloned copy of the package, parks it in a
 * stable directory, and then performs the same three-step profile install.
 *
 * Two install modes:
 *
 *   link (default) — copy the package to `--dest`, record
 *                    `"dsh-nai-imagegen": "link:<dest>"` in the profile manifest,
 *                    append it to `dsh.profile.bundles`, then run `pnpm install`
 *                    so the profile's node_modules receives the link.
 *   copy           — copy the package straight into
 *                    `<profile>/node_modules/dsh-nai-imagegen` and append it to
 *                    `dsh.profile.bundles`. No pnpm, no manifest dependency, so
 *                    this is the fallback for machines without pnpm.
 *
 * Dry run by default. Every manifest write is preceded by a timestamped backup.
 *
 * Usage (run it from the cloned package directory):
 *   node bootstrap.mjs                        show the plan
 *   node bootstrap.mjs --apply                link-install into this machine's profile
 *   node bootstrap.mjs --apply --mode copy    install without pnpm
 *   node bootstrap.mjs --dest D:\dsh-bundles\dsh-nai-imagegen --apply
 *   node bootstrap.mjs --uninstall --apply    reverse either mode
 *
 * Options:
 *   --dest <dir>          where the package copy lives (default: <DSH home>/bundles/dsh-nai-imagegen)
 *   --profile-dir <dir>   profile directory to modify (default: <DSH home>/profiles/<profile>)
 *   --mode link|copy      install mode (default: link)
 *   --no-pnpm             skip the `pnpm install` step (link mode only)
 *   --apply               write instead of print
 *   --uninstall           reverse the install
 *   --keep-source         do not delete the source clone (it is never deleted; flag kept for clarity)
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package name as it appears in the profile manifest and in `dsh.profile.bundles`. */
const PACKAGE_NAME = 'dsh-nai-imagegen'
/** DSH home; matches the runtime fallback used by the host. */
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/** Active profile name, e.g. `desktop`. */
const PROFILE = process.env.DSH_PROFILE || 'desktop'
/** This package's root, derived from the script location. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)))

/** Files never copied out of a checkout: dependencies, backups, scratch scripts. */
const SKIP = new Set(['node_modules', '.git'])

const argv = process.argv.slice(2)

/**
 * Read one `--flag value` option.
 * @param name - the flag without dashes.
 * @param fallback - value when the flag is absent.
 * @returns the resolved string.
 */
function option(name, fallback) {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) return fallback
  return value
}

const apply = argv.includes('--apply')
const uninstall = argv.includes('--uninstall')
const runPnpm = !argv.includes('--no-pnpm')
const mode = option('mode', 'link')
const dest = resolve(option('dest', join(HOME, 'bundles', PACKAGE_NAME)))
const profileDir = resolve(option('profile-dir', process.env.DSH_PROFILE_DIR || join(HOME, 'profiles', PROFILE)))
const manifestPath = join(profileDir, 'package.json')
const nodeModulesPath = join(profileDir, 'node_modules', PACKAGE_NAME)

/**
 * Print one planned change.
 * @param line - the description.
 */
function plan(line) {
  console.log(`${apply ? '  ->' : '  · '} ${line}`)
}

/**
 * Whether a path exists.
 * @param path - absolute path.
 * @returns true when it is reachable.
 */
async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Copy the package tree, skipping dependencies, git metadata, backups and
 * scratch scripts so a second machine gets exactly what the repo carries.
 * @param from - source directory.
 * @param to - destination directory (created, replaced file-by-file).
 */
async function copyPackage(from, to) {
  await mkdir(to, { recursive: true })
  const entries = await readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    if (/^_.*\.tmp\.mjs$/.test(entry.name)) continue
    if (/\.bak-\d/.test(entry.name)) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copyPackage(source, target)
    else await cp(source, target, { force: true })
  }
}

/**
 * Write the profile manifest, backing up whatever it replaces.
 * @param text - the new content.
 */
async function writeManifest(text) {
  if (!apply) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await copyFile(manifestPath, `${manifestPath}.bak-${stamp}`)
  await writeFile(manifestPath, text, 'utf8')
  console.log(`     备份 → ${manifestPath}.bak-${stamp}`)
}

/**
 * Run `pnpm install` in the profile so a `link:` dependency materialises.
 * Resolves with the child's exit code; a missing pnpm is not an error here,
 * because the caller prints the manual command instead.
 * @returns the exit code.
 */
function pnpmInstall() {
  return new Promise((done) => {
    const child = spawn('pnpm', ['install'], { cwd: profileDir, stdio: 'inherit', shell: true })
    child.on('error', () => done(-1))
    child.on('exit', (code) => done(code ?? -1))
  })
}

console.log(`profile : ${PROFILE}`)
console.log(`目录    : ${profileDir}`)
console.log(`包源    : ${packageRoot}`)
console.log(`目标    : ${mode === 'copy' ? nodeModulesPath : dest}`)
console.log(`模式    : ${apply ? 'APPLY' : 'DRY RUN'}${uninstall ? ' (uninstall)' : ''} · ${mode}\n`)

if (mode !== 'link' && mode !== 'copy') {
  console.error(`未知模式：${mode}（只支持 link 或 copy）`)
  process.exit(1)
}

let manifest
try {
  // Profiles written by Windows editors often carry a UTF-8 BOM, which JSON.parse
  // rejects; strip it rather than asking the user to re-save their manifest.
  manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''))
} catch (error) {
  console.error(`读不到 profile 清单：${manifestPath}\n${error.message}\n`)
  console.error('如果你的 DSH 装在不同的 profile 下，用 --profile-dir 指定它的目录，')
  console.error('或者先设置 DSH_PROFILE / DSH_HOME 再跑这个脚本。')
  process.exit(1)
}

const dependencies = manifest.dependencies ?? {}
const bundles = manifest.dsh?.profile?.bundles ?? []
const spec = `link:${dest.replace(/\\/g, '/')}`

if (uninstall) {
  console.log('将要撤销：')
  const known = dependencies[PACKAGE_NAME] !== undefined || bundles.includes(PACKAGE_NAME)
  if (!known) {
    console.log('  （清单里没有安装记录，只会清理目录）')
  } else {
    if (dependencies[PACKAGE_NAME] !== undefined) plan(`移除依赖 ${PACKAGE_NAME}（当前 ${dependencies[PACKAGE_NAME]}）`)
    if (bundles.includes(PACKAGE_NAME)) plan(`从 dsh.profile.bundles 移除 ${PACKAGE_NAME}`)
  }
  if (await exists(dest)) plan(`删除目录 ${dest}`)
  if (await exists(nodeModulesPath)) plan(`删除目录 ${nodeModulesPath}`)

  const nextDeps = { ...dependencies }
  delete nextDeps[PACKAGE_NAME]
  const next = {
    ...manifest,
    dependencies: nextDeps,
    dsh: {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: bundles.filter((name) => name !== PACKAGE_NAME) }
    }
  }
  await writeManifest(`${JSON.stringify(next, null, 2)}\n`)
  if (apply) {
    await rm(dest, { recursive: true, force: true })
    await rm(nodeModulesPath, { recursive: true, force: true })
  }
  console.log(`\n${apply ? '已撤销。重启 DSH 后侧栏图标消失。' : '只是预演，没有改动任何文件。'}`)
  process.exit(0)
}

console.log('将要执行：')
if (mode === 'link') {
  plan(`把包复制到 ${dest}`)
  if (dependencies[PACKAGE_NAME] === spec) plan(`依赖已是 ${spec}（不变）`)
  else if (dependencies[PACKAGE_NAME] !== undefined) plan(`依赖 ${PACKAGE_NAME}: ${dependencies[PACKAGE_NAME]} → ${spec}`)
  else plan(`新增依赖 ${PACKAGE_NAME}: ${spec}`)
} else {
  plan(`把包复制到 ${nodeModulesPath}（无需 pnpm）`)
  if (dependencies[PACKAGE_NAME] !== undefined) plan(`移除清单里的 ${PACKAGE_NAME} 依赖（copy 模式不用它）`)
}
if (bundles.includes(PACKAGE_NAME)) plan('已列在 dsh.profile.bundles（不变）')
else plan(`追加到 dsh.profile.bundles 末尾（当前共 ${bundles.length} 项）`)
if (mode === 'link' && runPnpm) plan(`在 ${profileDir} 执行 pnpm install`)

const nextDeps = { ...dependencies }
if (mode === 'link') nextDeps[PACKAGE_NAME] = spec
else delete nextDeps[PACKAGE_NAME]

const next = {
  ...manifest,
  dependencies: nextDeps,
  dsh: {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: [...bundles.filter((name) => name !== PACKAGE_NAME), PACKAGE_NAME] }
  }
}

if (apply) {
  if (mode === 'link') await copyPackage(packageRoot, dest)
  else await copyPackage(packageRoot, nodeModulesPath)
  await writeManifest(`${JSON.stringify(next, null, 2)}\n`)
}

if (!apply) {
  console.log('\n只是预演，没有改动任何文件。加 --apply 真正写入。')
  process.exit(0)
}

if (mode === 'link' && runPnpm) {
  console.log('\n执行 pnpm install …')
  const code = await pnpmInstall()
  if (code !== 0) {
    console.log('\npnpm 没能跑完（退出码 ' + code + '）。请在 profile 目录里手动执行：')
    console.log(`  cd "${profileDir}"`)
    console.log('  pnpm install')
  }
}

console.log('\n完成。重启 DSH 进程，侧栏底部会多出一个 NovelAI 出图的图标。')
console.log('凭据不随仓库分发：打开面板第一件事是填 NovelAI token（存本机 config.json）。')
