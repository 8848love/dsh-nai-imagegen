/**
 * dsh-nai-imagegen — profile installer.
 *
 * Installing a linked local bundle is three steps and one of them is not a file
 * edit, so this script does the file edits and prints the command it will not
 * run on your behalf:
 *
 *   1. add `"dsh-nai-imagegen": "link:<package root>"` to the profile's
 *      dependencies,
 *   2. append `dsh-nai-imagegen` to `dsh.profile.bundles`, and
 *   3. run `pnpm install` in the profile so node_modules gets the link.
 *
 * The bundle carries its own `cordis.patch.yml`, which the bundle mechanism
 * applies when the bundle is selected — so the profile's patch file is left
 * alone.
 *
 * Dry run by default. Pass `--apply` to write, `--uninstall --apply` to reverse.
 * Every write is preceded by a timestamped backup of the file it replaces.
 *
 * Usage:
 *   node install.mjs                 show the plan
 *   node install.mjs --apply         write the plan
 *   node install.mjs --uninstall     show the reversal plan
 *   node install.mjs --uninstall --apply
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package name as it appears in the profile manifest. */
const PACKAGE_NAME = 'dsh-nai-imagegen'
/** DSH home; matches the runtime fallback. */
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/** Active profile name, e.g. `desktop`. */
const PROFILE = process.env.DSH_PROFILE || 'desktop'
/** The profile directory whose manifest is edited. */
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(HOME, 'profiles', PROFILE)
/** The profile manifest. */
const MANIFEST = join(PROFILE_DIR, 'package.json')

/** This package's root, derived from the script location. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)))

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const uninstall = argv.includes('--uninstall')

/**
 * Print one planned change.
 * @param line - the description.
 */
function plan(line) {
  console.log(`${apply ? '  ->' : '  · '} ${line}`)
}

/**
 * Write a file, backing up whatever it replaces.
 * @param path - the target.
 * @param text - the new content.
 */
async function writeWithBackup(path, text) {
  if (!apply) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await copyFile(path, `${path}.bak-${stamp}`)
  await writeFile(path, text, 'utf8')
  console.log(`     备份 → ${path}.bak-${stamp}`)
}

console.log(`profile : ${PROFILE}`)
console.log(`目录    : ${PROFILE_DIR}`)
console.log(`包      : ${packageRoot}`)
console.log(`模式    : ${apply ? 'APPLY' : 'DRY RUN'}${uninstall ? ' (uninstall)' : ''}\n`)

let manifest
try {
  // Strip a UTF-8 BOM: Windows editors add one, JSON.parse refuses it.
  manifest = JSON.parse((await readFile(MANIFEST, 'utf8')).replace(/^\uFEFF/, ''))
} catch (error) {
  console.error(`读不到 profile 清单：${MANIFEST}\n${error.message}`)
  process.exitCode = 1
  throw error
}

const dependencies = manifest.dependencies ?? {}
const bundles = manifest.dsh?.profile?.bundles ?? []
const spec = `link:${packageRoot.replace(/\\/g, '/')}`

if (uninstall) {
  console.log('将要撤销：')
  if (dependencies[PACKAGE_NAME] === undefined && !bundles.includes(PACKAGE_NAME)) {
    console.log('  （没有安装记录，无需撤销）')
    process.exit(0)
  }
  if (dependencies[PACKAGE_NAME] !== undefined) plan(`移除依赖 ${PACKAGE_NAME}（当前 ${dependencies[PACKAGE_NAME]}）`)
  if (bundles.includes(PACKAGE_NAME)) plan(`从 dsh.profile.bundles 移除 ${PACKAGE_NAME}`)

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
  await writeWithBackup(MANIFEST, `${JSON.stringify(next, null, 2)}\n`)
} else {
  console.log('将要执行：')
  if (dependencies[PACKAGE_NAME] === spec) plan(`依赖已是 ${spec}（不变）`)
  else if (dependencies[PACKAGE_NAME] !== undefined) plan(`依赖 ${PACKAGE_NAME}: ${dependencies[PACKAGE_NAME]} → ${spec}`)
  else plan(`新增依赖 ${PACKAGE_NAME}: ${spec}`)

  if (bundles.includes(PACKAGE_NAME)) plan('已列在 dsh.profile.bundles（不变）')
  else plan(`追加到 dsh.profile.bundles 末尾（当前共 ${bundles.length} 项）`)

  const next = {
    ...manifest,
    dependencies: { ...dependencies, [PACKAGE_NAME]: spec },
    dsh: {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: [...bundles.filter((name) => name !== PACKAGE_NAME), PACKAGE_NAME] }
    }
  }
  await writeWithBackup(MANIFEST, `${JSON.stringify(next, null, 2)}\n`)
}

console.log(`\n${apply ? '清单已写入。' : '只是预演，没有改动任何文件。'}`)
console.log('\n下一步（由你执行 —— 这一步会在 profile 里建立本地链接）：')
console.log(`  cd "${PROFILE_DIR}"`)
console.log('  pnpm install')
console.log('\n然后重启 DSH 进程，侧栏底部会多出一个 NovelAI 出图的图标。')
