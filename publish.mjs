/**
 * dsh-nai-imagegen — publish the working copy into the repo and push it.
 *
 * The source of truth while editing is this directory; the source of truth for
 * "what happened" is the git repo. This script moves one to the other without
 * ever widening the stage set beyond the plugin's own directory — that is the
 * whole point, because the repo root also carries unrelated projects that must
 * not be touched.
 *
 * Steps, in order:
 *   1. confirm the target is a git repo on the expected branch,
 *   2. mirror this package into `<repo>/plugins/dsh-nai-imagegen`,
 *   3. stage only that path and refuse if anything else got staged,
 *   4. run the test suite unless --skip-tests,
 *   5. commit with the given message, push, optionally tag and push the tag.
 *
 * Dry run by default: steps 1 and 3 run, nothing is written, committed or pushed.
 *
 * Usage:
 *   node publish.mjs --message "修复 xxx"                     show the plan
 *   node publish.mjs --message "修复 xxx" --apply             commit + push
 *   node publish.mjs --message "新增 xxx" --apply --tag nai-imagegen-v1.1.0
 *   node publish.mjs --message "修 bug" --apply --skip-tests
 *
 * Options:
 *   --repo <dir>      target repository (default: C:\nailongwang, or $NAI_REPO)
 *   --subdir <path>   path inside the repo (default: plugins/dsh-nai-imagegen)
 *   --message <text>  commit message (required unless --apply is absent)
 *   --tag <name>      annotated tag to create after a successful push
 *   --branch <name>   expected branch (default: main)
 *   --skip-tests      do not run tests/verify.mjs before committing
 *   --apply           actually write, commit and push
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin directory name inside the repo. */
const DEFAULT_SUBDIR = 'plugins/dsh-nai-imagegen'
/** This package's root, derived from the script location. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)))

/** Entries never mirrored into the repo. */
const SKIP = new Set(['node_modules', '.git'])

const argv = process.argv.slice(2)

/**
 * Read one `--flag value` option.
 * @param name - flag without dashes.
 * @param fallback - value when absent.
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
const skipTests = argv.includes('--skip-tests')
const repo = resolve(option('repo', process.env.NAI_REPO || '<仓库克隆目录>'))
const subdir = option('subdir', DEFAULT_SUBDIR).replace(/\\/g, '/')
const branch = option('branch', 'main')
const message = option('message', '')
const tag = option('tag', '')

/**
 * Run git and return trimmed stdout; throws on a non-zero exit so a failed step
 * stops the publish instead of half-writing it.
 * @param args - git arguments.
 * @param inherit - stream output to this terminal instead of capturing it.
 * @returns stdout text.
 */
function git(args, inherit = false) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe'
  })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`git ${args.join(' ')} 失败（退出码 ${result.status}）\n${detail}`)
  }
  return (result.stdout || '').trim()
}

/**
 * Print one planned or performed step.
 * @param line - the description.
 */
function step(line) {
  console.log(`${apply ? '  ->' : '  · '} ${line}`)
}

/**
 * Mirror this package into a destination, skipping dependencies, git metadata,
 * scratch scripts and backups.
 * @param from - source directory.
 * @param to - destination directory.
 */
async function mirror(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    if (/^_.*\.tmp\.mjs$/.test(entry.name)) continue
    if (/\.bak-\d/.test(entry.name)) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await mirror(source, target)
    else await cp(source, target, { force: true })
  }
}

console.log(`包源    : ${packageRoot}`)
console.log(`仓库    : ${repo}`)
console.log(`目标    : ${subdir}`)
console.log(`模式    : ${apply ? 'APPLY' : 'DRY RUN'}\n`)

if (!apply && message === '') {
  console.error('缺少 --message：提交说明是回溯的一半，不能省。')
  console.error('例如：node publish.mjs --message "展板单张重画按位置替换"')
  process.exit(1)
}

