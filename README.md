# dsh-nai-imagegen

DSH（DeepSeek Harness）的 NovelAI 出图插件。侧栏管参数，Agent 在对话里直接出图，出完的图贴在正文里、并排成一条可以点开的展板。

## 它能做什么

- **侧栏设置面板**：凭据、默认尺寸 / 模型 / 步数 / 采样器、出图目录、试出一张。
- **画师串**：列表、搜索、收藏置顶、整串文本预览与编辑、缩略图；可自建一条并传参考立绘。
- **画师串快切悬浮窗**：常驻右下角，一行下拉，点选即切当前画师串（不用再点保存）；星标收藏排最前；顶部一键重跑最近一条回复的出图。
- **代码块出图按钮**：正文里每个像 NovelAI 提示词的代码块下面多一个「🎨 生图」，点一下直接出图并把结果贴在块下面。
- **回复展板**：每条出图回复末尾一条缩略图带，左右箭头翻页，点缩略图进灯箱（可左右切换、可右键另存）；每张图下面还有一个小 `↻`，只重画那一张。
- **不丢图**：宿主侧渲染索引（`~/.dsh/nai-imagegen/renders.json`）＋ 浏览器侧 `localStorage` 缓存，重启或切对话后重建的对话仍能把图贴回来；摘要对不上时用提示词文本兜底匹配。
- **凭据不进浏览器**：面板永远拿不到 token，配置 POST 给宿主半侧，宿主再出网请求 NovelAI。

## 要求

- DSH 已装好并能启动（本插件是它的 Cordis bundle）
- Node.js 20 以上
- 一个 NovelAI 账号（Persistent API Token）

## 安装

```bash
git clone https://github.com/8848love/dsh-nai-imagegen.git
cd dsh-nai-imagegen

# 预演：打印计划，不动任何文件
node bootstrap.mjs

# 真正写进 profile（默认 link 模式；--mode copy 直接铺进 node_modules，不需要 pnpm）
node bootstrap.mjs --mode link --apply
```

装完重启 DSH，侧栏底部会多出「NovelAI 出图」图标。第一次打开面板要填自己的 NovelAI token —— 它只存在本机的 `~/.dsh/nai-imagegen/config.json`，仓库里永远只有 `config.example.json`。

卸载：

```bash
node bootstrap.mjs --uninstall --apply
```

其他参数：`--profile-dir <目录>`（指定 profile）、`--dest <目录>`（指定包落点）、`--no-pnpm`（不跑 pnpm install）。

## 目录

| 路径 | 作用 |
| --- | --- |
| `client.js` | 浏览器半侧（手写 bundle，无构建步骤）：设置面板、画师串快切窗、展板、灯箱、渲染缓存 |
| `index.js` | 宿主半侧：`/nai-imagegen/api/*` 路由、出图落盘、渲染索引 |
| `lib/` | 配置读写、渲染索引（含文本兜底匹配）、key 池、NovelAI 客户端 |
| `bootstrap.mjs` | 从 git 装进任意 profile |
| `install.mjs` | 装进当前 profile（老路径） |
| `tests/` | `verify.mjs`（静态 + 行为断言）、`doctor-probe.mjs`、`drag-ratio-probe.mjs` |

## 自检

```bash
node tests/verify.mjs
node tests/doctor-probe.mjs
node tests/drag-ratio-probe.mjs
```

`verify.mjs` 里有一条用例需要一个本机导出的归档当夹具，没有就跳过，属正常。

## 版本与回溯

- 版本号：修 bug `+0.0.1`、小更新 `+0.1.0`、大更新 `+1.0.0`，每次发布打 `v<版本>` 标签。
- 改动记录见 `CHANGELOG.md`，退版步骤见 `ROLLBACK.md`。

## 许可

MIT，见 `LICENSE`。
