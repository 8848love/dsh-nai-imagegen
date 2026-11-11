# 漫画模式输出格式（硬性规范）

> 这份文档是**生成侧的唯一权威**。你要模型按漫画模式产出时，把第 8 节的「指令块」一起给它；
> 出图失败时，按第 5 节的报错对照表逐条核对。
>
> 插件侧的解析实现在 `lib/comic.js`，规格与本文一一对应。

---

## 1. 红线（不满足就出不了图）

| # | 规则 |
|---|---|
| **1** | 一页 = **一个 `<image>…</image>`**。`<image>` 里面**只能有 JSON**，不能有说明文字、注释、markdown 围栏、`<comic_plan>`。 |
| **2** | JSON 必须**合法**：双引号、无尾随逗号、无单引号、无注释。 |
| **3** | 必须有 **`"page": { "base": "…" }`**，且 `base` 非空。 |
| **4** | 必须有 **`"panels": [ … ]`**，**每格必须带 `characters` 数组**（没人就写 `[]`，但不能省）。 |
| **5** | 每个可见人物一格一个槽：**`"positive"` 非空**。整页至少要有一个非空的 `positive`（`page.base` 或人物任意一个）。 |
| **6** | 想控制人物位置，必须写**根字段** `"position_mode":"manual"`，**并且**给每个可见人物写 `"center":{"x":..,"y":..}`（0–1）。不写 `manual` 时 `center` 会被忽略。 |
| **7** | `<thinking>` 与 `<comic_plan>` 写在 **`<image>` 外面**。它们会被丢弃，写在里面则会破坏 JSON。 |
| **8** | **`page.base` 必须写 `複数コマの漫画ページ`**（普通分格页）；**每格 `description` 必须带日文画格/空间术语**（`上段の横長のコマ`、`大きな主コマ`、`斜めに切った枠`…）。画什么用英文标签，**怎么切格用日文**——这是分格漫画预设的硬性规定，也是模型判断版面的主要线索。见「画格术语表」。 |

---

## 2. 完整模板（照抄改内容）

```json
<image>
{
  "format": "nai5-comic",
  "position_mode": "manual",
  "page": {
    "base": "SFW, 2girls, comic, 複数コマの漫画ページ, 2-koma, portrait, white margin border, screentone",
    "non_character": "可选：整页旁白 / 声效 Text:原句"
  },
  "panels": [
    {
      "id": "P1",
      "description": "wide panel, classroom interior, medium shot",
      "non_character": "可选：本格文字的说明与位置 Text:原句",
      "characters": [
        {
          "character_id": "C1",
          "positive": "girl, long hair, blue hair, yellow eyes, drill locks, white shirt, standing, smiling, looking at viewer Text:「おはよう」",
          "negative": "twintails, short hair, green hair",
          "center": { "x": 0.3, "y": 0.35 }
        },
        {
          "character_id": "C2",
          "positive": "girl, twintails, green hair, yellow eyes, military uniform, standing, pout, looking away",
          "negative": "drill locks, blue hair",
          "center": { "x": 0.7, "y": 0.35 }
        }
      ]
    },
    {
      "id": "P2",
      "description": "close up panel, surprised expression, dramatic shadow",
      "characters": [
        {
          "character_id": "C2",
          "positive": "girl, twintails, green hair, close-up, surprised, wide-eyed, blush, sweatdrop",
          "negative": "drill locks, blue hair",
          "center": { "x": 0.5, "y": 0.78 }
        }
      ]
    }
  ]
}
</image>
```

同一轮多页 = **多个 `<image>` 块**，每页一个：

```
<thinking>整轮规划（只写一份）</thinking>
<comic_plan>[Page 1] …</comic_plan>
<image>{ 第 1 页 JSON }</image>
<comic_plan>[Page 2] …</comic_plan>
<image>{ 第 2 页 JSON }</image>
```

---

## 3. 字段表

