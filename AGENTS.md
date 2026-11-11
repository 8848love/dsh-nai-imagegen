# 在这个目录里改代码的规矩

插件 `dsh-nai-imagegen`：DSH 的 NovelAI 出图前端（`client.js` 是手写的预构建 bundle，没有构建步骤）＋ 宿主半侧（`index.js`、`lib/`）。

## 语言与版本

- 代码注释、提交说明、文档一律中文；标识符与命令保持原文。
- 版本号只在发布时动，规则：修 bug `+0.0.1`、小更新 `+0.1.0`、大更新 `+1.0.0`。

## 改完必须做的三件事

1. **跑测试**：`node tests/verify.mjs`（要求 `0 failed`）；改动碰到侧栏/注入面时再跑 `node tests/doctor-probe.mjs` 与 `node tests/drag-ratio-probe.mjs`。
2. **改文档**：行为变了就更新 `CHANGELOG.md` 与相应的 `README-*.md`。
3. **推仓库**：`node publish.mjs --message "一句话说清这次改了什么" --apply`（默认是预演，先跑一次看差异）。相当于：同步工作副本 → 只暂存 `plugins/dsh-nai-imagegen` → 跑测试 → 提交 → 推送。

发布就得打标签，方便整包退回：

```bash
node publish.mjs --message "新增 xxx" --apply --tag nai-imagegen-v1.1.0
```

## 不许做的事

- 不许提交 token、API Key、账号密码、私人路径清单。`config.json` 只在 `~/.dsh/nai-imagegen/`，仓库里永远只留 `config.example.json`。
- 不许 `git add .` / `git add -A`：仓库根目录还有其他项目，只暂存本插件目录。
- 不许 `git push --force`、`git reset --hard`、`git clean -fdx`。
- 不许把 `node_modules`、`_*.tmp.mjs`、`*.bak-*`、临时探针文件带进仓库（`publish.mjs` 已跳过）。

## 出事了怎么退

见 `ROLLBACK.md`：查历史 → 单文件或整包退到某个 `nai-imagegen-v*` 标签 → 重跑测试 → 记 `CHANGELOG.md`。

## 目录速查

| 路径 | 作用 |
| --- | --- |
| `client.js` | 前端 bundle：侧栏设置、画师串快切悬浮窗、回复展板、灯箱、渲染索引缓存 |
| `index.js` | 宿主半侧：`/nai-imagegen/api/*` 路由、出图落盘、渲染索引 |
| `lib/config.js` | 配置读写（`~/.dsh/nai-imagegen/config.json`） |
| `lib/renders.js` | 渲染索引：摘要查表、文本兜底匹配 |
| `bootstrap.mjs` | 从 git 装进任意 profile（`link` / `copy`） |
| `install.mjs` | 本机 profile 安装/卸载 |
| `publish.mjs` | 同步 + 测试 + 提交 + 推送 + 打标签 |
| `tests/` | `verify.mjs`（静态 + 行为）、`doctor-probe.mjs`、`drag-ratio-probe.mjs` |