// 1) repo sanity
try {
  const repoStat = await stat(repo)
  if (!repoStat.isDirectory()) throw new Error('not a directory')
} catch (error) {
  console.error(`找不到仓库目录 ${repo}：${error.message}`)
  console.error('用 --repo 指定，或设置环境变量 NAI_REPO。')
  process.exit(1)
}

try {
  const current = git(['branch', '--show-current'])
  if (current !== branch) {
    console.error(`当前在 ${current || '(detached)'} 分支，期望 ${branch}。`)
    console.error('先切回目标分支再来，脚本不替你换分支。')
    process.exit(1)
  }
  const dirty = git(['status', '--porcelain', '--', subdir])
  const outside = git(['status', '--porcelain'])
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.slice(3).replace(/^"/, '').startsWith(subdir))
  console.log(`仓库分支: ${current}${dirty === '' ? '（插件目录干净）' : '（插件目录有未提交改动）'}`)
  if (outside.length > 0) {
    console.log(`仓库里与本插件无关的改动 ${outside.length} 项 —— 不会被暂存、不会被提交。`)
  }
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

// 2) mirror source → repo
const destination = join(repo, subdir)
await mirror(packageRoot, destination)
step(`同步 ${relative(repo, packageRoot)} → ${subdir}`)

// 3) stage only this path
try {
  git(['add', '--', subdir])
  const staged = git(['diff', '--cached', '--name-only'])
    .split('\n')
    .filter((line) => line.trim() !== '')
  const foreign = staged.filter((line) => !line.startsWith(`${subdir}/`))
  if (foreign.length > 0) {
    console.error(`暂存区里出现了插件目录之外的路径，停手：\n${foreign.join('\n')}`)
    process.exit(1)
  }
  if (staged.length === 0) {
    console.log('\n没有差异：工作副本与仓库里的一致，无需提交。')
    process.exit(0)
  }
  step(`暂存 ${staged.length} 个文件（只限 ${subdir}）`)
  const summary = git(['diff', '--cached', '--stat', '--', subdir])
  console.log(
    summary
      .split('\n')
      .map((line) => `     ${line}`)
      .join('\n')
  )
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

// 4) tests
if (!skipTests) {
  const testFile = join(packageRoot, 'tests', 'verify.mjs')
  console.log('\n运行 tests/verify.mjs …')
  const test = spawnSync(process.execPath, [testFile], { cwd: packageRoot, encoding: 'utf8' })
  const tail = (test.stdout || '').trim().split('\n').filter((line) => line.includes('passed')).pop()
  if (test.status !== 0) {
    console.error('测试没过，不提交。修完再跑一次，或确认与本次改动无关时加 --skip-tests。')
    console.error((test.stdout || '').split('\n').slice(-20).join('\n'))
    process.exit(1)
  }
  console.log(`  ${tail ?? '通过'}`)
}

// 5) commit, push, tag
if (!apply) {
  console.log(`\n将要提交：${message}`)
  if (tag !== '') console.log(`将要打标签：${tag}`)
  console.log('\n只是预演：已同步并暂存，但没提交、没推送。加 --apply 走完。')
  process.exit(0)
}

try {
  git(['commit', '-m', message], true)
  const hash = git(['rev-parse', '--short', 'HEAD'])
  console.log(`\n提交：${hash}`)
  git(['push', 'origin', branch], true)
  const remote = git(['rev-parse', `origin/${branch}`])
  const local = git(['rev-parse', 'HEAD'])
  if (remote !== local) {
    console.error(`推送后远端 ${remote} 与本地 ${local} 不一致 —— 先别当成功。`)
    process.exit(1)
  }
  console.log(`已推送：${remote}`)
  if (tag !== '') {
    git(['tag', '-a', tag, '-m', message], true)
    git(['push', 'origin', tag], true)
    console.log(`已打标签并推送：${tag}`)
  }
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
console.log(`\n完成。当前版本 ${pkg.version}；别人可以用 tag 或提交哈希整包退回。`)