| 字段 | 必需 | 说明 |
|---|---|---|
| `format` | 建议 | 固定 `"nai5-comic"`。缺了也能靠 `page`+`panels` 认出来，但会记一条提示。 |
| `position_mode` | 否 | `"manual"` 才用 `center`；缺省 / `"auto"` 表示**自动排布**，此时写 `center` 会被忽略并提示。 |
| `page.base` | **是** | 分级词、实际人数词、页面形态、画格数量、布局、留白、全局光影。**分镜/留白的配方会自动追加在后面，这里不用重复写。** |
| `page.non_character` | 否 | 整页的环境、旁白、声效、画外对白。**上画原文放在末尾 `Text:` 之后。** |
| `panels[].id` | 否 | `"P1"`… 只用于汇报，不参与画面。 |
| `panels[].description` | **是** | 本格构图、环境、非人物视觉演出。**必须带日文画格/空间术语**——见下面的「画格术语表」。 |
| `panels[].non_character` | 否 | 本格文字的形状与位置，末尾 `Text:原句`。 |
| `panels[].characters[]` | **是** | 即使空也要写 `[]`。 |
| `characters[].character_id` | 否 | `"C1"`… 只用于汇报。 |
| `characters[].positive` | **是** | 本格**这一次出场**可见的完整外貌与衣着、动作表情、气泡视觉说明。**无数字主体词**（写 `girl`，不写 `1girl`），台词末尾写 `Text:「原句」`（会被转成引号形式，见下）。 |
| `characters[].negative` | 建议 | 本页**其他人**适用且互斥的特征 + 本人的误画排除词。**只作用于这一个角色**，这正是本格式的意义。 |
| `characters[].center` | 否 | `{"x":0–1,"y":0–1}`，**整张最终画布的归一化坐标**。仅 `position_mode:"manual"` 时生效。 |

**上限**：人物槽最多 **24 个**（超出的会被丢弃并提示）。

---

## 4. 进去的和被丢掉的

| 内容 | 去处 |
|---|---|
| `page.base` + 各格 `description` / `non_character` | **场景部分**（base caption） |
| 每个 `characters[].positive` | **该角色的独立 caption** |
| 每个 `characters[].negative` | **该角色自己的负向 caption** |
| `center` | NAI 的 `centers`（真实坐标定位） |
| `<image>` / `<thinking>` / `<comic_plan>` / `<image_think>` | **丢掉** |
| `positive` 里的 `Text:原句` | **改写成 `"原句"`**——`Text:` 对图像模型毫无意义，**引号才是 NovelAI V5 画字的开关** |
| 漫画配方（色彩/分镜/留白/气泡/对白语言） | **前置到正向最前、并入 base caption、负向里面**，只对漫画模式生效 |

### 画格术语表（**这是硬性要求，最容易漏**）

分格漫画预设的原话：

> 「视觉部分优先使用可识别**英文标签**；标签不足以表达的空间关系或复杂演出可用**简短英日描述**。**日文漫画排版、气泡和跨页词按各自规则使用。**」
>
> 「绘图词优先使用有效英文视觉标签，**必要时保留简短日文表现词**，例如 `大きな主コマ`、`斜めに切った枠`、`激しい動き`、`半ページ以上の大コマ`。」

**分工是明确的**：画什么（人物、服装、光影）用**英文标签**；**怎么切格、格子在哪、多大**用**日文术语**。

日文画格词不是装饰——**它们是模型判断"这一页怎么排版"的主要线索**。只写 `top panel, long shot` 这种英文，模型就只剩标签在撑，分格精度会掉。

| 术语 | 意思 | 用在哪 |
|---|---|---|
| `複数コマの漫画ページ` | 多格漫画页 | **`page.base` 必写**（普通分格页） |
| `単一コマ` / `splash page` | 单格 | 单格页 |
| `見開きページ` | 横跨两页 | 跨页 |
| `大きな主コマ` / `半ページ以上の大コマ` | 大主格 / 占半页以上的大格 | 强调格 |
| `小さめのコマ` | 小格 | 次要格 |
| `斜めに切った枠` | 斜切的框 | 动感 |
| `横長のコマ` / `縦長のコマ` | 横长格 / 竖长格 | 形状 |
| `上段` / `中段` / `下段` | 上/中/下 段 | 位置 |
| `画面を左右に二分割` | 画面左右二分 | 同格双镜 |
| `読み順` | 阅读顺序 | 交代顺序 |
| `余白` / `間` | 留白 / 格间 | 版面 |
| `集中線` | 集中线 | 冲击 |
| `激しい動き` | 剧烈动作 | 动势 |

**写法的样子**（英文管画什么，日文管怎么切）：

```
"description": "上段の横長のコマ, 画面を左右に二分割, 左は手前の人物, 右は遠景のステージ; night city street, long shot, idol on a lit stage, a girl hiding behind a corner photographing her, camera to eye"
```



### 台词要能画出来，必须知道这三件事

| | 说明 | 它只告诉文本模型"原句放这里"，图像模型读到的是两个噪声词。所以写法是 `Text:「原句」`，**插件会把它转成 `"原句"`**；你能直接写 `"原句"` 也行。 |
| **写多长就画多长** | NovelAI 照写文字的能力**超过十几个字就崩**。超过 **16 字**插件会当场警告你这句基本写不出来。**想稳妥就压到 8 字以内**，长台词出图后自己贴。中文比英文更容易糊（实测「一直在看你」的"一"字会糊掉）。 |
| **不需要台词就别给** | 有气泡却给不出原文，模型会**自己编乱码填进去**——空气泡比乱码好。不想要气泡就把配方「气泡」切成**不带气泡**。 |

---

## 5. 报错对照表

| 报错 | 原因 | 怎么改 |
|---|---|---|
| `既没有 "format":"nai5-comic"，也没有同时出现 "page" 与 "panels"` | 整段不像漫画页 | 加上 `format` 与 `page`/`panels` 结构 |
| `整段里找不到合法的 JSON 对象（…说明文字写进了 <image>…）` | `<image>` 里有非 JSON 文字 / 截断 / 单引号 / 尾随逗号 | 把文字移出 `<image>`；只用双引号；去掉尾随逗号 |
| `没有任何可画的内容——缺少 page.base 与 panels 数组` | `base` 是空串，而且根本没有 `panels` | 填上分级/人数/页面形态/布局，并加上 `"panels":[…]`；单格 splash 也写一格 |
| `没有任何可画的内容——缺少 page.base 与 panels[].characters[].positive` | 有 `panels` 但每格 `description` 与人物 `positive` 全空，且 `base` 也空 | 至少给 `base` 或某格 `description` 填上内容，或给可见人物补 `positive` |
| 出图了但**人物位置没按 `center`** | 忘了根字段 `position_mode:"manual"` | 加上它（提示里会说"给出了 center 也不使用"） |
| 出图了但**标签被画进画面** | 整段 JSON 没被认出来，被当成普通提示词发了 | 用第 8 节指令块强制格式；或用 `nai_doctor` 确认解析器在线 |

---

## 6. 配方怎么叠加

悬浮窗里那六组（色彩 / 页数 / 分镜 / 留白 / 气泡 / 对白语言）**不写进 JSON**，由插件按模式追加：

- **`page.base` 不用重复写 `monochrome`、`4-koma`、`white margin`** —— 选了「黑白脱色 / 经典四格 / 封闭内枠」就自动带上。
- **页数**是给**写作模型**的指令（该出几页 `<image>`），不是给 NovelAI 的；渲染时只有画格密度进提示词。
- 配方**只对漫画模式生效**，出图模式完全不受影响。

---

## 7. 怎么确认它认得出

```powershell
# 全能力自检（51 项，不出图不烧额度）
GET /nai-imagegen/api/doctor
```
或让 Agent 调 `nai_doctor`。里面有一条 **"a sample block parses"** —— 它用本文第 2 节的模板结构跑一遍，样例都解析不了就说明代码和文档脱节了。

解析是否命中，出图结果的头部也会写：

```
漫画页：2 格 · 正向 653 字符 · 负向 61 字符 · 定位 manual · 角色 P1·C1@{"x":0.3,"y":0.35} …
```

看到 **`漫画页：`** 开头就说明走的是漫画解析；如果写成 **`<image> 块：`**，说明被当成了插画格式。

---

## 8. 指令块（要模型按这个格式输出时，把它一起贴上）

```text
【漫画分格输出协议 · 硬性】

一页 = 一个 <image>…</image>，里面**只有**合法 JSON，不许有说明文字、注释、markdown 围栏。

JSON 结构（键名一字不改）：
{
  "format": "nai5-comic",
  "position_mode": "manual" | "auto",
  "page": { "base": "分级词,人数词,页面形态,画格数,布局,留白,全局光影", "non_character": "可选" },
  "panels": [
    {
      "id": "P1",
      "description": "本格构图与环境",
      "non_character": "可选，末尾 Text:原句",
      "characters": [
        { "character_id": "C1", "positive": "无数字主体词+完整外貌衣着动作 末尾 Text:原句",
          "negative": "本页其他人的互斥特征", "center": { "x": 0.3, "y": 0.5 } }
      ]
    }
  ]
}

必须做到：
1. 每格都要有 "characters" 数组，没人写 []。
2. 每个可见人物一个槽，positive 必须非空，用无数字的 boy / girl / other。
3. 要定位就必须写根字段 "position_mode":"manual"，并给每个可见人物写 0–1 的 center。
4. <thinking> 与 <comic_plan> 写在 <image> 外面；多页就是多个 <image>，每页一个。
5. 台词原文放对应 positive / non_character 末尾的 Text: 之后，保留原语种。**每句压到 8 字以内**（超过 16 字模型基本照写不出来）。
6. 不要写 monochrome / 4-koma / white margin 这类风格词——分镜与留白由配方统一追加。
7. 只输出 JSON，不要包 markdown 代码围栏。
```
