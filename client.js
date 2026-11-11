/**
 * dsh-nai-imagegen — browser half.
 *
 * Registers one sidebar icon and the panel page it opens: NovelAI credentials
 * and default sampling parameters on the left, a one-click test render and the
 * gallery of everything already rendered below.
 *
 * This is a hand-authored prebuilt bundle, matching the shape DSH's module
 * system consumes:
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * Executing the bundle only registers that factory; the module body below runs
 * when the module is first materialized. `require` resolves the frozen platform
 * table (React) plus whatever `dsh.client.inject` declares. No JSX and no build
 * step: `React.createElement` covers a panel this size, and the file stays
 * readable as the artifact that actually ships.
 *
 * The token never reaches this half. Everything goes through the Host half's
 * loopback API, which is also the only place that can talk to NovelAI.
 */
window.__ModuleLoader__.load({
  id: 'dsh-nai-imagegen',
  factory(require) {
    // The module-system protocol: a factory builds its own module record, and
    // the loader caches whatever comes back from `exports`.
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'naiImagegen'
    /** Absolute path prefix of the Host half's API. */
    const API = '/nai-imagegen/api'
    /** Panel identity: the panellist row and the `main` entry share it. */
    const PANEL_ID = 'nai-imagegen'
    /** Relative cost the settings form warns above. */
    const HEAVY_UNITS = 4

    const zh = {
      panel: 'NovelAI 出图',
      title: 'NovelAI 出图',
      subtitle: '凭据与默认参数由宿主保管，出图只走本机回环接口。',
      credentials: '凭据',
      token: 'API Token',
      tokenPlaceholder: '填写 pst- 开头的 Persistent Token；留空表示不改动',
      tokenFromEnv: '当前生效的凭据来自环境变量 NAI_TOKEN，表单里的值会被它覆盖。',
      tokenNone: '尚未配置凭据，出图会直接失败。',
      tokenSet: '已配置凭据',
      baseUrl: '接口域名',
      proxy: '代理',
      proxyHint: '留空即自动使用 Windows 系统代理；填 off 强制直连；也可填 http://127.0.0.1:7890 这样的地址。',
      model: '模型',
      defaults: '默认参数',
      width: '宽',
      height: '高',
      steps: '步数',
      scale: '引导强度',
      sampler: '采样器',
      negative: '负面提示词',
      paths: '目录',
      outputDir: '出图目录',
      libraryDir: '索引目录',
      librarySourceDir: '库源目录',
      guard: '每次出图上限',
      keepImages: '最多保留张数',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      test: '试出一张',
      testing: '出图中…',
      probe: '检测连通性',
      probing: '检测中…',
      probeHint: '不消耗 Anlas：读订阅记录来验证主机、网络与凭据。',
      ucPreset: 'UC 预设',
      artist: '画师串',
      artistCount: '已导入',
      artistCurrent: '当前',
      artistSearch: '搜索画师串名称或提示词…',
      artistNone: '不使用画师串',
      artistNonePicked: '已关闭画师串',
      artistPicked: '已切换画师串',
      artistMissing: '记住的画师串在当前索引里找不到了（索引可能被重建过）。请重新选一条。',
      artistEdit: '修改当前画师串',
      artistEditHide: '收起编辑器',
      artistPositive: '正向提示词',
      artistNegative: '负向提示词',
      artistSave: '保存修改',
      artistRevert: '还原归档原文',
      artistSaved: '画师串已更新',
      artistReverted: '已还原成归档原文',
      artistEditedTag: '已编辑',
      artistEditHint: '只改这一条画师串的文本，不写回归档文件；重新导入画师串也不会被覆盖。同一个画师串无论在面板还是悬浮窗里选中，读到的都是这里改过的文本。清空正向表示不要风格前缀。',
      artistEditLoading: '正在读取画师串文本…',
      artistCharUnit: '字符',
      studioArtistPreview: '生效文本',
      studioArtistEdited: '已改',
      artistFavAdd: '收藏，排到最前面',
      artistFavRemove: '取消收藏',
      artistFavSaved: '已收藏，重新打开列表就排到最前面',
      artistFavCleared: '已取消收藏',
      artistFavFailed: '收藏没保存上',
      artistFavSearch: '输入名字筛选…',
      artistFavNone: '没有匹配的画师串',
      artistFavHint: '★ 收藏的排在最前面',
      artistNew: '新增画师串',
      artistNewHide: '收起新建',
      artistNewHint: '自己造一条画师串：名字 + 正向/负向文本，也可以先只写名字，之后用「修改当前画师串」补内容。存在索引旁边的 user.json 里，重新导入画师串不会把它冲掉。',
      artistName: '名称',
      artistNamePlaceholder: '给这条画师串起个名字',
      artistNewPositive: '正向文本',
      artistNewNegative: '负向文本',
      artistImage: '参考立绘',
      artistChooseImage: '选择图片…',
      artistImageChosen: '已选择',
      artistImageHint: 'png / jpeg / webp / gif，最大 8 MB。以原始字节直传，不先转成 base64。',
      artistCreate: '创建画师串',
      artistCreating: '创建中…',
      artistCreated: '画师串已创建',
      artistCreatedNoImage: '画师串已创建，但立绘没传上去',
      artistCustomTag: '自建',
      artistNameRequired: '先给这条画师串起个名字。',
      artistDelete: '删除这条画师串',
      artistDeleteConfirm: '确认删除',
      artistDeleteCancel: '取消',
      artistDeleteHint: '只能删自己新建的画师串。归档里导入的那些删不掉——那个文件不是这个插件写的。',
      artistDeleted: '画师串已删除',
      artistImageUpload: '换立绘',
      artistImageClearUpload: '撤销自传立绘',
      artistUploaded: '立绘已更新',
      artistUploadGone: '已撤销自传立绘',
      artistUploading: '上传中…',
      replyCaption: '回复正文',
      replyReceived: '正文已送达',
      replyWriting: '正在写入',
      replyUnit: '字',
      replyDuplicate: '这一轮的正文已经作为普通消息写在上面了，这里不再重复一遍。',
      replyOn: '回复走工具：开',
      replyOff: '回复走工具：关',
      replyHint: '开启后，模型被要求把整篇正文写进 nai_reply 的 text 里，正文由工具调用送回来，不经过普通文本通道（长回复因此不容易被截断）。关掉它就撤掉这个工具，模型照旧直接写正文。模型不认这个工具时回复会是空的，那时请关掉它。',
      artistNameNeeded: '先给它起个名字，创建按钮才会亮。',
      artistCreatedAs: '已新增',
      artistCreatedNotPicked: '它排在列表最下面，已经替你滚过去并加了高亮；想拿它当风格前缀，点一下那张卡片。',
      keys: 'API Key 池',
      concurrency: '并发度',
      keyLabel: '标签',
      keyToken: '粘贴 pst- 开头的 Key（只写不回显）',
      keyAdd: '添加',
      keyVerify: '验证全部',
      keyEnable: '启用',
      keyDisable: '停用',
      keyRemove: '移除',
      autoOn: '自动出图：开',
      autoOff: '自动出图：关',
      autoHint: '开启后，正文里像提示词的代码块会自动出图。只在新的回复里自动渲染：切换会话、翻历史都不会重复生成。打开开关时只渲染最新那一个，单次会话最多 12 张。会消耗额度。',
      autoUsed: '本会话已自动出图',
      autoImageUnit: ' 张',
      autoLastNone: '还没有自动出图的记录',
      autoLastPass: '最近一次收尾',
      autoLastBusy: '收尾窗口又被「还在写」挡住',
      autoLastQuiet: '收尾窗口已安静，正在收尾',
      autoLastFired: '出图',
      autoLastNothing: '没有可出的提示词',
      autoWhyHistory: '历史重放，跳过',
      autoWhyNotQuiet: '还在写，跳过',
      autoWhyStamped: '旧回复，跳过',
      autoWhyOlderReply: '不是最新回复，跳过',
      autoWhyAlreadyFired: '这个块已经出过图',
      autoWhyInFlight: '上一次还没回来',
      autoWhyAllowance: '本轮额度用尽',
      autoWhyNoButton: '没找到生图按钮',
      copyImage: '复制图片',
      copyName: '复制文件名',
      copyPath: '复制完整路径',
      saveAs: '另存为…',
      studioTitle: '出图设置（按模式分开）',
      studioArtist: '画师串',
      // 画师串快切窗：只放画师串这一块，选中即生效。
      dockTitle: '画师串快切',
      dockHint: '选中即生效，不用点保存',
      dockApplying: '切换中…',
      dockApplied: '已切换',
      dockFailed: '切换失败',
      dockZoom: '点击放大',
      dockFire: '重新生图',
      studioNegative: '负面词',
      studioSave: '保存',
      studioSaved: '已保存',
      studioFailed: '失败',
      studioHint: '两个模式各存各的；留空的项沿用上方的公共默认。',
      studioChanged: '与公共默认不同（这个模式自己的设置）',
      studioRecipe: '漫画配方',
      studioFireNow: '↻ 重新出图：最新回复',
      studioFireHint: '点这里（或双击窗口）＝把最新一条回复里的提示词全部出一次',
      studioFireBusy: '回复还在写，等它停下来再按',
      studioFireNone: '这个回复里没有可出的提示词块',
      studioFireSpent: '最新回复的提示词都正在出图',
      studioFireStarted: '最新回复：已开始出图 ',
      displayTitle: '图片显示',
      displayWidth: '显示比例',
      displayClickZoom: '点击图片放大',
      displayWidth: '显示比例',
      displayHint: '整张图按这个比例缩放，高度自动跟随原图比例。点图片放大／还原。',
      displayFound: '已识别正文图片',
      studioRatio: '比例',
      studioRatioCustom: '自定义',
      restartNeeded: '⚠ 代码比进程新，改动要重启 DSH 才生效',
      testPrompt: '测试提示词',
      testPromptPlaceholder: '1girl, solo, standing, looking at viewer, transparent background',
      variants: '张数',
      gallery: '图库',
      galleryEmpty: '还没有出图。',
      refresh: '刷新',
      loading: '载入中…',
      failed: '请求失败',
      heaviest: '当前参数相对消耗较高，会更快消耗额度。',
      inlineHint: '在对话里让 Agent 出图，图片会直接显示在正文中。',
      blockButton: '🎨 生图',
      blockWorking: '出图中…',
      blockDone: '已出图',
      blockRestored: '上次出图已恢复',
      blockFailed: '失败',
      boardTitle: '展板',
      boardCount: '张',
      boardZoom: '点击放大，左右可换图',
      boardPrev: '往前翻一张',
      boardNext: '往后翻一张',
      zoomPrev: '上一张',
      zoomNext: '下一张',
      boardReroll: '重画这一张',
      libraries: '已索引的库',
      // Membership, Anlas and the V5 free band. Every unavailable state gets its
      // own sentence: an unknown quota must never be drawn as "0 张".
      quota: '会员与额度',
      quotaHint: '读订阅记录，不消耗 Anlas；也不改动 Key 的启用状态。',
      quotaRefresh: '刷新额度',
      quotaRefreshing: '查询中…',
      quotaTotal: '已知合计 ',
      quotaUnit: ' 张',
      quotaUnknown: '未知',
      quotaAnlas: 'Anlas',
      quotaExpires: '到期 ',
      quotaDaily: '每日恢复 ',
      quotaDailyUnknown: '官方未返回恢复速度',
      quotaPaused: '额度恢复暂停',
      quotaOver: '已超额',
      quotaUnqueried: '尚未查询',
      quotaFailed: '查询失败',
      quotaInactive: '订阅未生效',
      quotaNonOpus: '非 Opus 档，没有 V5 免费额度',
      quotaMissingUsage: '订阅记录里没有 usage 字段',
      quotaInvalidUsage: '额度字段异常，读数不可信',
      quotaUpdated: '更新于 '
    }
    const en = {
      panel: 'NovelAI images',
      title: 'NovelAI images',
      subtitle: 'The host holds the credential and the defaults; rendering only goes through the loopback API.',
      credentials: 'Credential',
      token: 'API token',
      tokenPlaceholder: 'A pst-… persistent token; leaving it blank keeps the stored one',
      tokenFromEnv: 'The effective credential comes from the NAI_TOKEN environment variable and overrides this field.',
      tokenNone: 'No credential configured yet — rendering will fail.',
      tokenSet: 'Credential configured',
      baseUrl: 'API base',
      proxy: 'Proxy',
      proxyHint: 'Blank uses the Windows system proxy; "off" forces a direct connection; or give a URL like http://127.0.0.1:7890.',
      model: 'Model',
      defaults: 'Defaults',
      width: 'Width',
      height: 'Height',
      steps: 'Steps',
      scale: 'Guidance',
      sampler: 'Sampler',
      negative: 'Negative prompt',
      paths: 'Directories',
      outputDir: 'Output',
      libraryDir: 'Index',
      librarySourceDir: 'Library source',
      guard: 'Variants per call',
      keepImages: 'Keep at most',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      test: 'Render a test',
      testing: 'Rendering…',
      probe: 'Check connectivity',
      probing: 'Checking…',
      probeHint: 'Spends no Anlas: reads the subscription record to verify host, network and credential.',
      ucPreset: 'UC preset',
      artist: 'Artist string',
      artistCount: 'Imported',
      artistCurrent: 'Current',
      artistSearch: 'Search artist names or prompts…',
      artistNone: 'No artist string',
      artistNonePicked: 'Artist string cleared',
      artistPicked: 'Artist string set',
      artistMissing: 'The remembered artist string is not in the current index (it may have been rebuilt). Pick one again.',
      artistEdit: 'Edit this artist string',
      artistEditHide: 'Hide the editor',
      artistPositive: 'Positive prompt',
      artistNegative: 'Negative prompt',
      artistSave: 'Save changes',
      artistRevert: 'Restore the archive text',
      artistSaved: 'Artist string updated',
      artistReverted: 'Archive text restored',
      artistEditedTag: 'edited',
      artistEditHint: 'Changes this one artist string and never writes back to the archive file, so re-importing cannot overwrite it. The same string reads the same wherever it is picked — panel or floating window. An empty positive means no style prefix at all.',
      artistEditLoading: 'Reading the artist string…',
      artistCharUnit: 'chars',
      studioArtistPreview: 'In force',
      studioArtistEdited: 'edited',
      artistFavAdd: 'Star it, and it leads the list',
      artistFavRemove: 'Remove the star',
      artistFavSaved: 'Starred — reopen the list and it leads',
      artistFavCleared: 'Star removed',
      artistFavFailed: 'The star did not save',
      artistFavSearch: 'Filter by name…',
      artistFavNone: 'No artist string matches',
      artistFavHint: '★ leads the list',
      artistNew: 'New artist string',
      artistNewHide: 'Hide the new one',
      artistNewHint: 'Make one of your own: a name plus positive and negative text — the name alone is enough if you want to fill in the text later. Kept in user.json beside the index, so re-importing the archive cannot overwrite it.',
      artistName: 'Name',
      artistNamePlaceholder: 'Name this artist string',
      artistNewPositive: 'Positive text',
      artistNewNegative: 'Negative text',
      artistImage: 'Reference image',
      artistChooseImage: 'Choose a file…',
      artistImageChosen: 'Selected',
      artistImageHint: 'png / jpeg / webp / gif, 8 MB max. Sent as raw bytes rather than base64 inside JSON.',
      artistCreate: 'Create',
      artistCreating: 'Creating…',
      artistCreated: 'Artist string created',
      artistCreatedNoImage: 'Artist string created, but the image did not upload',
      artistCustomTag: 'mine',
      artistNameRequired: 'Give this artist string a name first.',
      artistDelete: 'Delete this artist string',
      artistDeleteConfirm: 'Confirm delete',
      artistDeleteCancel: 'Cancel',
      artistDeleteHint: 'Only artist strings you made yourself can be deleted. The imported ones cannot — that file is not this plugin\'s to write.',
      artistDeleted: 'Artist string deleted',
      artistImageUpload: 'Replace image',
      artistImageClearUpload: 'Drop uploaded image',
      artistUploaded: 'Image updated',
      artistUploadGone: 'Uploaded image dropped',
      artistUploading: 'Uploading…',
      replyCaption: 'reply text',
      replyReceived: 'reply delivered',
      replyWriting: 'writing',
      replyUnit: 'chars',
      replyDuplicate: 'This turn already wrote it out as ordinary message text — not repeating it here.',
      replyOn: 'Reply via tool: on',
      replyOff: 'Reply via tool: off',
      replyHint: 'When on, the model is told to write the whole reply into nai_reply\'s text, and the reply comes back through the call rather than through the ordinary text channel — so a long one is far less likely to be truncated. Turning it off takes the tool away and the model answers the usual way. A model that will not call the tool answers with nothing, which is the case to switch it off.',
      artistNameNeeded: 'Give it a name first — the button lights up once it has one.',
      artistCreatedAs: 'Added',
      artistCreatedNotPicked: 'It sits at the bottom of the list; scrolled to it and highlighted. Click its tile to use it as the style prefix.',
      keys: 'API key pool',
      concurrency: 'Concurrency',
      keyLabel: 'Label',
      keyToken: 'Paste a pst-… key (write-only)',
      keyAdd: 'Add',
      keyVerify: 'Verify all',
      keyEnable: 'Enable',
      keyDisable: 'Disable',
      keyRemove: 'Remove',
      autoOn: 'Auto-render: on',
      autoOff: 'Auto-render: off',
      autoHint: 'When on, prompt-looking code blocks render by themselves — but only in a new reply: switching conversations or scrolling back never re-renders. Turning it on renders only the newest one. Capped at 12 per session, and it spends quota.',
      autoUsed: 'auto-rendered this session:',
      autoImageUnit: '',
      autoLastNone: 'no automatic render on record yet',
      autoLastPass: 'last pass',
      autoLastBusy: 'the settle window was held shut by a still-writing marker',
      autoLastQuiet: 'the settle window went quiet, so the pass ran',
      autoLastFired: 'rendered',
      autoLastNothing: 'no prompt to render',
      autoWhyHistory: 'replayed history, skipped',
      autoWhyNotQuiet: 'still writing, skipped',
      autoWhyStamped: 'an older reply, skipped',
      autoWhyOlderReply: 'not the newest reply, skipped',
      autoWhyAlreadyFired: 'this block was already rendered',
      autoWhyInFlight: 'the previous render had not come back',
      autoWhyAllowance: 'the pass had spent its allowance',
      autoWhyNoButton: 'no render button found',
      copyImage: 'Copy image',
      copyName: 'Copy file name',
      copyPath: 'Copy full path',
      saveAs: 'Save as…',
      studioTitle: 'Render settings (per mode)',
      studioArtist: 'Artist',
      dockTitle: 'Artist switcher',
      dockHint: 'A pick applies at once — nothing to save',
      dockApplying: 'Switching…',
      dockApplied: 'Switched',
      dockFailed: 'Switch failed',
      dockZoom: 'Click to enlarge',
      dockFire: 'Render again',
      studioNegative: 'Negative',
      studioSave: 'Save',
      studioSaved: 'Saved',
      studioFailed: 'Failed',
      studioHint: 'Each mode keeps its own; an empty field falls back to the shared default.',
      studioChanged: 'Differs from the shared default (this mode owns it)',
      studioRecipe: 'Comic recipe',
      studioFireNow: '↻ Render the latest reply again',
      studioFireHint: 'Click here (or double-click the window) to render every prompt of the latest reply',
      studioFireBusy: 'The reply is still being written — try again once it stops',
      studioFireNone: 'The latest reply carries no prompt block',
      studioFireSpent: 'Every prompt of the latest reply is already rendering',
      studioFireStarted: 'Latest reply: fired ',
      displayTitle: 'Image display',
      displayWidth: 'Display scale',
      displayClickZoom: 'Click an image to zoom',
      displayWidth: 'Display scale',
      displayHint: 'The whole image scales by this, height following its own ratio. Click an image to enlarge / restore.',
      displayFound: 'Images claimed',
      studioRatio: 'Ratio',
      studioRatioCustom: 'Custom',
      restartNeeded: '⚠ Code on disk is newer than this process — restart DSH for it to take effect',
      testPrompt: 'Test prompt',
      testPromptPlaceholder: '1girl, solo, standing, looking at viewer, transparent background',
      variants: 'Variants',
      gallery: 'Gallery',
      galleryEmpty: 'Nothing rendered yet.',
      refresh: 'Refresh',
      loading: 'Loading…',
      failed: 'Request failed',
      heaviest: 'These settings are comparatively heavy on quota.',
      inlineHint: 'Ask the Agent to render in chat and the image appears inline in the reply.',
      blockButton: '🎨 Render',
      blockWorking: 'Rendering…',
      blockDone: 'Rendered',
      blockRestored: 'Last render restored',
      blockFailed: 'Failed',
      boardTitle: 'Board',
      boardCount: 'images',
      boardZoom: 'Click to enlarge, ← → to switch',
      boardPrev: 'Back one picture',
      boardNext: 'Forward one picture',
      zoomPrev: 'Previous picture',
      zoomNext: 'Next picture',
      boardReroll: 'Redraw this one',
      libraries: 'Indexed libraries',
      quota: 'Membership and quota',
      quotaHint: 'Reads the subscription record: no Anlas spent, and no change to whether a key may render.',
      quotaRefresh: 'Refresh quota',
      quotaRefreshing: 'Reading…',
      quotaTotal: 'Known total ',
      quotaUnit: ' images',
      quotaUnknown: 'unknown',
      quotaAnlas: 'Anlas',
      quotaExpires: 'expires ',
      quotaDaily: 'recovers ',
      quotaDailyUnknown: 'the official record carries no recovery speed',
      quotaPaused: 'quota recovery paused',
      quotaOver: 'over the limit',
      quotaUnqueried: 'not queried yet',
      quotaFailed: 'query failed',
      quotaInactive: 'subscription inactive',
      quotaNonOpus: 'not an Opus tier, so there is no V5 free band',
      quotaMissingUsage: 'the record carries no usage field',
      quotaInvalidUsage: 'usage fields are unusable, so the reading is not trustworthy',
      quotaUpdated: 'updated '
    }

    /**
     * One API call against the Host half.
     * @param path - route below the API prefix.
     * @param init - optional fetch init.
     * @returns the parsed JSON body.
     */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...init
      })
      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(`${response.status}: ${text.slice(0, 200)}`)
      }
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    /**
     * Report one line of what this half decided, for the host to keep.
     *
     * The page cannot be inspected from outside — the app exposes no debug port, so the half that
     * decides is the only one that can say why. Records are fire-and-forget and never awaited: a
     * host that is absent or busy must not disturb the thing being reported on, and a failure to
     * report is only ever a missing line in a log.
     *
     * @param event - short name of the moment being reported.
     * @param data - a small JSON-serialisable body.
     */
    function diag(event, data) {
      try {
        fetch(`${API}/diag`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ at: clockNow(), event, ...(data ?? {}) }),
          keepalive: true
        }).catch(() => {})
      } catch {
        // Diagnosing is never allowed to break the thing being diagnosed.
      }
    }

    /** Design-token shortcuts with literal fallbacks. */
    const token = (name, fallback) => `var(${name}, ${fallback})`

    /**
     * The artist rows with the starred ones first, everything else as it came.
     *
     * A stable partition rather than a sort: the host's order is the archive's own, and
     * rearranging the unstarred half would move entries for a reason nobody asked for.
     * Both surfaces need it and both apply it once, when the list is loaded — see the
     * grid's loader and the window's picker for why it is not applied per render.
     *
     * @param rows - artist rows as `/artists` returned them.
     * @returns a new array; the input is left alone.
     */
    function favoriteFirst(rows) {
      const starred = []
      const rest = []
      for (const row of rows ?? []) (row?.favorite === true ? starred : rest).push(row)
      return [...starred, ...rest]
    }

    const label = {
      display: 'block',
      fontSize: 12,
      lineHeight: '18px',
      color: token('--dsw-alias-label-tertiary', '#888')
    }
    const input = {
      width: '100%',
      boxSizing: 'border-box',
      height: 30,
      padding: '0 8px',
      fontSize: 13,
      borderRadius: token('--dsw-radius-md', '6px'),
      border: `1px solid ${token('--dsw-alias-border-l1', '#d0d0d5')}`,
      background: token('--dsw-alias-fill-l1', '#fff'),
      color: 'inherit',
      outline: 'none'
    }
    const row = { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }
    const cell = (grow) => ({ flex: `${grow ?? 1} 1 120px`, minWidth: 96 })
    const button = (primary) => ({
      height: 30,
      padding: '0 14px',
      fontSize: 13,
      borderRadius: token('--dsw-radius-md', '6px'),
      border: `1px solid ${primary ? 'transparent' : token('--dsw-alias-border-l1', '#d0d0d5')}`,
      cursor: 'pointer',
      background: primary ? token('--dsw-alias-accent', '#2d6cff') : 'transparent',
      color: primary ? '#fff' : 'inherit'
    })
    const section = {
      marginTop: 18,
      paddingTop: 14,
      borderTop: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`
    }
    const card = {
      marginTop: 10,
      padding: 12,
      borderRadius: token('--dsw-radius-lg', '10px'),
      border: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`,
      background: token('--dsw-alias-fill-l1', 'transparent')
    }

    /**
     * The sidebar glyph. DSH renders it at 16 or 18 px and tells it whether the
     * panel is the active one.
     * @param props - injected `{ size, active }`.
     * @returns the svg element.
     */
    function PanelIcon(props) {
      const size = props.size ?? 18
      const color = props.active ? token('--dsw-alias-label-primary', '#111') : 'currentColor'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: color,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' }
        },
        h('rect', { key: 'r', x: 3, y: 4, width: 18, height: 16, rx: 2.5 }),
        h('circle', { key: 'c', cx: 9, cy: 10, r: 1.6, fill: color, stroke: 'none' }),
        h('path', { key: 'm', d: 'M4 18l4.5-5 3 3 3.5-4L20 18' })
      )
    }

    /**
     * The gates of `autoFire`, in words where a word exists.
     *
     * Only the reasons a person can act on are named; anything else is shown as its own code,
     * because a code that can be quoted is worth more than a sentence that explains nothing.
     */
    const AUTO_REASON_TEXT = {
      'not-quiet': 'autoWhyNotQuiet',
      history: 'autoWhyHistory',
      'history-pass': 'autoWhyHistory',
      stamped: 'autoWhyStamped',
      'older-reply': 'autoWhyOlderReply',
      'already-fired': 'autoWhyAlreadyFired',
      'in-flight': 'autoWhyInFlight',
      allowance: 'autoWhyAllowance',
      'no-button': 'autoWhyNoButton'
    }

    /** A reason code in words, falling back to the code itself. */
    function reasonText(code, t) {
      const key = AUTO_REASON_TEXT[code]
      if (key === undefined) return code
      const text = t(key)
      return typeof text === 'string' && text !== '' && text !== key ? text : code
    }

    /**
     * One line saying what the last automatic pass did.
     *
     * The record is this half's own report, kept by the host and handed back in `/status`, so the
     * line speaks the same vocabulary as the gates: what stopped each block, or which marker held
     * the settle window shut. That is the difference between "it did not render" and an answer.
     *
     * @param record - the host's `lastAuto`, or null when the page has not reported yet.
     * @param t - the bound dictionary.
     * @returns one line of plain text.
     */
    function lastAutoLine(record, t) {
      if (record === null || record === undefined) return t('autoLastNone')
      const at = Number(record.receivedAt ?? record.at)
      const clock = Number.isFinite(at) && at > 0 ? new Date(at).toLocaleTimeString() : ''
      const head = clock === '' ? t('autoLastPass') : `${t('autoLastPass')} ${clock}`
      if (record.event === 'window') {
        if (record.verdict === 'still-writing') {
          const marker = typeof record.marker === 'string' && record.marker !== '' ? `（${record.marker}）` : ''
          return `${head} · ${t('autoLastBusy')}${marker}`
        }
        return `${head} · ${t('autoLastQuiet')}`
      }
      let fired = 0
      let skipped = 0
      let worst = ''
      let worstCount = 0
      for (const [reason, count] of Object.entries(record.outcome ?? {})) {
        const seen = Number(count) || 0
        if (reason === 'fired') {
          fired += seen
        } else if (reason !== 'not-a-prompt') {
          skipped += seen
          if (seen > worstCount) {
            worstCount = seen
            worst = reason
          }
        }
      }
      const tally = fired > 0 ? `${t('autoLastFired')} ${fired}${t('autoImageUnit')}` : t('autoLastNothing')
      const why = worst === '' ? '' : `（${reasonText(worst, t)}）`
      return `${head} · ${tally}${why}`
    }

    /**
     * The panel page registered on the keyed `main` slot.
     * @param props - composed slot props; this component reads none of them.
     * @returns the panel element.
     */
    function NaiPanel(props) {
      const t = props.t ?? ((key) => key)
      const [status, setStatus] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [prompt, setPrompt] = React.useState('1girl, solo, standing, looking at viewer, transparent background')
      const [variants, setVariants] = React.useState(1)
      const [shots, setShots] = React.useState([])
      const [probed, setProbed] = React.useState(null)

      const refresh = React.useCallback(async () => {
        try {
          const next = await api('/status')
          setStatus(next)
          setShots(next.newest ?? [])
        } catch (err) {
          setError(err.message)
        }
      }, [])

      React.useEffect(() => {
        let live = true
        ;(async () => {
          try {
            const [statusBody, configBody] = await Promise.all([api('/status'), api('/config')])
            if (!live) return
            setStatus(statusBody)
            setShots(statusBody.newest ?? [])
            setForm({ ...configBody, token: '' })
            // Counted here rather than during render: the sweep mutates the document, and
            // a render-time side effect would run on every keystroke in every field.
            setClaimed(claimRenderImages())
          } catch (err) {
            if (live) setError(err.message)
          }
        })()
        return () => {
          live = false
        }
      }, [])

      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))

      const onSave = async () => {
        setBusy('save')
        setError('')
        setNotice('')
        try {
          const patch = { ...form }
          for (const numeric of ['width', 'height', 'steps', 'scale', 'maxImagesPerCall', 'keepImages', 'displayWidth']) {
            if (patch[numeric] !== undefined && patch[numeric] !== '') patch[numeric] = Number(patch[numeric])
          }
          if (!patch.token) delete patch.token
          const body = await api('/config', { method: 'POST', body: JSON.stringify(patch) })
          setStatus(body.status)
          setShots(body.status.newest ?? [])
          setForm((prev) => ({ ...prev, token: '' }))
          // The stylesheet is injected once, so a new scale has to be painted into it
          // here — otherwise the change would only show up after a page reload, which is
          // exactly the kind of "I changed it and nothing happened" this fixes.
          refreshImageSizing?.()
          setClaimed(claimRenderImages())
          setNotice(t('saved'))
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      const onRender = async () => {
        setBusy('render')
        setError('')
        setNotice('')
        try {
          const body = await api('/generate', {
            method: 'POST',
            body: JSON.stringify({ prompt, nSamples: Number(variants) || 1 })
          })
          setNotice(`${body.files.length} 张 · 相对消耗 ${body.weight}`)
          await refresh()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      const onProbe = async () => {
        setBusy('probe')
        setError('')
        setNotice('')
        try {
          setProbed(await api('/probe', { method: 'POST', body: '{}' }))
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      // ------------------------------------------------------- artist archive --
      const [artists, setArtists] = React.useState([])
      const [artistQuery, setArtistQuery] = React.useState('')
      const [artistCount, setArtistCount] = React.useState(0)
      const [newToken, setNewToken] = React.useState('')
      const [newLabel, setNewLabel] = React.useState('')
      // Declared last on purpose. The panel fixtures seed state by call index, so a new
      // hook inserted above them would push the artist list onto the wrong slot and the
      // sidebar would render an empty section rather than fail.
      /** How many transcript images the sizing rules can actually reach. */
      const [claimed, setClaimed] = React.useState(0)

      // ------------------------------------------------------- artist editor --
      // Declared here for the same reason as `claimed`: the fixtures seed state by
      // call index, so a hook inserted above the seeded ones lands on the wrong slot.
      /** The text in force for the current pick, fetched on demand. */
      const [artistText, setArtistText] = React.useState(null)
      /** The two boxes being typed in; null until there is a text to seed them from. */
      const [artistDraft, setArtistDraft] = React.useState(null)
      /** Whether the editor is expanded. */
      const [artistOpen, setArtistOpen] = React.useState(false)

      // ------------------------------------------------- made-up artist strings --
      // Appended for the same reason as everything above: the fixtures seed state by
      // call index, so a hook inserted higher would land on the wrong slot.
      /** Whether the form for a hand-made entry is open. */
      const [artistNewOpen, setArtistNewOpen] = React.useState(false)
      /** What has been typed into it so far. */
      const [artistNewName, setArtistNewName] = React.useState('')
      const [artistNewPositive, setArtistNewPositive] = React.useState('')
      const [artistNewNegative, setArtistNewNegative] = React.useState('')
      /** The chosen file, held until the record exists to attach it to. */
      const [artistNewImage, setArtistNewImage] = React.useState(null)
      /** The id waiting for a second click before it is really deleted; -1 for none. */
      const [artistDeleteArmed, setArtistDeleteArmed] = React.useState(-1)
      /** The id whose image is going up, so one tile cannot be clicked twice. */
      const [artistUploading, setArtistUploading] = React.useState('')
      /**
       * Why the last create attempt did not go through, shown right under the button.
       * The panel's own error card lives at the very top of a very long page, so a
       * refusal printed there reads as "the button did nothing".
       */
      const [artistNewError, setArtistNewError] = React.useState('')
      /** What the last create did, likewise printed under the button. */
      const [artistNewNotice, setArtistNewNotice] = React.useState('')
      /**
       * The entry just made, so the grid scrolls to it instead of snapping back to the
       * remembered pick (which is what happens on every other `artists` change).
       */
      const [justCreatedId, setJustCreatedId] = React.useState(-1)

      const loadArtists = React.useCallback(async (query) => {
        try {
          const body = await api(`/artists?limit=500&q=${encodeURIComponent(query ?? '')}`)
          // Ordered here rather than at render time: the grid must not rearrange itself
          // under a click, so a star takes effect on the next look at the list — which
          // is exactly what "put the starred ones first" was asked to mean.
          setArtists(favoriteFirst(body.artists))
          setArtistCount(body.count ?? 0)
        } catch (err) {
          setError(err.message)
        }
      }, [])

      React.useEffect(() => {
        loadArtists('')
      }, [loadArtists])

      // Searching the archive is a request that re-reads a 151 KB index on the
      // host, so it is debounced rather than fired once per keystroke.
      const artistTimer = React.useRef(null)
      const onArtistQuery = (value) => {
        setArtistQuery(value)
        // Typing a query is a deliberate move in the grid, so the remembered pick
        // gets the scroll again from here on.
        setJustCreatedId(-1)
        if (artistTimer.current !== null) clearTimeout(artistTimer.current)
        artistTimer.current = setTimeout(() => {
          artistTimer.current = null
          loadArtists(value)
        }, 200)
      }
      React.useEffect(
        () => () => {
          if (artistTimer.current !== null) clearTimeout(artistTimer.current)
        },
        []
      )

      // Bring the remembered selection into view. The grid is 96 tiles tall and the
      // pick is usually well past the fold, so without this the panel looks like it
      // forgot — which is exactly how a working setting gets reported as broken.
      const selectedArtistRow = React.useRef(null)
      // A freshly made entry is the one case where the selection must NOT win: it is
      // appended after every imported tile, so scrolling to the pick would leave the
      // new row off screen and make a successful create look like a no-op.
      const freshArtistRow = React.useRef(null)
      React.useEffect(() => {
        if (justCreatedId >= 0) {
          const fresh = freshArtistRow.current
          if (fresh !== null && typeof fresh.scrollIntoView === 'function') {
            fresh.scrollIntoView({ block: 'center' })
          }
          return
        }
        const node = selectedArtistRow.current
        if (node !== null && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'nearest' })
        }
      }, [status?.artistId, artists, justCreatedId])

      // The code-block watcher lives outside the component tree, so the toggle
      // writes through to its flag instead of recreating it. Turning it on also
      // forces a pass, so prompts already on screen render rather than waiting
      // for the transcript to change.
      React.useEffect(() => {
        const wanted = status?.autoGenerate === true
        const turningOn = wanted && !autoRender
        autoRender = wanted
        if (turningOn && typeof rescanBlocks === 'function') rescanBlocks({ autoLastOnly: true })
      }, [status])

      /** Re-read status after any mutation, so the panel never shows stale state. */
      const refreshStatus = React.useCallback(async (body) => {
        setStatus(body?.status ?? (await api('/status')))
      }, [])

      // The sync loop can move the stored setting behind this panel's back — the chat's
      // `nai_config`, another window, or a second tab. When it does, re-read so the button and
      // the row under it tell the same story as the watcher that actually renders.
      React.useEffect(() => {
        onSettingMoved = () => {
          refreshStatus()
        }
        return () => {
          onSettingMoved = null
        }
      }, [refreshStatus])

      const onPickArtist = async (id) => {
        setBusy(`artist:${id}`)
        setError('')
        setNotice('')
        // Picking is a deliberate move on the grid; the just-made entry no longer
        // outranks the chosen tile for the scroll.
        setJustCreatedId(-1)
        try {
          await refreshStatus(await api('/config', { method: 'POST', body: JSON.stringify({ artistId: id }) }))
          const picked = artists.find((row) => row.id === id)
          setNotice(id < 0 ? t('artistNonePicked') : `${t('artistPicked')}${picked ? `：${picked.name}` : ''}`)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      /**
       * Star one entry, or take the star off.
       *
       * The flag is written into the row in place instead of reloading the grid: a
       * reload would re-sort it, and a tile that jumps to the top at the moment it is
       * clicked is a tile the next click can no longer find. The list is re-ordered by
       * the loader above, so the move happens on the next look.
       */
      const onToggleFavorite = async (artist) => {
        const id = Number(artist?.id)
        if (!Number.isInteger(id) || id < 0) return
        const want = artist?.favorite !== true
        setBusy(`fav:${id}`)
        setError('')
        setNotice('')
        try {
          const result = await api('/artist-favorite', {
            method: 'POST',
            body: JSON.stringify({ id, favorite: want })
          })
          setArtists((rows) => rows.map((row) => (Number(row.id) === id ? { ...row, favorite: want } : row)))
          await refreshStatus(result)
          setNotice(`${want ? t('artistFavSaved') : t('artistFavCleared')}：${artist?.name ?? `#${id}`}`)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      const currentArtistId = Number(status?.artistId ?? -1)

      /**
       * Read the text in force for one artist id.
       *
       * Fetched on demand rather than carried in `status`: status is re-read after
       * every mutation, and shipping a 1500-character prompt inside it would re-send
       * the whole archive text of the current pick for no reason.
       */
      const loadArtistText = React.useCallback(async (id) => {
        if (!Number.isInteger(id) || id < 0) {
          setArtistText(null)
          return
        }
        try {
          setArtistText(await api(`/artist-text?id=${id}`))
        } catch (err) {
          setArtistText(null)
        }
      }, [])

      React.useEffect(() => {
        loadArtistText(currentArtistId)
        // A different pick invalidates whatever was being typed: keeping the draft
        // would let the next save write one artist's text onto another's id.
        setArtistDraft(null)
      }, [currentArtistId, loadArtistText])

      // Seed the boxes from the fetched text — and re-seed after a save — so the
      // editor always opens on what the host holds rather than on a stale local copy.
      React.useEffect(() => {
        if (artistOpen !== true || artistText === null) return
        setArtistDraft({ positive: artistText.positive, negative: artistText.negative })
      }, [artistOpen, artistText])

      const onToggleArtistEditor = () => {
        setArtistOpen((open) => open !== true)
      }

      /**
       * Save the edited text, or put the archive text back.
       *
       * `revert` deletes the stored edit; saving an empty positive is a different
       * thing — it means "no style prefix" — and is kept as such.
       */
      const onSaveArtistEdit = async (revert) => {
        const id = currentArtistId
        if (id < 0 || (revert !== true && artistDraft === null)) return
        setBusy('artisttext')
        setError('')
        setNotice('')
        try {
          const body =
            revert === true ? { id, revert: true } : { id, positive: artistDraft.positive, negative: artistDraft.negative }
          const result = await api('/artist-edit', { method: 'POST', body: JSON.stringify(body) })
          await refreshStatus(result)
          setArtistText(result?.artist ?? null)
          setNotice(revert === true ? t('artistReverted') : t('artistSaved'))
          // The floating window keeps its own copy of the per-mode text, so it is told
          // to re-read instead of being left showing what the string said before.
          if (typeof refreshStudioArtist === 'function') refreshStudioArtist()
          if (typeof refreshArtistDock === 'function') refreshArtistDock()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      /**
       * Upload one reference image.
       *
       * `api()` is unusable here: it forces a JSON content type and parses the
       * response as JSON, both of which are wrong for a body of image bytes. The
       * file goes up as the request body itself, which is exactly why the host
       * reads it raw instead of expecting base64 inside JSON.
       */
      const uploadArtistImage = React.useCallback(async (id, file) => {
        const response = await fetch(`${API}/artist-image?id=${id}`, {
          method: 'POST',
          headers: { 'Content-Type': (file && file.type) || 'application/octet-stream' },
          body: file
        })
        const text = await response.text()
        let body = {}
        try {
          body = text ? JSON.parse(text) : {}
        } catch {
          throw new Error(`${response.status}: ${text.slice(0, 200)}`)
        }
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
        return body
      }, [])

      /**
       * Make a new artist string, with its image if one was chosen.
       *
       * Deliberately two calls: the record is created first so the image has an id
       * to hang off, and an image that fails still leaves a usable entry rather than
       * losing the name and text along with it.
       *
       * The new entry is not selected. Picking a style silently changes how every
       * later render looks, and "I added a thing" is not the same instruction as
       * "use this thing from now on".
       */
      const onCreateArtist = async () => {
        const name = artistNewName.trim()
        setArtistNewNotice('')
        if (name === '') {
          // The form refuses here and nowhere else, so the reason has to appear next
          // to the button: the panel's own error card is far above the artist grid.
          setArtistNewError(t('artistNameNeeded'))
          return
        }
        setBusy('artistnew')
        setArtistNewError('')
        setError('')
        setNotice('')
        try {
          const result = await api('/artist-add', {
            method: 'POST',
            body: JSON.stringify({ name, positive: artistNewPositive, negative: artistNewNegative })
          })
          const id = Number(result?.id)
          let uploaded = false
          if (artistNewImage !== null && Number.isInteger(id)) {
            try {
              await uploadArtistImage(id, artistNewImage)
              uploaded = true
            } catch (uploadError) {
              // The record exists either way, so this is a warning rather than a
              // failure — and it still belongs right under the button that made it.
              setArtistNewError(`${t('artistCreatedNoImage')}：${uploadError.message}`)
            }
          }
          if (Number.isInteger(id)) {
            setArtistNewNotice(
              `${t('artistCreatedAs')} #${id} ${name}${uploaded ? `（${t('artistUploaded')}）` : ''}　${t('artistCreatedNotPicked')}`
            )
            setNotice(t('artistCreated'))
          }
          setArtistNewName('')
          setArtistNewPositive('')
          setArtistNewNegative('')
          setArtistNewImage(null)
          setArtistNewOpen(false)
          setArtistDeleteArmed(-1)
          // A search left over from before would hide the very entry just made, so the
          // list is reloaded unfiltered; the new row is then scrolled to below.
          if (artistQuery !== '') onArtistQuery('')
          await loadArtists(artistQuery === '' ? artistQuery : '')
          await refreshStatus(result)
          if (Number.isInteger(id)) setJustCreatedId(id)
          if (typeof refreshStudioArtist === 'function') refreshStudioArtist()
          if (typeof refreshArtistDock === 'function') refreshArtistDock()
        } catch (err) {
          setArtistNewError(err.message)
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      /**
       * Delete one hand-made artist string.
       *
       * Two clicks, because the button ends up next to the one that saves and the
       * result cannot be undone: the record, its uploaded file and every memory of
       * the id all go.
       */
      const onDeleteArtist = async (id) => {
        if (artistDeleteArmed !== id) {
          setArtistDeleteArmed(id)
          return
        }
        setBusy(`artistdel:${id}`)
        setError('')
        setNotice('')
        try {
          const result = await api('/artist-remove', { method: 'POST', body: JSON.stringify({ id }) })
          setArtistDeleteArmed(-1)
          setArtistOpen(false)
          setArtistText(null)
          setNotice(t('artistDeleted'))
          await loadArtists(artistQuery)
          await refreshStatus(result)
          if (typeof refreshStudioArtist === 'function') refreshStudioArtist()
          if (typeof refreshArtistDock === 'function') refreshArtistDock()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      /** Give the entry being edited a different reference image. */
      const onReplaceArtistImage = async (file) => {
        const id = currentArtistId
        if (id < 0 || file === null || file === undefined) return
        setArtistUploading(String(id))
        setError('')
        setNotice('')
        try {
          const result = await uploadArtistImage(id, file)
          setNotice(t('artistUploaded'))
          setArtistText(result?.artist ?? artistText)
          await loadArtists(artistQuery)
          await refreshStatus(result)
          if (typeof refreshStudioArtist === 'function') refreshStudioArtist()
          if (typeof refreshArtistDock === 'function') refreshArtistDock()
        } catch (err) {
          setError(err.message)
        } finally {
          setArtistUploading('')
        }
      }

      /**
       * Drop the uploaded image, putting the archive's own back in place.
       *
       * Offered only when there is one to drop, so the button never claims a state
       * the entry is not in.
       */
      const onClearArtistImage = async () => {
        const id = currentArtistId
        if (id < 0) return
        setArtistUploading(String(id))
        setError('')
        setNotice('')
        try {
          const result = await api(`/artist-image?id=${id}`, { method: 'DELETE' })
          setNotice(t('artistUploadGone'))
          setArtistText(result?.artist ?? artistText)
          await loadArtists(artistQuery)
          await refreshStatus(result)
          if (typeof refreshStudioArtist === 'function') refreshStudioArtist()
          if (typeof refreshArtistDock === 'function') refreshArtistDock()
        } catch (err) {
          setError(err.message)
        } finally {
          setArtistUploading('')
        }
      }

      /** A file picker that reports the chosen File rather than its path. */
      const filePicker = (onPick, title) =>
        h(
          'label',
          { style: { ...button(false), display: 'inline-flex', alignItems: 'center', gap: 6 } },
          title,
          h('input', {
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp,image/gif',
            style: { display: 'none' },
            onChange: (event) => {
              const picked = event?.target?.files?.[0] ?? null
              onPick(picked)
            }
          })
        )

      const onKeyAction = async (route, body) => {
        setBusy(`key:${route}`)
        setError('')
        setNotice('')
        try {
          await refreshStatus(await api(route, { method: 'POST', body: JSON.stringify(body ?? {}) }))
          if (route === '/keys/add') {
            setNewToken('')
            setNewLabel('')
          }
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      /**
       * Refresh the membership and quota reading for every enabled key.
       *
       * The request carries no body: the host reads its own stored keys, and a
       * failed quota read must not change which keys may render — that is why
       * this is not the verify button.
       */
      const onQuotaRefresh = async () => {
        setBusy('quota')
        setError('')
        try {
          await api('/quota', { method: 'POST', body: JSON.stringify({}) })
          await refreshStatus(null)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      /**
       * The line above a key's bar: who the key is and what it holds.
       *
       * Anlas is a balance, not a free-image count, so it sits beside the tier
       * and the expiry rather than being folded into the estimate below.
       */
      const quotaHeadline = (key) => {
        const record = key.subscription
        if (record === null || record === undefined) return t('quotaUnqueried')
        const parts = [`tier ${record.tier ?? '—'}`]
        if (record.expiresAt !== null && record.expiresAt !== undefined) {
          parts.push(`${t('quotaExpires')}${new Date(record.expiresAt).toLocaleDateString()}`)
        }
        if (record.remainingAnlas !== null && record.remainingAnlas !== undefined) {
          parts.push(`${t('quotaAnlas')} ${record.remainingAnlas}`)
        }
        return parts.join('　')
      }

      const QUOTA_REASONS = {
        inactive: 'quotaInactive',
        'non-opus': 'quotaNonOpus',
        'missing-usage': 'quotaMissingUsage',
        'invalid-usage': 'quotaInvalidUsage',
        unqueried: 'quotaUnqueried'
      }

      /**
       * A key's quota as a bar plus a sentence.
       *
       * The bar is clamped and the text is not: `percent` may legitimately read
       * above 100, and an unavailable quota says why instead of drawing a zero
       * that would read like a real measurement.
       */
      const quotaBody = (key) => {
        const quota = key.v5Quota ?? { status: 'unqueried' }
        if (quota.status === 'error') {
          return [h('div', { style: label }, `${t('quotaFailed')}${quota.code ? `（${quota.code}）` : ''}`)]
        }
        if (quota.status !== 'ok') {
          return [h('div', { style: label }, t(QUOTA_REASONS[quota.reason] ?? 'quotaUnqueried'))]
        }
        const refill =
          quota.dailyRefillPercent === null
            ? t('quotaDailyUnknown')
            : quota.remainingPercent < 100 && quota.dailyRefillPercent > 0
              ? `${t('quotaDaily')}${quota.dailyRefillPercent}% · ${quota.dailyRefillImages}${t('quotaUnit')}`
              : t('quotaPaused')
        return [
          h('progress', {
            max: 100,
            value: Math.min(100, Math.max(0, quota.remainingPercent)),
            style: { width: '100%', height: 8 }
          }),
          h(
            'div',
            { style: { ...label, display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('span', {}, `${quota.remainingPercent}%`),
            h('span', {}, `${quota.remainingImages}${t('quotaUnit')}`),
            quota.isNegative ? h('span', { style: { color: '#c62828' } }, t('quotaOver')) : null,
            h('span', {}, `· ${refill}`)
          )
        ]
      }

      const onToggleAuto = async () => {
        setBusy('auto')
        setError('')
        try {
          await refreshStatus(
            await api('/config', { method: 'POST', body: JSON.stringify({ autoGenerate: status?.autoGenerate !== true }) })
          )
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      // The reply transport's switch. The host answers with the state it actually applied, and
      // that answer is handed straight to the transcript half: the streak and the button must
      // read the same truth, or the switch argues with the thing it switches.
      const onToggleReply = async () => {
        setBusy('reply')
        setError('')
        try {
          const next = await api('/config', {
            method: 'POST',
            body: JSON.stringify({ replyTransport: status?.replyTransport !== true })
          })
          setReplyTransport(next?.status?.replyTransport === true)
          await refreshStatus(next)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      if (form === null) {
        return h('div', { style: { padding: 24, fontSize: 13 } }, error || t('loading'))
      }

      const heavy =
        (Number(form.width) * Number(form.height)) / (832 * 1216) * (Number(form.steps) / 28) > HEAVY_UNITS

      const numericField = (key, title, step) =>
        h(
          'div',
          { key, style: cell(0.5) },
          h('label', { style: label }, title),
          h('input', {
            type: 'number',
            step: step ?? 1,
            style: input,
            value: form[key] ?? '',
            onChange: set(key)
          })
        )

      const textField = (key, title, placeholder) =>
        h(
          'div',
          { key, style: cell(2) },
          h('label', { style: label }, title),
          h('input', { style: input, placeholder, value: form[key] ?? '', onChange: set(key) })
        )

      // The display scale, as a percentage of the reading column. It lives here rather
      // than in the floating window because this panel is the settings surface: it is
      // already where every other global knob is, and it survives a reload.
      const displayScale = Number(form.displayWidth ?? 60)
      // A value this plugin never offered — hand-edited, or written by an older build —
      // still has to be selectable, or opening the panel would silently rewrite it and
      // the first save would snap the page to the nearest preset.
      const displayChoices =
        DISPLAY_SCALES.includes(displayScale) || !Number.isFinite(displayScale)
          ? DISPLAY_SCALES
          : [...DISPLAY_SCALES, displayScale]
      const clickZoom = (form.displayClickZoom ?? status?.display?.clickZoom) !== false

      return h(
        'div',
        {
          // Marks this subtree as a control surface, so the image sweep does not treat the
          // panel's own thumbnails as content to enlarge.
          [STUDIO_MARK]: 'panel',
          style: {
            height: '100%',
            overflowY: 'auto',
            padding: '20px 24px 40px',
            boxSizing: 'border-box',
            fontSize: 13,
            lineHeight: '20px'
          }
        },
        h('div', { style: { fontSize: 18, fontWeight: 600 } }, t('title')),
        h('div', { style: { ...label, marginTop: 4 } }, t('subtitle')),

        error ? h('div', { style: { ...card, color: '#c62828' } }, `${t('failed')}：${error}`) : null,
        notice ? h('div', { style: { ...card, color: '#2e7d32' } }, notice) : null,

        // ---- credential + connection -------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('credentials'))),
        h(
          'div',
          { style: row },
          h(
            'div',
            { style: cell(2) },
            h('label', { style: label }, t('token')),
            h('input', {
              type: 'password',
              style: input,
              placeholder: t('tokenPlaceholder'),
              value: form.token ?? '',
              onChange: set('token')
            }),
            h(
              'div',
              { style: { ...label, marginTop: 4 } },
              status?.tokenSource === 'env'
                ? t('tokenFromEnv')
                : status?.tokenSet
                  ? t('tokenSet')
                  : t('tokenNone')
            )
          ),
          textField('baseUrl', t('baseUrl')),
          textField('model', t('model'))
        ),

        // ---- sampling defaults -------------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('defaults'))),
        h(
          'div',
          { style: row },
          numericField('width', t('width'), 64),
          numericField('height', t('height'), 64),
          numericField('steps', t('steps')),
          numericField('scale', t('scale'), 0.1),
          numericField('ucPreset', t('ucPreset')),
          textField('sampler', t('sampler'))
        ),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          textField('proxy', t('proxy')),
          h('div', { style: { ...label, flex: '3 1 240px' } }, t('proxyHint'))
        ),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          h(
            'div',
            { style: cell(4) },
            h('label', { style: label }, t('negative')),
            h('textarea', {
              style: { ...input, height: 56, padding: 8, resize: 'vertical', fontFamily: 'inherit' },
              value: form.negativePrompt ?? '',
              onChange: set('negativePrompt')
            })
          )
        ),
        heavy ? h('div', { style: { ...label, marginTop: 6, color: '#e08b00' } }, t('heaviest')) : null,

        // ---- paths + guards ----------------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('paths'))),
        h(
          'div',
          { style: row },
          textField('outputDir', t('outputDir')),
          numericField('maxImagesPerCall', t('guard')),
          numericField('keepImages', t('keepImages'))
        ),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          textField('libraryDir', t('libraryDir')),
          textField('librarySourceDir', t('librarySourceDir'))
        ),

        // ---- display ------------------------------------------------------
        //
        // Moved out of the floating window on purpose. That window is a convenience for
        // the per-mode render settings; this panel is the plugin's real settings surface
        // and is the place a change is actually expected to stick.
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('displayTitle'))),
        h(
          'div',
          { style: row },
          h(
            'div',
            { style: cell(2) },
            h('label', { style: label }, t('displayWidth')),
            h(
              'select',
              { style: input, value: String(displayScale), onChange: set('displayWidth') },
              displayChoices.map((percent) => h('option', { key: percent, value: String(percent) }, `${percent}%`))
            ),
            h(
              'div',
              { style: { ...label, marginTop: 4 } },
              `${t('displayHint')}${t('displayFound')}：${claimed}`
            )
          ),
          h(
            'div',
            { style: cell(2) },
            h('label', { style: label }, t('displayClickZoom')),
            h('input', {
              type: 'checkbox',
              style: { width: 16, height: 16, marginTop: 2 },
              checked: clickZoom,
              onChange: (event) => setForm((prev) => ({ ...prev, displayClickZoom: event.target.checked }))
            })
          )
        ),

        h(
          'div',
          { style: { marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' } },
          h(
            'button',
            { type: 'button', style: button(true), onClick: onSave, disabled: busy === 'save' },
            busy === 'save' ? t('saving') : t('save')
          ),
          h('div', { style: label }, `${t('libraries')}：${(status?.libraries ?? []).map((row) => `${row.library}(${row.entries})`).join('、') || '—'}`)
        ),

        // ---- key pool -----------------------------------------------------
        h(
          'div',
          { style: section },
          h('div', { style: { fontWeight: 600 } }, t('keys')),
          h(
            'div',
            { style: { ...label, marginTop: 4 } },
            status?.keySummary
              ? `${status.keySummary.keyCount} 个 · 可用 ${status.keySummary.usableKeyCount} · 空闲 ${status.keySummary.availableKeyCount} · ${t('concurrency')} ${status.keySummary.concurrency}` +
                (status.keySummary.queuedCount > 0 ? ` · 队列 ${status.keySummary.queuedCount}` : '') +
                (status.keySummary.activeCount > 0 ? ` · 在飞 ${status.keySummary.activeCount}` : '')
              : ''
          ),
          h(
            'div',
            { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
            (status?.keys ?? []).map((key) =>
              h(
                'div',
                { key: key.id, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } },
                h('span', {
                  style: {
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    flex: 'none',
                    background: !key.enabled
                      ? '#c62828'
                      : key.status === 'healthy'
                        ? '#2e7d32'
                        : key.status === 'cooldown'
                          ? '#e08b00'
                          : '#9e9e9e'
                  }
                }),
                h('span', { style: { flex: 'none', minWidth: 96 } }, key.label),
                h('span', { style: { ...label, flex: 'none' } }, key.fingerprint),
                h(
                  'span',
                  { style: { ...label, flex: 1 } },
                  `${key.status}` +
                    (key.completed > 0 ? ` · 已完成 ${key.completed}` : '') +
                    (key.subscription && key.subscription.tier !== null && key.subscription.tier !== undefined ? ` · tier ${key.subscription.tier}` : '')
                ),
                h(
                  'button',
                  { type: 'button', style: button(false), onClick: () => onKeyAction('/keys/update', { id: key.id, enabled: !key.enabled }) },
                  key.enabled ? t('keyDisable') : t('keyEnable')
                ),
                h('button', { type: 'button', style: button(false), onClick: () => onKeyAction('/keys/remove', { id: key.id }) }, t('keyRemove'))
              )
            )
          ),
          (status?.keySummary?.keyIssues ?? []).map((issue) =>
            h('div', { key: issue.id, style: { ...label, marginTop: 4, color: '#c62828' } }, `${issue.label}：${issue.error}`)
          ),
          h(
            'div',
            { style: { ...row, marginTop: 10 } },
            h(
              'div',
              { style: cell(0.6) },
              h('input', { style: input, placeholder: t('keyLabel'), value: newLabel, onChange: (event) => setNewLabel(event.target.value) })
            ),
            h(
              'div',
              { style: cell(2.4) },
              h('input', {
                type: 'password',
                style: input,
                placeholder: t('keyToken'),
                value: newToken,
                onChange: (event) => setNewToken(event.target.value)
              })
            ),
            h(
              'button',
              {
                type: 'button',
                style: button(true),
                onClick: () => onKeyAction('/keys/add', { label: newLabel, token: newToken }),
                disabled: busy === 'key:/keys/add' || newToken.trim() === ''
              },
              t('keyAdd')
            ),
            h(
              'button',
              { type: 'button', style: button(false), onClick: () => onKeyAction('/keys/verify', {}), disabled: busy === 'key:/keys/verify' },
              t('keyVerify')
            )
          )
        ),

        // ---- membership and quota -----------------------------------------
        // Nothing here costs Anlas: the subscription record is the same free read
        // the probe uses. The bar is a native `<progress>` with a clamped value
        // while the text keeps the real percentage — a 125% reading is a fact
        // about the account, not something to round away — and a quota that could
        // not be read explains itself instead of drawing a zero.
        h(
          'div',
          { style: section },
          h('div', { style: { fontWeight: 600 } }, t('quota')),
          h('div', { style: { ...label, marginTop: 4 } }, t('quotaHint')),
          h(
            'div',
            { style: { ...label, marginTop: 6 } },
            `${t('quotaTotal')}${
              status?.quota?.remainingImages === null || status?.quota?.remainingImages === undefined
                ? t('quotaUnknown')
                : `${status.quota.remainingImages}${t('quotaUnit')}`
            }`,
            Number(status?.quota?.knownRemainingKeyCount) > 0
              ? `　（${status.quota.knownRemainingKeyCount}/${status.quota.keyCount} 个 Key）`
              : '',
            Number(status?.quota?.failedKeyCount) > 0
              ? `　· ${t('quotaFailed')} ${status.quota.failedKeyCount}`
              : '',
            status?.quota?.refreshedAt
              ? `　· ${t('quotaUpdated')}${new Date(status.quota.refreshedAt).toLocaleTimeString()}`
              : ''
          ),
          (status?.keys ?? []).map((key) =>
            h(
              'div',
              {
                key: `quota:${key.id}`,
                style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                h('span', { style: { flex: 'none', minWidth: 96 } }, key.label),
                h('span', { style: { ...label, flex: 1 } }, quotaHeadline(key))
              ),
              ...quotaBody(key)
            )
          ),
          h(
            'div',
            { style: { ...row, marginTop: 10 } },
            h(
              'button',
              { type: 'button', style: button(false), onClick: onQuotaRefresh, disabled: busy === 'quota' },
              busy === 'quota' ? t('quotaRefreshing') : t('quotaRefresh')
            )
          )
        ),

        // ---- artist string ------------------------------------------------
        h(
          'div',
          { style: section },
          h('div', { style: { fontWeight: 600 } }, t('artist')),
          // The selection lives in the config and survives a restart, but the grid
          // is 96 tiles tall and the chosen one is usually far down it. Showing the
          // current pick here — with its own thumbnail — is what makes "remembered"
          // visible instead of something the user has to scroll to confirm.
          Number(status?.artistId) >= 0 && status?.artistName
            ? h(
                'div',
                {
                  style: {
                    marginTop: 8,
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    padding: 8,
                    borderRadius: token('--dsw-radius-md', '6px'),
                    border: `1px solid ${token('--dsw-alias-accent', '#2d6cff')}`,
                    background: token('--dsw-alias-fill-l1', 'rgba(45,108,255,0.06)')
                  }
                },
                h('img', {
                  src: `${API}/artist-image?id=${Number(status.artistId)}`,
                  alt: '',
                  loading: 'lazy',
                  style: { width: 56, height: 79, objectFit: 'cover', borderRadius: 4, flex: 'none' }
                }),
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontSize: 13, fontWeight: 600 } }, `${t('artistCurrent')}：${status.artistName}`),
                  h('div', { style: label }, `#${Number(status.artistId)}`)
                ),
                h(
                  'button',
                  { type: 'button', style: button(false), onClick: () => onPickArtist(-1), disabled: busy === 'artist:-1' },
                  t('artistNone')
                )
              )
            : null,
          // ---- artist text editor ------------------------------------------
          // Under the current pick, because that is what it edits. Collapsed by
          // default — a 1500-character prompt is a wall of text inside a sidebar —
          // but always reachable as a button, since a hidden editor is one nobody
          // finds. Panel-only: the floating window stays a readout.
          Number(status?.artistId) >= 0
            ? h(
                'div',
                { style: { marginTop: 8 } },
                h(
                  'button',
                  { type: 'button', style: button(artistOpen === true), onClick: onToggleArtistEditor },
                  artistOpen === true
                    ? t('artistEditHide')
                    : `${t('artistEdit')}${status?.artistEdited === true ? ` · ${t('artistEditedTag')}` : ''}`
                ),
                artistOpen !== true
                  ? null
                  : h(
                      'div',
                      {
                        style: {
                          marginTop: 8,
                          padding: 8,
                          borderRadius: token('--dsw-radius-md', '6px'),
                          border: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`
                        }
                      },
                      artistText === null
                        ? h('div', { style: label }, t('artistEditLoading'))
                        : h(
                            'div',
                            null,
                            h(
                              'div',
                              { style: { ...label, marginBottom: 4 } },
                              `${t('artistPositive')}　${(artistDraft ?? artistText).positive.length} ${t('artistCharUnit')}` +
                                (artistText.edited === true ? `　· ${t('artistEditedTag')}` : '')
                            ),
                            h('textarea', {
                              style: {
                                ...input,
                                width: '100%',
                                height: 96,
                                padding: 6,
                                resize: 'vertical',
                                fontFamily: 'inherit',
                                fontSize: 12
                              },
                              value: (artistDraft ?? artistText).positive,
                              // Editable only once the host's text has arrived: a box
                              // seeded empty would save an empty prompt over the archive.
                              disabled: artistDraft === null,
                              onChange: (event) =>
                                setArtistDraft({ positive: event.target.value, negative: (artistDraft ?? artistText).negative })
                            }),
                            h(
                              'div',
                              { style: { ...label, marginTop: 6, marginBottom: 4 } },
                              `${t('artistNegative')}　${(artistDraft ?? artistText).negative.length} ${t('artistCharUnit')}`
                            ),
                            h('textarea', {
                              style: {
                                ...input,
                                width: '100%',
                                height: 64,
                                padding: 6,
                                resize: 'vertical',
                                fontFamily: 'inherit',
                                fontSize: 12
                              },
                              value: (artistDraft ?? artistText).negative,
                              disabled: artistDraft === null,
                              onChange: (event) =>
                                setArtistDraft({ positive: (artistDraft ?? artistText).positive, negative: event.target.value })
                            }),
                            h(
                              'div',
                              { style: { ...row, marginTop: 6 } },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  style: button(true),
                                  onClick: () => onSaveArtistEdit(false),
                                  disabled: busy === 'artisttext' || artistDraft === null
                                },
                                busy === 'artisttext' ? t('saving') : t('artistSave')
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  style: button(false),
                                  onClick: () => onSaveArtistEdit(true),
                                  disabled: busy === 'artisttext'
                                },
                                t('artistRevert')
                              ),
                              // The image is its own upload, so replacing it does not
                              // require saving the text first.
                              filePicker(
                                onReplaceArtistImage,
                                artistUploading === String(currentArtistId) ? t('artistUploading') : t('artistImageUpload')
                              ),
                              artistText.uploaded !== true
                                ? null
                                : h(
                                    'button',
                                    {
                                      type: 'button',
                                      style: button(false),
                                      onClick: onClearArtistImage,
                                      disabled: artistUploading === String(currentArtistId)
                                    },
                                    t('artistImageClearUpload')
                                  )
                            ),
                            h('div', { style: { ...label, marginTop: 6, lineHeight: '16px' } }, t('artistEditHint')),
                            // Only for hand-made entries: an imported one is not ours to
                            // delete, so offering the button would be offering a lie.
                            artistText.custom !== true
                              ? null
                              : h(
                                  'div',
                                  { style: { ...row, marginTop: 6 } },
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      style:
                                        artistDeleteArmed === currentArtistId
                                          ? { ...button(false), background: '#c62828', border: '1px solid transparent', color: '#fff' }
                                          : button(false),
                                      onClick: () => onDeleteArtist(currentArtistId),
                                      disabled: busy === `artistdel:${currentArtistId}`
                                    },
                                    artistDeleteArmed === currentArtistId ? t('artistDeleteConfirm') : t('artistDelete')
                                  ),
                                  artistDeleteArmed === currentArtistId
                                    ? h(
                                        'button',
                                        { type: 'button', style: button(false), onClick: () => setArtistDeleteArmed(-1) },
                                        t('artistDeleteCancel')
                                      )
                                    : null
                                ),
                            artistText.custom !== true
                              ? null
                              : h('div', { style: { ...label, marginTop: 6, lineHeight: '16px' } }, t('artistDeleteHint'))
                          )
                    )
              )
            : null,
          // ---- new artist string -------------------------------------------
          // Always reachable rather than gated on a current pick: making one is
          // wanted most when there is nothing to edit yet.
          h(
            'div',
            { style: { marginTop: 8 } },
            h(
              'button',
              {
                type: 'button',
                style: button(artistNewOpen === true),
                onClick: () => setArtistNewOpen((open) => open !== true)
              },
              artistNewOpen === true ? t('artistNewHide') : t('artistNew')
            ),
            artistNewOpen !== true
              ? null
              : h(
                  'div',
                  { style: card },
                  h('label', { style: label }, t('artistName')),
                  h('input', {
                    style: input,
                    placeholder: t('artistNamePlaceholder'),
                    value: artistNewName,
                    onChange: (event) => setArtistNewName(event.target.value)
                  }),
                  h('label', { style: { ...label, marginTop: 6 } }, t('artistNewPositive')),
                  h('textarea', {
                    style: { ...input, height: 96, padding: 6, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 },
                    value: artistNewPositive,
                    onChange: (event) => setArtistNewPositive(event.target.value)
                  }),
                  h('label', { style: { ...label, marginTop: 6 } }, t('artistNewNegative')),
                  h('textarea', {
                    style: { ...input, height: 64, padding: 6, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 },
                    value: artistNewNegative,
                    onChange: (event) => setArtistNewNegative(event.target.value)
                  }),
                  h('label', { style: { ...label, marginTop: 6 } }, t('artistImage')),
                  h(
                    'div',
                    { style: { ...row, marginTop: 4 } },
                    filePicker(setArtistNewImage, t('artistChooseImage')),
                    artistNewImage === null
                      ? null
                      : h(
                          'div',
                          { style: { ...label, flex: 1, minWidth: 0, wordBreak: 'break-word' } },
                          `${t('artistImageChosen')}：${artistNewImage.name}　${Math.round(Number(artistNewImage.size ?? 0) / 1024)} KB`
                        )
                  ),
                  h(
                    'div',
                    { style: { ...row, marginTop: 8 } },
                    h(
                      'button',
                      {
                        type: 'button',
                        style: button(true),
                        onClick: onCreateArtist,
                        // A disabled button explains itself; a click on a form that
                        // silently does nothing is what got reported as broken.
                        disabled: busy === 'artistnew' || artistNewName.trim() === ''
                      },
                      busy === 'artistnew' ? t('artistCreating') : t('artistCreate')
                    ),
                    artistNewName.trim() === ''
                      ? h('div', { style: { ...label, marginLeft: 8, flex: 1 } }, t('artistNameNeeded'))
                      : null
                  ),
                  // The outcome of this card's own button, printed where the button is.
                  artistNewError !== ''
                    ? h('div', { style: { ...label, marginTop: 6, color: '#c62828' } }, `${t('failed')}：${artistNewError}`)
                    : null,
                  artistNewNotice !== ''
                    ? h('div', { style: { ...label, marginTop: 6, color: '#2e7d32', lineHeight: '16px' } }, artistNewNotice)
                    : null,
                  h(
                    'div',
                    { style: { ...label, marginTop: 6, lineHeight: '16px' } },
                    `${t('artistImageHint')}　${t('artistNewHint')}`
                  )
                )
          ),
          // The card above closes on a successful create, so the outcome is repeated
          // here — inside the card it would vanish at exactly the moment it matters.
          // The two copies never show at once, or a refusal would be printed twice.
          artistNewOpen !== true && artistNewError !== ''
            ? h('div', { style: { ...label, marginTop: 6, color: '#c62828' } }, `${t('failed')}：${artistNewError}`)
            : null,
          artistNewOpen !== true && artistNewNotice !== ''
            ? h('div', { style: { ...label, marginTop: 6, color: '#2e7d32', lineHeight: '16px' } }, artistNewNotice)
            : null,
          Number(status?.artistId) >= 0 && !status?.artistName
            ? h('div', { style: { ...label, marginTop: 6, color: '#c62828' } }, t('artistMissing'))
            : null,
          h(
            'div',
            { style: { ...label, marginTop: 4 } },
            // `status` is authoritative and always present, so prefer it and let the
            // `/artists` fetch fill in before the first status arrives.
            `${t('artistCount')} ${artistCount || status?.artistCount || 0}　${t('artistCurrent')}：${status?.artistName ?? '—'}`
          ),
          h(
            'div',
            { style: { ...row, marginTop: 8 } },
            h(
              'div',
              { style: cell(3) },
              h('input', {
                style: input,
                placeholder: t('artistSearch'),
                value: artistQuery,
                onChange: (event) => onArtistQuery(event.target.value)
              })
            ),
            h(
              'button',
              { type: 'button', style: button(false), onClick: () => onPickArtist(-1), disabled: busy === 'artist:-1' },
              t('artistNone')
            )
          ),
          h(
            'div',
            {
              style: {
                marginTop: 8,
                display: 'grid',
                gap: 6,
                gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                maxHeight: 340,
                overflowY: 'auto'
              }
            },
            artists.map((row) =>
              h(
                'button',
                {
                  key: row.id,
                  type: 'button',
                  title: row.name,
                  // React honours `ref`; the render-test stub just carries it as a
                  // prop, so the scroll effect guards for a null node. The entry just
                  // made outranks the remembered pick here — see the scroll effect.
                  ref:
                    row.id === justCreatedId
                      ? freshArtistRow
                      : status?.artistId === row.id
                        ? selectedArtistRow
                        : undefined,
                  onClick: () => onPickArtist(row.id),
                  disabled: busy === `artist:${row.id}`,
                  style: {
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    padding: 6,
                    cursor: 'pointer',
                    textAlign: 'left',
                    borderRadius: token('--dsw-radius-md', '6px'),
                    // The tile that was just made is ringed, so "where did it go" is
                    // answered by looking rather than by scrolling to the bottom.
                    outline: row.id === justCreatedId ? `2px solid ${token('--dsw-alias-accent', '#2d6cff')}` : 'none',
                    outlineOffset: 1,
                    // The chosen tile has to be unmistakable at a glance: a thicker
                    // edge plus a tinted fill, not a slightly different grey.
                    border: `2px solid ${
                      status?.artistId === row.id ? token('--dsw-alias-accent', '#2d6cff') : token('--dsw-alias-border-l1', '#e6e6ea')
                    }`,
                    background:
                      status?.artistId === row.id ? token('--dsw-alias-fill-l1', 'rgba(45,108,255,0.10)') : 'transparent',
                    color: 'inherit',
                    fontSize: 12
                  }
                },
                row.hasImage
                  ? h('img', {
                      src: `${API}/artist-image?id=${row.id}`,
                      alt: '',
                      loading: 'lazy',
                      style: { width: 44, height: 62, objectFit: 'cover', borderRadius: 4, flex: 'none' }
                    })
                  : h('div', {
                      style: {
                        width: 44,
                        height: 62,
                        borderRadius: 4,
                        flex: 'none',
                        background: token('--dsw-alias-fill-l1', '#eeeeee')
                      }
                    }),
                h(
                  'span',
                  { style: { flex: 1, lineHeight: '16px', wordBreak: 'break-word' } },
                  `#${row.id} ${row.name}`,
                  // A customised entry is marked in the grid, or the only way to find it
                  // again is to open all of them one at a time.
                  row.edited === true
                    ? h(
                        'span',
                        {
                          style: {
                            marginLeft: 6,
                            padding: '0 4px',
                            borderRadius: 3,
                            fontSize: 10,
                            border: `1px solid ${token('--dsw-alias-accent', '#2d6cff')}`,
                            color: token('--dsw-alias-accent', '#2d6cff')
                          }
                        },
                        t('artistEditedTag')
                      )
                    : null,
                  // Hand-made entries are marked as such: they are the only ones that
                  // can be deleted, and the only ones that survive re-importing.
                  row.custom === true
                    ? h(
                        'span',
                        {
                          style: {
                            marginLeft: 6,
                            padding: '0 4px',
                            borderRadius: 3,
                            fontSize: 10,
                            border: `1px dashed ${token('--dsw-alias-label-tertiary', '#888')}`,
                            color: token('--dsw-alias-label-tertiary', '#888')
                          }
                        },
                        t('artistCustomTag')
                      )
                    : null
                ),
                // The star sits at the right edge of the tile and is the only part of it
                // that does not pick: clicking it stars the entry, clicking the tile
                // picks it. A `span` rather than a `button` because the tile itself is a
                // button, and a button inside a button is not something the browser can
                // be asked to make sense of.
                h(
                  'span',
                  {
                    key: 'favorite',
                    role: 'button',
                    tabIndex: 0,
                    'aria-pressed': row.favorite === true ? 'true' : 'false',
                    title: row.favorite === true ? t('artistFavRemove') : t('artistFavAdd'),
                    onClick: (event) => {
                      event.stopPropagation()
                      onToggleFavorite(row)
                    },
                    style: {
                      flex: 'none',
                      fontSize: 16,
                      lineHeight: '18px',
                      padding: '0 2px',
                      cursor: 'pointer',
                      color: row.favorite === true ? '#e8a800' : token('--dsw-alias-label-tertiary', '#888')
                    }
                  },
                  row.favorite === true ? '★' : '☆'
                )
              )
            )
          )
        ),

        // ---- test render --------------------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('test'))),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          h(
            'div',
            { style: cell(4) },
            h('label', { style: label }, t('testPrompt')),
            h('textarea', {
              style: { ...input, height: 64, padding: 8, resize: 'vertical', fontFamily: 'inherit' },
              placeholder: t('testPromptPlaceholder'),
              value: prompt,
              onChange: (event) => setPrompt(event.target.value)
            })
          ),
          h(
            'div',
            { style: cell(0.4) },
            h('label', { style: label }, t('variants')),
            h('input', {
              type: 'number',
              min: 1,
              max: status?.maxImagesPerCall ?? 4,
              style: input,
              value: variants,
              onChange: (event) => setVariants(event.target.value)
            })
          ),
          h(
            'button',
            { type: 'button', style: button(true), onClick: onRender, disabled: busy === 'render' },
            busy === 'render' ? t('testing') : t('test')
          ),
          h(
            'button',
            { type: 'button', style: button(false), onClick: onProbe, disabled: busy === 'probe' },
            busy === 'probe' ? t('probing') : t('probe')
          )
        ),
        h('div', { style: { ...label, marginTop: 6 } }, t('probeHint')),
        h(
          'div',
          { style: { ...row, marginTop: 10 } },
          h(
            'button',
            {
              type: 'button',
              style: button(status?.autoGenerate === true),
              onClick: onToggleAuto,
              disabled: busy === 'auto'
            },
            status?.autoGenerate === true ? t('autoOn') : t('autoOff')
          ),
          h('div', { style: { ...label, flex: '3 1 240px' } }, t('autoHint'))
        ),
        // The reply transport's own switch, beside the automatic-render one because they are the
        // same kind of thing: a standing decision about what the model does, made once here.
        h(
          'div',
          { style: { ...row, marginTop: 6 } },
          h(
            'button',
            {
              type: 'button',
              style: button(status?.replyTransport === true),
              onClick: onToggleReply,
              disabled: busy === 'reply'
            },
            status?.replyTransport === true ? t('replyOn') : t('replyOff')
          ),
          h('div', { style: { ...label, flex: '3 1 240px' } }, t('replyHint'))
        ),
        // How much this session has already spent on its own. There is no ceiling any more —
        // the newest block is the bound — so the line simply says what has been rendered.
        status?.autoGenerate === true
          ? h(
              'div',
              { style: { ...label, marginTop: 4 } },
              `${t('autoUsed')} ${autoDone.size}${t('autoImageUnit')}`
            )
          : null,
        // What the last automatic pass actually did. The decision is made in this half and the
        // host keeps this half's own account of it, so "it rendered nothing again" is answered
        // here instead of by a round of questions: the gate that stopped each block, or the
        // marker that held the settle window shut.
        h('div', { style: { ...label, marginTop: 4 } }, lastAutoLine(status?.lastAuto, t)),
        probed === null
          ? null
          : h(
              'div',
              { style: { ...card, color: probed.ok ? '#2e7d32' : '#c62828' } },
              `${probed.ok ? '✅' : '❌'} ${probed.detail ?? ''}`,
              probed.status === undefined ? '' : `　HTTP ${probed.status}`,
              probed.hint ? h('div', { style: { marginTop: 4, color: 'inherit' } }, probed.hint) : null,
              probed.subscription?.tier === undefined || probed.subscription?.tier === null
                ? ''
                : `　档位 ${probed.subscription.tier}　剩余训练步数 ${
                    (probed.subscription.fixedTrainingStepsLeft ?? 0) + (probed.subscription.purchasedTrainingStepsLeft ?? 0)
                  }`
            ),
        h('div', { style: { ...label, marginTop: 6 } }, t('inlineHint')),

        // ---- gallery ------------------------------------------------------
        h(
          'div',
          { style: section },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: { fontWeight: 600 } }, t('gallery')),
            h('div', { style: label }, status?.outputDir ?? ''),
            h(
              'button',
              { type: 'button', style: button(false), onClick: refresh },
              t('refresh')
            )
          )
        ),
        shots.length === 0
          ? h('div', { style: { ...label, marginTop: 10 } }, t('galleryEmpty'))
          : h(
              'div',
              {
                style: {
                  marginTop: 10,
                  display: 'grid',
                  gap: 10,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))'
                }
              },
              shots.map((file) =>
                h(
                  'a',
                  {
                    key: file.name,
                    href: `${API}/file?name=${encodeURIComponent(file.name)}`,
                    target: '_blank',
                    rel: 'noreferrer',
                    style: {
                      display: 'block',
                      borderRadius: token('--dsw-radius-md', '6px'),
                      overflow: 'hidden',
                      border: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`,
                      background:
                        'repeating-conic-gradient(#e9e9ee 0% 25%, #f7f7fa 0% 50%) 50% / 16px 16px'
                    }
                  },
                  h('img', {
                    src: `${API}/file?name=${encodeURIComponent(file.name)}`,
                    alt: file.name,
                    loading: 'lazy',
                    // Claimed by the right-click menu, so a thumbnail in the panel
                    // can be copied or saved without opening it first.
                    [IMG_ATTR]: '1',
                    'data-nai-name': file.name,
                    'data-nai-kind': 'gallery',
                    style: { display: 'block', width: '100%', height: 'auto' }
                  })
                )
              )
            )
      )
    }

    // ---------------------------------------------------------------- code blocks --
    // A prompt sitting in a code block should be one click from an image. There
    // is no slot that renders per code block, so — following the same approach
    // the workspace's own `bundle-chat-delete` uses where no seat exists — this
    // walks the transcript with a MutationObserver and injects a button beside
    // every block that reads like a NovelAI prompt.
    //
    // Two consequences are handled explicitly:
    //   * a transcript re-render discards injected nodes, so results are cached
    //     by prompt hash and restored on the next scan;
    //   * injected nodes must not be mistaken for content, so they carry a marker
    //     and the scanner skips its own output.

    /** Marks a code card this half already decorated. */
    const DONE_ATTR = 'data-nai-imagegen-block'
    /** Marks nodes this half injected, so the scanner skips its own output. */
    const OURS_ATTR = 'data-nai-imagegen-ours'
    /**
     * Marks the render button itself.
     *
     * The bookkeeping map is the fast path to that button, not the only one: a transcript
     * re-render, a second activation of this bundle, or an element that was moved while its
     * decoration stayed behind all leave a button on screen that the map no longer answers for.
     * Looking for the mark finds the button that is actually there.
     */
    const FIRE_ATTR = 'data-nai-imagegen-fire'
    /** Generated results, keyed by prompt hash, so a re-render can restore them. */
    const generated = new Map()
    /**
     * Prompt hashes this half auto-rendered, and when.
     *
     * Counted for the rest of the session — the panel reports how many pictures it has rendered
     * on its own — but only obeyed for a moment after the render starts. That moment covers the
     * one thing worth refusing: the same prompt coming back as a fresh element while its render
     * is still in flight, which would queue a second one. Any longer than that and it is a reply
     * the user asked for again, and the whole point of leaving the toggle on is that it answers
     * without being asked twice.
     */
    const autoDone = new Map()
    /** How long an auto-render keeps other blocks of the same prompt out. */
    const AUTO_FIRE_TTL_MS = 20000
    /** Hosts this half has already answered, so one block is not pressed twice. */
    const firedBlocks = new WeakSet()
    /**
     * Why the last `autoFire` call declined, or `'fired'`/'none' for the other two outcomes.
     *
     * The quiet pass reports this per block, which is how a report of "it did not render" can
     * be answered with the gate that stopped it instead of a guess.
     */
    let lastFireReason = null
    /**
     * Auto-renders allowed for the pass currently running.
     *
     * A normal pass allows everything eligible. The forced pass that happens when
     * the toggle turns on allows exactly one — and scans newest-first, so the one
     * the user is looking at is the one that fires rather than the oldest block
     * in the transcript.
     */
    let autoAllowance = Number.POSITIVE_INFINITY
    /**
     * Whether prompt blocks render on their own. Driven by the panel's toggle,
     * which writes through this flag rather than recreating the observer.
     */
    let autoRender = false
    /**
     * How the panel hears that the stored setting moved without it.
     *
     * The sync loop below lives outside the component tree and owns the flag; the panel owns the
     * button and the status row. Rather than let the two drift, the loop hands a real change to
     * whichever panel is mounted (there is at most one) so it can re-read `/status` and draw the
     * value that is actually in force.
     */
    let onSettingMoved = null
    /**
     * The watcher's scan, published so the panel can force a pass.
     *
     * The observer only re-scans when the DOM changes. A transcript sitting still
     * — which is exactly the case when the user has just found a prompt and
     * flipped auto-render on — would otherwise keep showing a button with
     * nothing rendered behind it.
     */
    let rescanBlocks = null

    /**
     * Blocks that arrived with a replayed transcript rather than a live reply.
     *
     * Switching into a conversation puts every block of that conversation back on screen.
     * A block that has already been answered must not be answered again: the picture is in
     * the conversation above it, and rendering it a second time spends quota to duplicate
     * something the user already has.
     *
     * The mark lands on the blocks a replay-shaped batch actually brought, and on nothing
     * else. This used to be a clock: any block arriving within a grace window after a
     * tear-down was condemned for good. On a long conversation that window is always open —
     * the app re-renders the transcript, the batch removes a few hundred nodes and re-adds
     * the whole of it, and the reply the user is waiting for lands in that same commit, so
     * it was stamped as history and never rendered. Growth is the way back: a stamped block
     * whose text grows on screen is a reply being written, not a stored one being replayed.
     */
    const historyBlocks = new WeakSet()
    /**
     * The blocks of the newest reply, as the quiet pass found them.
     *
     * *Where* a block sits is what decides whether it is answered. The toggle answers the reply
     * in front of the user: an older reply's pictures are already in the transcript above it, and
     * the turn tails say exactly where that boundary runs. `null` means the question does not
     * apply — this is not the quiet pass, or no quiet pass has run yet — and then nothing is
     * narrowed.
     */
    let settleHosts = null
    /** Removals in one batch that mean the transcript was replaced, not appended to. */
    const REPLAY_REMOVALS = 20
    /**
     * How long the whole transcript has to hold still before a render is released.
     *
     * A block is mounted first and filled afterwards, so the pass that first sees it is
     * looking at a fragment, and a streaming reply grows one a few characters at a time.
     * Waiting for a block's *own* text to hold still is not enough, though: a reply writes a
     * prompt and then keeps talking, so the block is already still while the reply is not —
     * and any character landing anywhere in the transcript then ran a pass that fired it
     * mid-stream. The thing that has to finish is the reply, so what is measured is the quiet
     * of the whole document, and this is how much of it is required.
     *
     * It is three seconds and not one, because a live reply is not silent: the process row
     * above it re-renders its elapsed time every second, so a one-second gap is an ordinary
     * pause inside a reply that is still being written, and a one-second window can be
     * satisfied by one. A window longer than that heartbeat cannot. What the pass waits for is
     * the transcript really stopping — the end of the reply, a few seconds on.
     */
    const SETTLE_QUIET_MS = 3000
    /**
     * How often this half re-reads the stored automatic-render setting.
     *
     * The flag is written by the panel's toggle and by one read at activation, and by nothing
     * else — so a setting changed anywhere else (the `nai_config` tool from the chat, a second
     * window, a tab left open since before the change) leaves this page running the old answer
     * while the panel's button shows the new one. That reads exactly like a broken feature, and
     * did: the switch said on, nothing rendered, and nothing on screen said why. A slow clock
     * and one local request is cheaper than the round of questions it saves.
     *
     * Fifteen seconds, not one: this is a setting a person changes, not a stream, and the panel
     * refreshes itself immediately for its own writes.
     */
    const SETTING_POLL_MS = 15000
    /**
     * Elements that mean the assistant is still writing, whatever the clock says.
     *
     * The window above measures silence; these are the transcript saying so out loud.
     * `data-streaming` rides the assistant body being written and a reasoning summary still
     * growing, and `data-state="running"` is a reasoning row, or a command card, still working.
     * A quiet stretch that still has one of these on screen is a pause inside a live reply, not
     * the end of one.
     *
     * Nothing here is a stylesheet class: the app hashes those per build, so only the data
     * attributes hold still. They are page-wide attributes, though, and the app does leave them
     * behind — a command card whose turn was stopped keeps `data-state="running"`, and a
     * transcript put back on screen keeps `data-streaming` on a message that is not arriving any
     * more. Read page-wide and taken literally, one of those held the window shut for the rest of
     * the session and auto-render went quiet without saying why. So a marker has to earn it twice
     * over: it must sit inside the newest turn, and the page must still be moving.
     */
    const LIVE_MARKERS = ['[data-streaming]', '[data-state="running"]']
    /**
     * How long a live marker survives a page that has stopped moving.
     *
     * A reply being written is never silent this long: for as long as a turn is open, the process
     * row above it re-renders its elapsed time every second (`LIVE_RUN_CLOCK_INTERVAL_MS`, one
     * thousand milliseconds), so the document changes at least once a second while one is. The
     * clock here is much longer than any single change, so a marker still on screen after half a
     * minute of no change at all was left over by a turn that ended, and obeying it would only
     * keep the feature quiet.
     */
    const LIVE_STALE_MS = 30000

    /** When the document last changed, in `Date.now()` terms — zero until the first change. */
    let lastChangeAt = 0

    /**
     * The live marker a single node carries.
     * @param node - one node the scan below returned.
     * @returns the selector that matches it, or null if it is not a marker.
     */
    function markerOf(node) {
      if (typeof node?.getAttribute !== 'function') return null
      if (node.getAttribute('data-streaming') !== null) return '[data-streaming]'
      if (node.getAttribute('data-state') === 'running') return '[data-state="running"]'
      return null
    }

    /**
     * The live marker still holding a render back, or null when none is.
     *
     * The walk is the one the transcript below makes, asking a different question: from the end
     * of the document backwards, the first turn boundary reached ends the newest turn, so a
     * marker before it belongs to a reply that has already finished and is not this reply's
     * business. When the boundary is itself the newest thing the walk meets, nothing after it can
     * be live at all — which is the case the page-wide read got wrong.
     *
     * @returns the selector that matched, or null.
     */
    function blockingMarker() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
      // One query, so boundaries and markers come back in document order among each other rather
      // than in two lists that could not be interleaved without comparing the tree.
      const walk = document.querySelectorAll(`[${TURN_TAIL_ATTR}], ${LIVE_MARKERS.join(', ')}`)
      if (walk.length === 0) return null
      const newest = walk[walk.length - 1]
      if (typeof newest?.getAttribute === 'function' && newest.getAttribute(TURN_TAIL_ATTR) !== null) return null
      const marker = markerOf(newest)
      if (marker === null || lastChangeAt === 0) return null
      const now = typeof Date.now === 'function' ? Date.now() : lastChangeAt
      return now - lastChangeAt <= LIVE_STALE_MS ? marker : null
    }

    /** The pending quiet pass, so a burst of changes does not queue one per change. */
    let settleTimer = null
    /** Whether the pass in progress is the quiet one, which is the only pass allowed to fire. */
    let autoSettled = false
    /** Whether the pass in progress was forced by the user, which outranks the history rule. */
    let autoForce = false
    /** Whether the pass in progress is known to be replaying history. */
    let autoHistory = false

    /**
     * Restart the clock that releases a render once the transcript stops moving.
     *
     * Every change pushes the pass back, so the wait runs from the last thing to happen
     * anywhere in the transcript rather than from the first: the render is released a few
     * seconds after the reply finished, not a few seconds after a block happened to be
     * mounted. Growth schedules passes through the observer while it lasts; this is what
     * covers the end of a stream, where the last mutation has already happened and no further
     * one will come.
     *
     * A window that closes while a live marker is still up is a pause and not an ending, so it
     * arms the next window instead of releasing anything: the transcript has not finished
     * being written, however still it happened to be for those seconds.
     *
     * Without `clearTimeout` there is nothing to restart, so the pending pass is left alone —
     * a released render is better than a timer per change in a document that cannot cancel one.
     */
    function armSettleScan() {
      if (settleTimer !== null && typeof clearTimeout !== 'function') return
      if (typeof setTimeout !== 'function') return
      if (settleTimer !== null && typeof clearTimeout === 'function') clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        settleTimer = null
        const blocked = blockingMarker()
        if (blocked !== null) {
          // A pause and not an ending: a live marker is still up, so the next window is armed
          // instead of a render released. The record names the marker, so a run that stayed quiet
          // can be read back as "this is what held it".
          diag('window', { verdict: 'still-writing', marker: blocked })
          armSettleScan()
          return
        }
        diag('window', { verdict: 'quiet', quietMs: SETTLE_QUIET_MS })
        if (typeof rescanBlocks === 'function') rescanBlocks({ settled: true })
      }, SETTLE_QUIET_MS)
    }

    /**
     * Note that the transcript changed, which pushes the release back.
     *
     * Called for every batch the observer sees, replay included, and for text the app rewrites
     * in place: what the clock measures is how long the transcript has held still, and neither a
     * conversation being put back on screen nor a reply growing a character at a time is still.
     * Before this existed, the pass a mid-stream mutation scheduled was enough to fire a block
     * whose own text had long since stopped moving — a render landing while the reply was still
     * being written.
     *
     * The same stamp answers the other question, whether a live marker still means anything: a
     * page that has not moved for `LIVE_STALE_MS` is not being written to, whatever attribute is
     * still sitting on it.
     */
    function noteActivity() {
      if (typeof Date.now === 'function') lastChangeAt = Date.now()
      if (autoRender === true) armSettleScan()
    }

    /**
     * FNV-1a over the prompt text. Stable across renders, unlike an index.
     * @param text - the prompt.
     * @returns a hexadecimal digest.
     */
    function hashOf(text) {
      let hash = 0x811c9dc5
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16)
    }

    /**
     * Decide whether a code block is a NovelAI prompt rather than code.
     *
     * A fence tagged `nai` / `prompt` / `novelai` always qualifies, which gives an
     * explicit opt-in. Otherwise the text has to look like a tag list and not like
     * a program: source-shaped lines disqualify it outright, and a couple of
     * Danbooru signals (or NAI weight syntax) have to be present.
     *
     * @param text - the block's text.
     * @param language - the fence language, if any.
     * @returns true when the button belongs there.
     */
    function looksLikePrompt(text, language) {
      if (/^(nai|novelai|prompt)$/i.test(language ?? '')) return true
      const trimmed = String(text ?? '').trim()
      // A 「文生图」 `<image>` block is always a prompt. Checked before the length
      // bound because a full block with several characters runs long, and its
      // structure is unmistakable however its tags happen to read.
      //
      // The tag has to open a line, matching the host's own test. A prompt that
      // merely mentions `<image>` in passing must not get a button whose click
      // then fails, because the host refuses an unreadable block rather than
      // rendering its labels as picture content.
      if (/^[ \t]*<image\b[^>]*>/im.test(trimmed) || /image\s*#{2,}/i.test(trimmed)) return true
      if (trimmed.length < 24 || trimmed.length > 12000) return false
      if (
        /(^|\n)\s*(import |export |from '|function |const |let |var |class |def |#include|using |<\?php|SELECT |INSERT |UPDATE |CREATE TABLE|npm |pnpm |git |\$ |PS>|curl |\{\s*")/m.test(
          trimmed
        )
      ) {
        return false
      }
      const signals = [
        /\b[12]girls?\b/i,
        /\b[12]boys?\b/i,
        /\bsolo\b/i,
        /\blooking at viewer\b/i,
        /\bmasterpiece\b|\bbest quality\b|\babsurdres\b/i,
        /::/,
        /\bchar[0-9]\s*:/i,
        /\btransparent background\b/i,
        /\bdefault costume\b|\bofficial default outfit\b/i
      ]
      let hits = 0
      for (const pattern of signals) if (pattern.test(trimmed)) hits += 1
      if ((trimmed.match(/,/g) ?? []).length >= 6) hits += 1
      return hits >= 2
    }

    /**
     * Render generated files under a code block.
     * @param slot - the container to fill.
     * @param files - the records the Host returned.
     */
    function showFiles(slot, files) {
      slot.replaceChildren()
      for (const file of files) {
        const name = file.name ?? String(file.file ?? '').split(/[\\/]/).pop()
        if (!name) continue
        const figure = document.createElement('figure')
        figure.style.cssText = 'margin:8px 0 0;display:flex;flex-direction:column;gap:4px'
        const image = document.createElement('img')
        image.src = `${API}/file?name=${encodeURIComponent(name)}`
        image.alt = 'NovelAI generated image'
        image.loading = 'lazy'
        // Tagged so the right-click menu offers copy and save for exactly this.
        markImage(image, { name, path: typeof file.file === 'string' ? file.file : '', kind: 'render' })
        image.style.cssText =
          'max-width:100%;height:auto;border-radius:var(--dsw-radius-md,6px);' +
          'background:repeating-conic-gradient(#e9e9ee 0% 25%, #f7f7fa 0% 50%) 50% / 16px 16px'
        const caption = document.createElement('figcaption')
        caption.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#888)'
        caption.textContent = [
          file.model ?? '',
          file.size ?? '',
          file.seed === null || file.seed === undefined ? '' : `seed ${file.seed}`
        ]
          .filter(Boolean)
          .join(' · ')
        figure.append(image, caption)
        slot.append(figure)
      }
    }

    // ------------------------------------------------------------ the board --
    // A reply can render four pictures under four different blocks, and then the pictures
    // are wherever those blocks happen to be. The board is the reply's own row of them: one
    // place at the end of the answer holding everything this reply rendered, in the order it
    // was rendered, and handing the whole batch to the overlay when one of them is clicked —
    // so a click enlarges and the arrow keys walk the batch instead of jumping into the
    // gallery of every file ever produced.
    //
    // It is drawn from what is already on screen, never from a promise: the board appears
    // when the rendering it stands for has finished, which is exactly what it is for.

    const BOARD_MARK = 'board'
    /** A board thumbnail owns its own click; the sweep must not open the gallery over it. */
    const BOARD_CLICK_ATTR = 'data-nai-imagegen-board-click'
    /** What the board last drew, so a rescan that changed nothing leaves the DOM alone. */
    let boardSignature = ''

    /**
     * Every file the newest reply has rendered, in the order its blocks appear.
     *
     * Read back out of `generated` rather than accumulated into a list of its own: a block
     * that renders again replaces its entry, and the board drawn on top of that list is
     * right by construction instead of right until the two disagree.
     *
     * @returns `[{ name, path }]`.
     */
    function replyBoardFiles() {
      const files = []
      for (const host of latestReplyHosts()) {
        const record = decorated.get(host)
        if (record === undefined) continue
        const rows = generated.get(record.key)
        if (!Array.isArray(rows)) continue
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index]
          const name = row?.name ?? String(row?.file ?? '').split(/[\\/]/).pop()
          if (!name) continue
          // The prompt comes along with the picture: redrawing one of them means sending the
          // same words again, and the board is the only place that still knows them.
          files.push({
            name,
            path: typeof row?.file === 'string' ? row.file : '',
            key: String(record.key ?? ''),
            text: typeof record.text === 'string' ? record.text : '',
            index
          })
        }
      }
      return files
    }

    /**
     * One thumbnail of the board.
     * @param file - `{ name, path }`.
     * @param batch - the whole board as overlay items, so a click switches within it.
     * @param index - this thumbnail's place in that batch.
     * @param t - the bound dictionary.
     */
    function boardThumb(file, batch, index, t) {
      const thumb = document.createElement('img')
      thumb.setAttribute('src', `${API}/file?name=${encodeURIComponent(file.name)}`)
      thumb.setAttribute('alt', file.name)
      thumb.setAttribute('title', `${file.name} · ${t('boardZoom')}`)
      thumb.setAttribute('loading', 'lazy')
      // Tagged so the right-click menu offers copy and save for exactly this, and marked as
      // owning its click so the document-level sweep does not also enlarge it into the
      // gallery a moment after this handler opened the batch.
      markImage(thumb, { name: file.name, path: file.path, kind: 'render' })
      thumb.setAttribute(BOARD_CLICK_ATTR, '1')
      thumb.style.cssText =
        'width:72px;height:72px;object-fit:cover;border-radius:var(--dsw-radius-md,6px);cursor:zoom-in;' +
        'border:1px solid var(--dsw-alias-border-l1,#e2e2e6);' +
        'background:repeating-conic-gradient(#e9e9ee 0% 25%, #f7f7fa 0% 50%) 50% / 16px 16px'
      thumb.addEventListener('click', (event) => {
        event.preventDefault()
        openLightbox(thumb, { items: batch, index, t })
      })
      return thumb
    }

    /** The little redraw under one thumbnail, so a press can be read back by name. */
    const BOARD_REROLL_ATTR = 'data-nai-imagegen-board-reroll'

    /** Redraws in flight, by `key#index`: one press per picture, however fast it is clicked. */
    const rerolling = new Set()

    /**
     * Redraw one picture of the board, keeping the rest.
     *
     * The batch is what a prompt produced, but each picture in it is its own draw: a face that
     * came out wrong is one picture's problem, and pressing the block again costs ten more
     * frames to replace one. This sends the same words with `nSamples: 1`, so the host renders
     * exactly one and the pool is not asked for a batch to throw most of it away.
     *
     * The result takes the slot the old picture had, and is written down where the block's own
     * pictures are kept — so the board, a reload, and a reopened conversation all agree on it.
     *
     * @param file - one row of `replyBoardFiles()`.
     * @param button - the button that was pressed, for its own state.
     * @param t - the bound dictionary.
     * @returns the fresh row, or null when nothing was drawn.
     */
    function rerollBoardFile(file, button, t) {
      const key = String(file?.key ?? '')
      const text = String(file?.text ?? '')
      const at = Math.trunc(Number(file?.index ?? -1))
      if (key === '' || text.trim() === '' || at < 0) return null
      const token = `${key}#${at}`
      if (rerolling.has(token)) return null
      rerolling.add(token)
      const settle = () => {
        rerolling.delete(token)
        button.disabled = false
        button.style.opacity = ''
        button.textContent = '↻'
      }
      button.disabled = true
      button.style.opacity = '0.45'
      button.textContent = '…'
      return api('/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: text.trim(), key, nSamples: 1 })
      })
        .then((body) => {
          const fresh = Array.isArray(body?.files) ? body.files : []
          const row = fresh.find((one) => String(one?.name ?? String(one?.file ?? '')).trim() !== '')
          if (row === undefined) throw new Error('nothing drawn')
          const rows = generated.get(key)
          if (Array.isArray(rows) && at < rows.length) rows[at] = row
          else if (Array.isArray(rows)) rows.push(row)
          rememberFiles(key, Array.isArray(rows) ? rows : [row])
          return row
        })
        .then(
          (row) => {
            settle()
            refreshReplyBoard(t)
            return row
          },
          () => {
            settle()
            return null
          }
        )
    }

    /**
     * One picture of the board: the thumbnail, and the redraw under it.
     *
     * The button is left out when the prompt behind the picture is no longer known — a dead
     * button that redraws nothing would be worse than no button.
     *
     * @param file - one row of `replyBoardFiles()`.
     * @param batch - the whole board as overlay items.
     * @param index - this picture's place in that batch.
     * @param t - the bound dictionary.
     * @returns the cell, 72px wide like the thumbnail it holds.
     */
    function boardCell(file, batch, index, t) {
      const thumb = boardThumb(file, batch, index, t)
      if (String(file?.text ?? '').trim() === '') return thumb
      const cell = document.createElement('div')
      cell.style.cssText = 'flex:none;width:72px;display:flex;flex-direction:column;align-items:stretch'
      const button = document.createElement('button')
      button.setAttribute('type', 'button')
      button.setAttribute(BOARD_REROLL_ATTR, '1')
      button.setAttribute('aria-label', t('boardReroll'))
      button.setAttribute('title', t('boardReroll'))
      button.textContent = '↻'
      button.style.cssText =
        'height:14px;padding:0;margin-top:1px;font:10px/14px system-ui,sans-serif;border:0;' +
        'background:transparent;border-radius:4px;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer'
      button.addEventListener('click', (event) => {
        // A press on the redraw is not a press on the picture behind it.
        event.preventDefault()
        event.stopPropagation()
        // eslint-disable-next-line no-void
        void rerollBoardFile(file, button, t)
      })
      button.addEventListener('pointerdown', (event) => event.stopPropagation())
      cell.append(thumb, button)
      return cell
    }

    /**
     * The board already seated in one reply's container, if that reply has one.
     *
     * Searched for inside the reply rather than across the document: every reply can keep
     * its own board, and a document-wide lookup would find the first one written — an older
     * reply's — and drag it down into the newest answer.
     *
     * @param parent - the reply's container.
     * @returns the board, or null.
     */
    function findBoard(parent) {
      if (parent === null || parent === undefined) return null
      for (const child of parent.children ?? []) {
        if (typeof child?.getAttribute === 'function' && child.getAttribute(STUDIO_MARK) === BOARD_MARK) return child
      }
      return null
    }

    /**
     * Seat the board after the newest reply's last block.
     *
     * Placing it relative to the block rather than the turn tail keeps it inside the answer
     * it belongs to, and a board already seated where it would go is left exactly there —
     * the check is what stops a rescan from moving the same node over and over.
     *
     * @param board - the board element.
     * @param parent - the reply's container.
     * @param last - the reply's last block.
     * @returns whether it has a home.
     */
    function placeBoard(board, parent, last) {
      if (parent === null || parent === undefined || last === null || last === undefined) return false
      if (board.parentElement === parent && board.previousSibling === last) return true
      parent.insertBefore(board, last.nextSibling)
      return true
    }

    /** Which way an arrow pages. Read back by tests, so it is written down as data. */
    const BOARD_ARROW_ATTR = 'data-nai-imagegen-board-arrow'

    /**
     * The two thumbs-sized ways to walk a board that is wider than the answer it sits in.
     *
     * A reply can render ten pictures at once, which is more than the column holds, so the
     * strip clips and these two buttons page it — one whole picture per press at the very
     * least, one screenful when the screen is wide. They live at the board's own ends so the
     * pictures stay in the middle where the eye already is, and they disable at the ends
     * rather than lying about having somewhere to go. When everything fits, both leave.
     *
     * @param strip - the clipping row of thumbnails, already holding them.
     * @param t - the bound dictionary.
     * @returns `{ left, right, sync }` — the arrows, and the call that re-reads the row.
     */
    function boardArrows(strip, t) {
      const measure = () => {
        const width = Number(strip.clientWidth) || 0
        const total = Number(strip.scrollWidth) || 0
        const at = Number(strip.scrollLeft) || 0
        return { width, total, at, room: Math.max(0, total - width) }
      }
      /** One page: whatever fits, rounded down to whole pictures, never less than two. */
      const stepSize = (width) => Math.max(78 * 2, Math.floor(width / 78) * 78)
      const setOff = (button, off) => {
        button.disabled = off === true
        button.style.opacity = off === true ? '0.35' : '1'
        button.style.cursor = off === true ? 'default' : 'pointer'
      }
      const sync = () => {
        const { width, room, at } = measure()
        // Nothing overflows, or nothing is laid out yet: there is no paging to offer.
        const idle = width <= 0 || room <= 1
        left.style.display = idle ? 'none' : ''
        right.style.display = idle ? 'none' : ''
        setOff(left, idle || at <= 1)
        setOff(right, idle || at >= room - 1)
      }
      const page = (direction) => {
        const { width, room, at } = measure()
        const next = Math.min(room, Math.max(0, at + direction * stepSize(width)))
        if (typeof strip.scrollTo === 'function') strip.scrollTo({ left: next, behavior: 'smooth' })
        else strip.scrollLeft = next
        sync()
      }
      const build = (direction) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = direction < 0 ? '‹' : '›'
        const label = t(direction < 0 ? 'boardPrev' : 'boardNext')
        button.setAttribute('title', label)
        button.setAttribute('aria-label', label)
        button.setAttribute(BOARD_ARROW_ATTR, direction < 0 ? '-1' : '1')
        button.style.cssText =
          'flex:none;width:22px;height:22px;padding:0;line-height:19px;font-size:15px;' +
          'border-radius:50%;border:1px solid var(--dsw-alias-border-l1,#e2e2e6);' +
          'background:var(--dsw-alias-bg-l1,#fff);color:var(--dsw-alias-label-secondary,#555);cursor:pointer'
        // The press is the board's own business: stopping here keeps it from also counting as
        // a click on whatever the reply has behind it.
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          page(direction)
        })
        return button
      }
      const left = build(-1)
      const right = build(1)
      if (typeof strip.addEventListener === 'function') strip.addEventListener('scroll', sync)
      return { left, right, sync }
    }

    /**
     * Redraw the newest reply's board from what that reply has rendered so far.
     *
     * Called after every finished render, so the board arrives with the pictures instead of
     * ahead of them, and after a block is re-decorated, so a transcript that was rebuilt
     * gets its board back.
     *
     * @param t - the bound dictionary.
     */
    function refreshReplyBoard(t) {
      if (typeof document?.createElement !== 'function') return
      const hosts = newestReplyHosts()
      const last = hosts[hosts.length - 1]
      const parent = last?.parentElement ?? null
      if (parent === null || parent === undefined) return
      const existing = findBoard(parent)
      const files = replyBoardFiles()
      if (files.length === 0) {
        boardSignature = ''
        if (existing !== null && typeof existing.remove === 'function') existing.remove()
        return
      }
      const signature = files.map((file) => file.name).join('|')
      if (existing !== null && signature === boardSignature) return
      const board = existing ?? document.createElement('div')
      board.setAttribute(STUDIO_MARK, BOARD_MARK)
      board.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:10px'
      const label = document.createElement('span')
      label.style.cssText =
        'flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);margin-right:2px'
      label.textContent = `${t('boardTitle')} ${files.length}${t('boardCount')}`
      const batch = files.map((file) => ({ url: `${API}/file?name=${encodeURIComponent(file.name)}`, name: file.name }))
      // The row clips instead of wrapping, so ten pictures stay one line tall and the arrows
      // are what moves them; wrapping them would make the answer jump in height every render.
      const strip = document.createElement('div')
      strip.style.cssText =
        'display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow:hidden;' +
        'border-radius:var(--dsw-radius-md,6px)'
      strip.append(...files.map((file, index) => boardCell(file, batch, index, t)))
      const arrows = boardArrows(strip, t)
      board.replaceChildren(label, arrows.left, strip, arrows.right)
      boardSignature = signature
      placeBoard(board, parent, last)
      // Read the row only once it is in the document: before that it has no width, and an
      // arrow that decides it has nowhere to go on a zero-width reading would stay hidden.
      arrows.sync()
    }

    // ------------------------------------------------------ what survives --
    // The pictures a prompt rendered are files on disk, so a reply's pictures and its board can
    // be drawn again after a reload — provided something still knows which prompt produced
    // which file. The host keeps an index of exactly that; this is the half that does not need
    // the host at all: a small map in the browser's own storage, written whenever a render
    // finishes and read before the host is asked. A restart redraws with no round trip, and a
    // conversation that is switched away from and back comes back whole.
    const RENDER_STORE = 'nai-imagegen:renders'
    /** Prompts remembered: a long conversation's worth, and far inside any storage quota. */
    const RENDER_STORE_MAX = 240
    /** The store as it was read, so one page parses it once and every write keeps the rest. */
    let renderStore = null

    /**
     * The browser's key-value store, or null where there is none.
     *
     * Reading `localStorage` itself can throw where storage is denied, and a missing store is a
     * page without one — not a broken plugin, and never a reason to stop rendering.
     * @returns a `localStorage`-shaped object, or null.
     */
    function renderStorage() {
      try {
        // Either holder can be the one with a store: a page has `window`, and a harness that
        // stands one up without storage still has `localStorage` on the global. Ask both rather
        // than let an empty `window` decide the feature is unavailable.
        const holders = [typeof window === 'object' && window !== null ? window : null, globalThis]
        for (const holder of holders) {
          const store = holder?.localStorage
          if (store === null || store === undefined) continue
          if (typeof store.getItem !== 'function' || typeof store.setItem !== 'function') continue
          return store
        }
        return null
      } catch {
        return null
      }
    }

    /**
     * One row as the store keeps it: the file, and the caption that goes under it.
     * @param row - a row as `/generate` or `/rendered` returned it.
     * @returns `{ file, name, model, size, seed }`, or null when there is no file to point at.
     */
    function storedRow(row) {
      const name = String(row?.name ?? String(row?.file ?? '').split(/[\\/]/).pop() ?? '')
      if (name === '') return null
      return {
        file: typeof row?.file === 'string' ? row.file : '',
        name,
        model: row?.model ?? null,
        size: row?.size ?? null,
        seed: row?.seed === undefined ? null : row.seed
      }
    }

    /**
     * Everything this page has remembered, parsed once.
     * @returns a `Map` of prompt digest to rows.
     */
    function readRenderStore() {
      if (renderStore !== null) return renderStore
      renderStore = new Map()
      const store = renderStorage()
      if (store === null) return renderStore
      try {
        const raw = store.getItem(RENDER_STORE)
        const parsed = raw === null || raw === undefined ? null : JSON.parse(raw)
        for (const entry of Array.isArray(parsed) ? parsed : []) {
          // Written as pairs so the order of writing survives a round trip — that order is what
          // trims the oldest prompt when the map is full.
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue
          const rows = (Array.isArray(entry[1]) ? entry[1] : []).map(storedRow).filter(Boolean)
          if (rows.length > 0) renderStore.set(entry[0], rows)
        }
      } catch {
        // A store another version wrote, or one that was truncated: start over rather than
        // fail every render behind it.
        renderStore = new Map()
      }
      return renderStore
    }

    /**
     * Write the store back, oldest prompt first out.
     *
     * A quota that is already full leaves the previous contents in place: the host index still
     * answers, and a page that lost its memory is exactly what this store exists to prevent.
     */
    function writeRenderStore() {
      const store = renderStorage()
      if (store === null) return
      const map = readRenderStore()
      while (map.size > RENDER_STORE_MAX) map.delete(map.keys().next().value)
      try {
        store.setItem(RENDER_STORE, JSON.stringify([...map.entries()]))
      } catch {
        // Quota, or a store that refuses writes. The pictures are still on disk.
      }
    }

    /**
     * Remember what a prompt produced, so this reply survives the next reload.
     * @param key - the prompt's digest.
     * @param rows - what `/generate` or `/rendered` returned.
     */
    function rememberFiles(key, rows) {
      if (typeof key !== 'string' || key === '') return
      const kept = (Array.isArray(rows) ? rows : []).map(storedRow).filter(Boolean)
      if (kept.length === 0) return
      const map = readRenderStore()
      // Deleted first so a re-render moves to the newest end instead of staying at its old age.
      map.delete(key)
      map.set(key, kept)
      writeRenderStore()
    }

    /**
     * What this prompt produced before, or null if this page has never seen it.
     * @param key - the prompt's digest.
     * @returns rows, or null.
     */
    function recallFiles(key) {
      if (typeof key !== 'string') return null
      const rows = readRenderStore().get(key)
      return rows === undefined ? null : rows
    }

    /** Forget the parsed copy so the next read goes back to storage — a reload, in a test. */
    function resetRenderStore() {
      renderStore = null
    }

    /**
     * Blocks waiting for a stored render, keyed by prompt digest.
     *
     * Opening a conversation rebuilds its transcript, so the pictures a reply rendered are gone
     * from the document while the files they point at are still on disk. The host keeps a small
     * index of what each prompt produced; this map is the client side of asking for it.
     */
    const restoreTargets = new Map()
    /**
     * What each waiting digest was read from.
     *
     * The digest is this page's own, and a render made before the index existed — or in another
     * browser — was recorded under one the host computed from the request instead. Those two
     * never match, so the words of the block go along with the digest and the host falls back to
     * them: a stored prompt that contains this text is the picture this block is standing over.
     */
    const restoreTexts = new Map()
    /** Digests already asked about, so a rebuilt transcript asks once. */
    const restoreAsked = new Set()
    /** The batch that is waiting for company, or null. */
    let restorePending = null
    /** How long one batch waits for the rest of the reply to finish decorating. */
    const RESTORE_BATCH_MS = 80

    /**
     * Ask the host which files a prompt produced before, then fill in every block waiting on it.
     *
     * One request per reply rather than one per block, so a reply with four prompts costs four
     * lines of JSON instead of four round trips.
     *
     * @param key - the prompt's hash.
     * @param target - `{ host, slot, status }` for the block that wants its pictures back.
     * @param t - the bound dictionary.
     */
    function queueRestore(key, target, t) {
      if (restoreAsked.has(key)) {
        // Answered (or asked) already: the cached branch above shows the pictures, and a block
        // that comes back without them was not in the index to begin with.
        return
      }
      const waiting = restoreTargets.get(key) ?? []
      waiting.push({ ...target, t })
      restoreTargets.set(key, waiting)
      if (restorePending !== null) return

      const run = () => {
        restorePending = null
        const keys = [...restoreTargets.keys()]
        if (keys.length === 0) return
        for (const one of keys) restoreAsked.add(one)
        if (restoreAsked.size > 2000) restoreAsked.clear()
        // Digests the host computed itself will never equal this page's, so the text rides along:
        // what a digest cannot say, the words can.
        const texts = {}
        for (const one of keys) {
          const text = restoreTexts.get(one)
          if (typeof text === 'string' && text !== '') texts[one] = text
        }
        api('/rendered', { method: 'POST', body: JSON.stringify({ keys, texts }) })
          .then((body) => {
            const renders = body?.renders ?? {}
            for (const one of keys) {
              const rows = renders[one]
              const waiting = restoreTargets.get(one) ?? []
              // The answer is final either way: the host either has files for this prompt or it
              // does not, and a block that comes back empty is free to be rendered again.
              for (const target of waiting) {
                if (!Array.isArray(rows) || rows.length === 0) continue
                generated.set(one, rows)
                rememberFiles(one, rows)
                // Recorded as an answered block, so the quiet pass does not spend a request
                // rendering what the user is already looking at.
                historyBlocks.add(target.host)
                firedBlocks.add(target.host)
                if (typeof target.slot?.replaceChildren === 'function' && target.slot.isConnected !== false) {
                  showFiles(target.slot, rows)
                  if (target.status !== undefined && target.status !== null) {
                    target.status.textContent = target.t('blockRestored')
                  }
                }
                refreshReplyBoard(target.t)
              }
            }
            restoreTargets.clear()
            restoreTexts.clear()
          })
          .catch(() => {
            // A host that cannot answer is not an error the user needs: the block keeps its
            // button and renders on demand, exactly as it did before this index existed. The
            // digests go back to unasked, though, so a host that comes up later in this page's
            // life is asked again instead of being written off for good.
            for (const one of keys) restoreAsked.delete(one)
            restoreTargets.clear()
            restoreTexts.clear()
          })
      }
      if (typeof setTimeout === 'function') restorePending = setTimeout(run, RESTORE_BATCH_MS)
      else {
        restorePending = true
        run()
      }
    }

    /** What was injected per host, so a later pass can fire an existing button. */
    const decorated = new WeakMap()

    /**
     * The clock, when there is one. A DOM without `Date.now` still renders; it just cannot
     * tell how long ago a render started, and then nothing is refused for being recent.
     */
    function clockNow() {
      return typeof Date.now === 'function' ? Date.now() : 0
    }

    /**
     * Whether this prompt was auto-rendered moments ago, and its render may still be in flight.
     * @param key - the prompt's hash.
     */
    function justFired(key) {
      const at = autoDone.get(key)
      if (at === undefined || at === 0) return false
      const current = clockNow()
      if (current === 0) return false
      return current - at <= AUTO_FIRE_TTL_MS
    }

    /**
     * Fire an auto-render for one block, if the toggle and the budget allow.
     *
     * Both the fresh-decorate path and the re-visited path go through here, so
     * the bounds are stated once instead of being duplicated. What stopped a call
     * is left in `lastFireReason`, which is what the quiet pass reports.
     *
     * @param button - the block's button.
     * @param key - the prompt's hash.
     * @param host - the block's host element.
     * @returns true when a render was started.
     */
    function autoFire(button, key, host) {
      if (!autoRender) return false
      let why = null
      // History is not a reply. The transcript that switching into a conversation replays
      // must not fire its blocks again — the pictures are already in it, and rendering them
      // once more spends quota to duplicate what the user already has. Only a block that
      // arrives with a live reply fires; the toggle-on pass is the user asking directly, and
      // is exempt.
      if (autoForce !== true) {
        if (autoHistory === true) {
          markHistory(host)
          why = 'history-pass'
        } else if (autoSettled !== true) {
          // Only the pass that runs once the transcript has gone quiet may fire. The passes the
          // observer schedules arrive while the reply is still being written, and a prompt block
          // is usually finished long before the reply is, so firing from one of those renders a
          // prompt the user has not finished reading, in the middle of the stream.
          why = 'not-quiet'
        } else if (host !== undefined && host !== null && historyBlocks.has(host)) {
          // Stamped by a batch that replaced the transcript: this block came back with a
          // conversation that already stood, so its pictures are already above it.
          why = 'stamped'
        } else if (
          settleHosts !== null &&
          (host === undefined || host === null || settleHosts.has(host) !== true)
        ) {
          // One reply is answered: the one in front of the user. A block above the newest reply's
          // own turn tail belongs to an older reply, and that reply's pictures are already on
          // screen. This boundary used to be drawn by the prompt's *text* instead, against a set
          // holding every prompt the page had ever shown — so a prompt the user asked for a
          // second time, in a brand-new reply, matched a mark left by an old one and was never
          // rendered at all. Position cannot make that mistake.
          why = 'older-reply'
        } else if (host !== undefined && host !== null && firedBlocks.has(host)) {
          // This very block has been answered already: its text grew back under a button that
          // has just been pressed, and a second press would queue a second render of it.
          why = 'already-fired'
        }
      }
      if (why === null && justFired(key)) why = 'in-flight'
      if (why === null && autoAllowance <= 0) why = 'allowance'
      if (why === null && typeof button.click !== 'function') why = 'no-button'
      lastFireReason = why ?? 'fired'
      if (why !== null) return false
      autoAllowance -= 1
      autoDone.set(key, clockNow())
      if (host !== undefined && host !== null) firedBlocks.add(host)
      button.click()
      return true
    }

    /**
     * Whether one batch of DOM changes is a replayed conversation rather than a live reply.
     *
     * This is what makes the auto-render toggle safe to leave on. Switching into a
     * conversation tears the old transcript down and drops the whole of the new one in at
     * once — hundreds of nodes leave in a single batch. A reply appends and rewrites; it does
     * not tear the transcript down, so it never removes that many.
     *
     * A second signal used to stand here: three or more blocks arriving in one batch. A reply
     * carrying three prompts is not a replayed conversation, and the mark that judgement left
     * cost the user every picture in that reply, so it is gone.
     *
     * @param records - the `MutationRecord`s of one observer callback.
     * @returns true when the batch looks like a replay.
     */
    function looksLikeReplay(records) {
      let removed = 0
      for (const record of records ?? []) removed += (record?.removedNodes ?? []).length
      return removed >= REPLAY_REMOVALS
    }

    /**
     * Stamp the blocks one replayed batch brought with it.
     *
     * Only the batch's own additions are marked, never everything on screen. Marking the
     * document is what made a live reply's block — the one that arrives in the same commit as
     * a transcript re-render, which is every reply once a conversation gets long — count as
     * history, and the mark outlives the batch it came from.
     * @param records - the `MutationRecord`s of one observer callback.
     */
    function stampHistory(records) {
      for (const record of records ?? []) {
        for (const node of record?.addedNodes ?? []) {
          if (String(node?.tagName ?? '').toUpperCase() === 'PRE') markHistory(node)
          else if (typeof node?.querySelectorAll === 'function') {
            for (const pre of node.querySelectorAll('pre')) markHistory(pre)
          }
        }
      }
    }

    /**
     * Remember one block as part of a conversation that already stood.
     *
     * The mark lands on the element. It used to land on the prompt's text as well, so that a
     * re-mounted copy of an old block would be skipped — but a set of texts has no memory of
     * where a prompt was, and every prompt the page had ever shown stayed in it for the rest of
     * the session: asking for the same prompt again, in a new reply, matched a mark left by an
     * old one and rendered nothing. A block is history because of *where* it is, and the quiet
     * pass now asks the position instead.
     *
     * @param pre - the block's `<pre>`, or a host the caller already unwrapped.
     */
    function markHistory(pre) {
      if (pre === null || pre === undefined) return
      const host = String(pre.tagName ?? '').toUpperCase() === 'PRE' ? pre.parentElement ?? pre : pre
      historyBlocks.add(host)
    }

    // ------------------------------------------------------------ image menu --
    // Right-click on a generated image offers the three things anyone actually
    // wants from one: the pixels on the clipboard, the path, or a save dialog.
    //
    // Only this plugin's own images are claimed. A document-wide `contextmenu`
    // listener that swallowed every `<img>` in the app would be indefensible, so
    // each image this half creates carries a marker and anything without it is
    // left alone.

    /** Marks an image as one of ours, so the menu only claims its own. */
    const IMG_ATTR = 'data-nai-imagegen-image'
    /** Marks an image a click will enlarge — any content image, not only ours. */
    const ZOOMABLE_ATTR = 'data-nai-imagegen-zoomable'
    /**
     * Marks an image that was already re-pointed after a failed load.
     *
     * The retry points `src` at this plugin's own route. If that fails too the image has
     * to stay failed, so this mark is what stops a retry from looping.
     */
    const REPAIR_ATTR = 'data-nai-imagegen-repaired'
    /**
     * Below this, an image is chrome rather than content.
     *
     * The zoom rule sets `width: 100%`, which is right for a page and catastrophic for
     * an icon in a toolbar. An icon or an avatar is a few dozen pixels; a picture
     * somebody means to look at is not.
     */
    const ZOOM_MIN_PIXELS = 96
    /** Scales offered for how large a generated image is drawn, in percent. */
    const DISPLAY_SCALES = [100, 90, 80, 70, 60, 50, 40, 33, 25]
    /** The floating menu, when open. */
    let imageMenu = null

    /**
     * Whether an `<img>` in the transcript is a render rather than part of the UI.
     *
     * **By identity, never by size.** Size was the first test here — a 256-pixel side is
     * never an avatar — but the host also rewrites a render's `src` to an opaque
     * `/attachments/v1/objects/…` address, so size was the only thing left to go on, and it
     * claimed every other plugin's pictures too: the display scale shrank them and a click
     * on them opened this plugin's overlay. What identifies one of ours instead is the mark
     * this half (or the right-click menu) put on it, the file name its address still names,
     * or the alt text these embeds use.
     * @param image - the `<img>` element.
     * @returns true when it is one of ours.
     */
    function isOurOutput(image) {
      // Identity, not size.
      //
      // "Big enough to be a render" was the loose test that made this half claim every
      // picture in the app, another plugin's renders included — and the display scale and
      // the enlargement both follow the claim, so an image that was never ours got resized
      // and had its clicks taken. What identifies one of ours is the mark it already
      // carries (this half put it there, or the menu adopted it), the name in its address,
      // or the alt text this plugin's own embeds use.
      if (image?.getAttribute?.(IMG_ATTR) === '1') return true
      const src = String(image?.getAttribute?.('src') ?? image?.src ?? '')
      const alt = String(image?.getAttribute?.('alt') ?? '')
      return /_out[\\/]nai[\\/]|[\\/]nai-imagegen[\\/]/i.test(src) || alt === GENERATED_ALT
    }

    /** How many transcript images the last claim pass identified. */
    let claimedImages = 0

    /**
     * Mark every transcript image that is a render, up front.
     *
     * The right-click menu claims an image only while the pointer is on it, so
     * `img[${IMG_ATTR}="1"]` stayed an empty set until someone right-clicked each image
     * — and because the host rewrites `src` to an opaque `/attachments/v1/objects/…`
     * address, the path selector matched nothing either. Both selectors the display
     * scale and click-to-enlarge were built on therefore matched nothing at all, which
     * is exactly why changing the scale "did nothing".
     *
     * An image whose bitmap has not decoded yet has no `naturalWidth`, so it is left
     * for a later pass rather than written off.
     * @returns how many transcript images carry the mark.
     */
    function claimRenderImages() {
      if (typeof document?.querySelectorAll !== 'function') return claimedImages
      let claimed = 0
      for (const image of document.querySelectorAll('img')) {
        // The control surfaces are not the transcript. Their thumbnails really are
        // full-size reference images, so the intrinsic-size test below would claim them
        // and the display scale would then stretch the artist grid — a control panel has
        // to keep looking exactly as it did before the scale existed.
        if (typeof image.closest === 'function' && image.closest(`[${STUDIO_MARK}]`) !== null) {
          image.removeAttribute?.(IMG_ATTR)
          continue
        }
        if (image.getAttribute?.(IMG_ATTR) === '1') {
          claimed += 1
          continue
        }
        if (!isOurOutput(image)) continue
        markImage(image, { kind: 'transcript', name: nameFromSrc(image) })
        claimed += 1
      }
      claimedImages = claimed
      return claimed
    }

    /** How many images a click would enlarge. */
    let zoomableImages = 0

    /**
     * Whether a click on this `<img>` should enlarge it.
     *
     * This plugin's own pictures only. It used to be every content image, which is how a
     * click on another plugin's render ended up opening this plugin's overlay instead of
     * doing whatever that plugin wanted. Chrome is what also has to stay out of it: an
     * avatar, a chevron, the icon inside a button — an overlay on one of those is worse
     * than useless.
     * @param image - the `<img>` element.
     * @returns true when a click should enlarge it.
     */
    function isZoomableImage(image) {
      if (image === null || image === undefined) return false
      if (typeof image.closest === 'function') {
        // This plugin's own window is a control surface, not content.
        if (image.closest(`[${STUDIO_MARK}]`) !== null) return false
        const control = 'button, [role="button"], [role="menuitem"], [role="tab"], summary, label'
        if (image.closest(control) !== null) return false
        // A link is only a control when it opens somewhere else. A plain one wraps a
        // picture the reader meant to look at, and enlarging it is this click's job — the
        // handler cancels the navigation for exactly that case.
        const anchor = image.closest('a[href]')
        if (anchor !== null && String(anchor.target ?? '') === '_blank') return false
      }
      // Another plugin's picture is that plugin's to handle. Its own viewer, its own menu,
      // its own click — an overlay that swallows it is exactly what must not happen.
      if (!isOurOutput(image)) return false
      // Intrinsic size first; the laid-out size is the fallback for an image whose
      // bitmap has not decoded yet, and a box is better than nothing.
      const rect = typeof image.getBoundingClientRect === 'function' ? image.getBoundingClientRect() : null
      const width = Number(image.naturalWidth ?? 0) || Number(image.width ?? 0) || Number(rect?.width ?? 0)
      const height = Number(image.naturalHeight ?? 0) || Number(image.height ?? 0) || Number(rect?.height ?? 0)
      // Nothing to judge yet. A later pass decides, rather than guessing now.
      if (width === 0 && height === 0) return false
      return Math.max(width, height) >= ZOOM_MIN_PIXELS
    }

    /**
     * Mark every content image a click can enlarge.
     * @returns how many images carry the mark.
     */
    function markZoomables() {
      if (typeof document?.querySelectorAll !== 'function') return zoomableImages
      let count = 0
      for (const image of document.querySelectorAll('img')) {
        if (isZoomableImage(image)) {
          image.setAttribute?.(ZOOMABLE_ATTR, '1')
          count += 1
          continue
        }
        // It moved inside a control, or the zoom rule already shrank it. Stop
        // advertising a click it no longer has.
        if (image.getAttribute?.(ZOOMABLE_ATTR) === '1') image.removeAttribute?.(ZOOMABLE_ATTR)
      }
      zoomableImages = count
      return count
    }

    /**
     * One pass over every image: claim the renders, mark what a click enlarges.
     * @returns `{ claimed, zoomable }`.
     */
    function sweepImages() {
      return { claimed: claimRenderImages(), zoomable: markZoomables() }
    }

    /** The file name an `<img>` is serving, when its address carries one. */
    function nameFromSrc(image) {
      const src = String(image?.getAttribute?.('src') ?? image?.src ?? '')
      // This plugin's own route puts the name in the query, not in the path:
      // `/nai-imagegen/api/file?name=x.png`. Reading only the path found `file` and gave up.
      const fromQuery = /[?&]name=([^&#]+)/.exec(src)
      const candidate = fromQuery === null ? (src.split(/[?#]/)[0].split(/[\\/]/).pop() ?? '') : fromQuery[1]
      let name = candidate
      try {
        name = decodeURIComponent(candidate)
      } catch {
        // A malformed escape keeps the raw text, which is still a better answer than none.
      }
      return /\.(png|jpe?g|webp)$/i.test(name) ? name : ''
    }

    /**
     * Re-point a transcript image that failed to load at this plugin's own route.
     *
     * A render is embedded as a local path, and the browser half draws a Markdown image
     * by resolving that path through a vocabulary it rebuilds on every mount — so a
     * picture could be there when it was rendered and gone after the conversation was
     * switched away from and back. The bytes are still on disk, and this plugin serves
     * them itself, by name and without credentials, so a failed image is re-pointed.
     *
     * Only an image whose address names this plugin's own output directory is touched:
     * any other broken image is not this plugin's business.
     * @param image - the `<img>` that failed.
     * @returns true when it was re-pointed.
     */
    function repairBrokenImage(image) {
      if (image === null || image === undefined) return false
      if (typeof image.setAttribute !== 'function' || typeof image.getAttribute !== 'function') return false
      if (image.getAttribute(REPAIR_ATTR) === '1') return false
      const name = nameFromSrc(image)
      if (name === '') return false
      // The address arrives percent-encoded in the `path=` form and plain in the
      // local-path form, so the decision is made on a decoded copy of it.
      let address = String(image.getAttribute('src') ?? image.src ?? '')
      try {
        address = decodeURIComponent(address)
      } catch {
        // A malformed escape keeps the raw text, which is still worth looking at.
      }
      const needle = String(imageMatch || '_out/nai/').replace(/\\/g, '/').toLowerCase()
      const flat = address.replace(/\\/g, '/').toLowerCase()
      // Either the local path a render was embedded as, or this plugin's own route — which
      // is what an already-repaired address looks like, and what the host half now hands out
      // directly. Both are ours; nothing else is touched.
      if (!flat.includes(needle) && !flat.includes(`${API}/file`)) return false
      image.setAttribute(REPAIR_ATTR, '1')
      image.setAttribute('src', `${API}/file?name=${encodeURIComponent(name)}`)
      return true
    }

    /**
     * Retry every image that has already finished failing.
     *
     * The `error` event covers an image that fails while this half is listening; one that
     * failed before that, or was already in the page, is caught here — the sweep is the
     * single place that looks at every image on a schedule.
     * @returns how many were re-pointed.
     */
    function sweepBrokenImages() {
      if (typeof document?.querySelectorAll !== 'function') return 0
      let repaired = 0
      for (const image of document.querySelectorAll('img')) {
        // `complete` with no intrinsic size is a finished failure; anything else is still
        // loading, or a stub node that cannot say, and is left alone.
        if (image.complete !== true || Number(image.naturalWidth ?? 0) > 0) continue
        if (repairBrokenImage(image)) repaired += 1
      }
      return repaired
    }

    /**
     * Tag an image so the right-click menu claims it.
     * @param image - the `<img>` element.
     * @param info - `{ name, path, kind }`.
     * @returns the same element, for chaining.
     */
    function markImage(image, info = {}) {
      image.setAttribute(IMG_ATTR, '1')
      if (typeof info.name === 'string' && info.name !== '') image.setAttribute('data-nai-name', info.name)
      if (typeof info.path === 'string' && info.path !== '') image.setAttribute('data-nai-path', info.path)
      if (typeof info.kind === 'string' && info.kind !== '') image.setAttribute('data-nai-kind', info.kind)
      return image
    }

    /** Close the floating menu, if one is open. */
    function closeImageMenu() {
      if (imageMenu !== null) {
        imageMenu.remove()
        imageMenu = null
      }
    }

    /**
     * Re-encode an image as PNG, which is the only format the clipboard accepts.
     * @param blob - the source blob.
     * @returns a PNG blob.
     */
    async function toPng(blob) {
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      if (typeof bitmap.close === 'function') bitmap.close()
      return await new Promise((resolve, reject) => {
        canvas.toBlob((out) => (out === null ? reject(new Error('转成 PNG 失败')) : resolve(out)), 'image/png')
      })
    }

    /**
     * Put an image on the clipboard.
     * @param image - the `<img>` element.
     */
    async function copyImageToClipboard(image) {
      if (navigator.clipboard === undefined || typeof ClipboardItem === 'undefined') {
        throw new Error('这个环境不支持把图片写进剪贴板')
      }
      const response = await fetch(image.src)
      if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`)
      const blob = await response.blob()
      // Generated files are already PNG, so the canvas round trip is only for
      // anything else that ends up here.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob.type === 'image/png' ? blob : await toPng(blob) })])
    }

    /**
     * Put text on the clipboard.
     * @param value - the text.
     */
    async function copyTextToClipboard(value) {
      if (navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('这个环境不支持写剪贴板')
      }
      await navigator.clipboard.writeText(value)
    }

    /**
     * Open the menu for one image at a point.
     * @param image - the `<img>` element.
     * @param x - viewport x.
     * @param y - viewport y.
     * @param t - the bound dictionary.
     */
    function openImageMenu(image, x, y, t) {
      closeImageMenu()
      const name = image.getAttribute('data-nai-name') ?? ''
      const path = image.getAttribute('data-nai-path') ?? ''
      const status = document.createElement('div')
      status.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#888);padding:2px 8px;min-height:14px'

      /** Run one action, reporting failure in the menu rather than nowhere. */
      const run = async (label, action) => {
        status.textContent = `${label}…`
        try {
          await action()
          status.textContent = `${label} ✓`
          setTimeout(closeImageMenu, 700)
        } catch (error) {
          status.textContent = `${label} 失败：${error.message}`
        }
      }

      const item = (label, action) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.textContent = label
        row.style.cssText =
          'display:block;width:100%;text-align:left;padding:6px 10px;font-size:12px;cursor:pointer;' +
          'border:0;background:transparent;color:inherit;border-radius:var(--dsw-radius-sm,4px)'
        row.addEventListener('mouseenter', () => {
          row.style.background = 'var(--dsw-alias-fill-l1,rgba(127,127,127,0.12))'
        })
        row.addEventListener('mouseleave', () => {
          row.style.background = 'transparent'
        })
        row.addEventListener('click', (event) => {
          event.stopPropagation()
          run(label, action)
        })
        return row
      }

      const menu = document.createElement('div')
      menu.setAttribute(IMG_ATTR, '1')
      menu.style.cssText =
        'position:fixed;z-index:2147483000;min-width:172px;padding:4px;' +
        'border-radius:var(--dsw-radius-md,6px);border:1px solid var(--dsw-alias-border-l1,#d0d0d5);' +
        'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,inherit);' +
        'box-shadow:0 6px 24px rgba(0,0,0,0.18);font-size:12px'
      menu.append(
        item(t('copyImage'), () => copyImageToClipboard(image)),
        ...(name === '' ? [] : [item(t('copyName'), () => copyTextToClipboard(name))]),
        ...(path === '' ? [] : [item(t('copyPath'), () => copyTextToClipboard(path))]),
        ...(name === ''
          ? []
          : [
              item(t('saveAs'), () => {
                const anchor = document.createElement('a')
                anchor.href = image.src
                anchor.download = name
                document.body.append(anchor)
                anchor.click()
                anchor.remove()
              })
            ]),
        status
      )
      document.body.append(menu)
      // Keep the menu on screen when the click lands near an edge.
      const box = menu.getBoundingClientRect()
      menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`
      menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`
      imageMenu = menu
    }

    /**
     * Watch for right-clicks on this plugin's images.
     * @param t - the bound dictionary.
     * @returns a disposer.
     */
    function installImageMenu(t) {
      if (typeof document === 'undefined') return () => {}
      const onContextMenu = (event) => {
        const target = event.target
        if (target === null || typeof target.closest !== 'function') return
        let image = target.closest(`img[${IMG_ATTR}]`)
        if (image === null) {
          // An image the transcript rendered from `![描述](路径)` — which is how every
          // render is delivered — was never seen by this half, so nothing marked it
          // and a right-click on it did nothing. Adopting it here is what makes
          // "the generated image can be copied" true for the image actually being
          // right-clicked, rather than only for the gallery's copies.
          const candidate = target.closest('img')
          // Not inside a control surface: the sidebar's thumbnails are full-size
          // references, and adopting one would let the display scale resize the grid.
          const inStudio =
            candidate !== null &&
            typeof candidate.closest === 'function' &&
            candidate.closest(`[${STUDIO_MARK}]`) !== null
          // One control surface is also content: the enlargement is where the picture is shown
          // at full size, and that is precisely when someone wants the pixels on the clipboard
          // rather than a 64-pixel thumbnail of them. The guard above keeps this plugin off the
          // panel's own chrome; its own viewer is not chrome.
          const inLightbox =
            candidate !== null &&
            typeof candidate.closest === 'function' &&
            candidate.closest(`[${STUDIO_MARK}="lightbox"]`) !== null
          if (candidate !== null && (!inStudio || inLightbox) && isOurOutput(candidate)) {
            // The name travels too, so 「复制文件名」 and 「另存为」 still mean
            // something for an image this half did not build.
            markImage(candidate, { kind: 'transcript', name: nameFromSrc(candidate) })
            image = candidate
          }
        }
        if (image === null) return
        event.preventDefault()
        event.stopPropagation()
        openImageMenu(image, event.clientX, event.clientY, t)
      }
      const onDismiss = () => closeImageMenu()
      const onKey = (event) => {
        if (event.key === 'Escape') closeImageMenu()
      }
      document.addEventListener('contextmenu', onContextMenu, true)
      document.addEventListener('click', onDismiss, true)
      document.addEventListener('scroll', onDismiss, true)
      document.addEventListener('keydown', onKey, true)
      return () => {
        closeImageMenu()
        document.removeEventListener('contextmenu', onContextMenu, true)
        document.removeEventListener('click', onDismiss, true)
        document.removeEventListener('scroll', onDismiss, true)
        document.removeEventListener('keydown', onKey, true)
      }
    }

    /**
     * Read one code block the way the scanner reads it.
     *
     * Kept in one place because two callers need the same reading: `decorate`, to decide whether
     * the block deserves a button, and the pass that has to find the newest prompt on screen
     * before it walks anything at all.
     *
     * @param pre - the `<pre>` element.
     * @returns the prompt text, and the fence language when one is tagged.
     */
    function readBlock(pre) {
      const code = pre.querySelector('code') ?? pre
      const text = String(code.textContent ?? '')
      const language = (/language-([\w-]+)/.exec(code.className ?? '') ?? [])[1]
      return { text, language }
    }

    /**
     * Read a decoration this half built back off the DOM.
     *
     * The map from host to decoration is the fast path, and it is not the only truth: the nodes
     * are in the transcript and they carry the mark that says so. Anything that loses the map
     * (a rebuilt transcript, a second activation, an element moved under a new parent) leaves
     * exactly this situation — a button the user can see and a map that has never heard of it.
     *
     * @param host - the block's host element.
     * @returns `{ button, injected }` when one of our buttons is under it, or null.
     */
    function adoptableDecoration(host) {
      if (host === null || host === undefined || typeof host.querySelector !== 'function') return null
      const button = host.querySelector(`button[${FIRE_ATTR}]`)
      if (button === null) return null
      const bar = button.parentElement
      const slot =
        typeof host.querySelector === 'function'
          ? Array.from(host.children ?? []).find(
              (node) => node !== bar && node.getAttribute?.(OURS_ATTR) === '1'
            ) ?? null
          : null
      const injected = [bar, slot].filter((node) => node !== null && node !== undefined)
      return { button, injected }
    }

    /**
     * Add the button and result slot to one code block, if it qualifies.
     * @param pre - the `<pre>` element.
     * @param t - the bound dictionary.
     */
    function decorate(pre, t) {
      if (pre.closest(`[${OURS_ATTR}]`) !== null) return
      const { text, language } = readBlock(pre)
      if (!looksLikePrompt(text, language)) return
      const host = pre.parentElement ?? pre
      const key = hashOf(text.trim())

      // A block that already carries a button still has to be reconsidered, for two
      // separate reasons:
      //
      //   * the toggle may have just been turned on, and the button already sitting
      //     there is the one that should fire;
      //   * **the text may have grown since.** The transcript mounts a `<pre>` and
      //     fills it afterwards, and a streaming reply grows one a few characters at
      //     a time. A block decorated while it was still arriving keeps its
      //     truncated text forever, so clicking it renders — or fails on — a
      //     fragment. Re-decorating a block whose body changed is what fixes that.
      const previous = decorated.get(host)
      if (previous !== undefined) {
        if (previous.text === text) {
          autoFire(previous.button, previous.key, host)
          return
        }
        // The text moved under a block that was already on screen. That is a reply being
        // written — a stored conversation arrives whole — so a block reads as live again the
        // moment it grows, whatever it was stamped as when it first appeared.
        if (autoRender === true) {
          // Both marks, or a block that grew into a different prompt would still be holding the
          // element it used to be: the stamp says "already answered" and the fire mark says
          // "already pressed", and this block is neither any more — it is a prompt that nobody
          // has rendered yet.
          historyBlocks.delete(host)
          firedBlocks.delete(host)
        }
        // While the toggle is off nothing is a reply to it, growth included: the block is
        // stamped again under the text it carries now, so turning the toggle on later answers
        // the reply in front of the user and not this one.
        else markHistory(pre)
        for (const node of previous.injected) {
          if (node !== null && typeof node.remove === 'function') node.remove()
        }
        decorated.delete(host)
      } else if (host.getAttribute(DONE_ATTR) === '1') {
        // Marked, but nothing recorded. The mark outlives the record: a transcript rebuilt
        // around this block, an element moved to a new parent, a second activation of this
        // bundle — each leaves a button on screen that the map no longer answers for. Returning
        // here is what made 「重新生图」 report that the reply has no prompt while the prompt's
        // button was sitting right there in it. Adopt the button that exists instead.
        const adopted = adoptableDecoration(host)
        if (adopted !== null) {
          decorated.set(host, { button: adopted.button, key, text, injected: adopted.injected })
          autoFire(adopted.button, key, host)
          return
        }
        // The mark outlived the button as well. Nothing is there to adopt, so this is a block
        // wearing a ribbon from a decoration that no longer exists — clear it and build a real
        // one below, rather than leaving a prompt with no way to render it for the session.
        host.removeAttribute(DONE_ATTR)
      }
      // A block that turns up while the toggle is off is not a reply to auto-render, whatever it
      // may look like later: it is stamped now, by text as well as by element, so that switching
      // the toggle on answers the reply in front of the user and nothing above it.
      if (autoRender !== true) markHistory(pre)
      host.setAttribute(DONE_ATTR, '1')

      const bar = document.createElement('div')
      bar.setAttribute(OURS_ATTR, '1')
      bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px'

      const button = document.createElement('button')
      button.type = 'button'
      // The mark is what lets a later pass — or a press that lost its map — find this button
      // without the map. It travels with the element, which is the whole point.
      button.setAttribute(FIRE_ATTR, '1')
      button.textContent = t('blockButton')
      button.style.cssText =
        'height:24px;padding:0 10px;font-size:12px;cursor:pointer;border-radius:var(--dsw-radius-sm,4px);' +
        'border:1px solid var(--dsw-alias-border-l1,#d0d0d5);background:transparent;color:inherit'
      const status = document.createElement('span')
      status.style.cssText = 'color:var(--dsw-alias-label-tertiary,#888)'
      const slot = document.createElement('div')
      slot.setAttribute(OURS_ATTR, '1')

      button.addEventListener('click', async () => {
        button.disabled = true
        button.textContent = t('blockWorking')
        status.textContent = ''
        try {
          const body = await api('/generate', { method: 'POST', body: JSON.stringify({ prompt: text.trim(), key }) })
          generated.set(key, body.files ?? [])
          // Remembered before drawn: the store is what makes this reply survive a reload, and a
          // page that closes in between would otherwise lose pictures it has already shown.
          rememberFiles(key, body.files ?? [])
          showFiles(slot, body.files ?? [])
          // The board is drawn last, from the files just recorded: it stands for a finished
          // render, so it must never be the thing that arrives first.
          if ((body.files ?? []).length > 0) refreshReplyBoard(t)
          status.textContent = t('blockDone')
        } catch (error) {
          slot.replaceChildren()
          const failure = document.createElement('div')
          failure.style.cssText = 'margin-top:6px;font-size:12px;color:#c62828;white-space:pre-wrap'
          failure.textContent = `${t('blockFailed')}：${error.message}`
          slot.append(failure)
        } finally {
          button.disabled = false
          button.textContent = t('blockButton')
        }
      })

      bar.append(button, status)
      host.append(bar, slot)
      // `text` is the snapshot this decoration was built from: a later scan
      // compares against it and redoes the block if the transcript has filled in
      // more since. `injected` is what to remove when that happens.
      decorated.set(host, { button, key, text, injected: [bar, slot] })

      const cached = generated.get(key)
      if (cached !== undefined) {
        showFiles(slot, cached)
        status.textContent = t('blockDone')
        // A transcript that was rebuilt has its pictures but not yet its board.
        if (cached.length > 0) refreshReplyBoard(t)
      } else {
        // Nothing in memory: this is a conversation being opened, or a page that was reloaded.
        // This page's own store answers first — it is written on every render, so a reload puts
        // the pictures and the board back without waiting on the host at all. Only a prompt this
        // browser has never rendered needs the host's index, and then only for files on disk.
        const stored = recallFiles(key)
        if (stored !== null) {
          generated.set(key, stored)
          showFiles(slot, stored)
          status.textContent = t('blockDone')
          refreshReplyBoard(t)
        } else {
          // The words go with the digest: a render this index never saw under this page's key
          // is still findable by what the block says.
          restoreTexts.set(key, text)
          queueRestore(key, { host, slot, status }, t)
        }
      }
      if (autoForce === true) {
        // The user asking, in the toggle-on pass: the block in front of them renders now,
        // settled or not, because there is no later pass to wait for.
        autoFire(button, key, host)
      } else if (autoSettled === true) {
        // The quiet pass is the one that presses, and this block is only being decorated now:
        // its text settled in the same breath the reply stopped, so no later pass is coming and
        // waiting for one rendered nothing. (A block that is already decorated and unchanged
        // never reaches here — it is answered by the revisit branch at the top of this function.)
        autoFire(button, key, host)
      } else {
        // A first sighting, or a block whose text has just grown, in a pass that is looking at a
        // reply which may still be arriving. The fire is left to the quiet pass: the observer
        // brings it once the reply stops moving, and arming the window here also covers the case
        // where this block's growth was the last thing to happen.
        noteActivity()
      }
    }

    /**
     * Watch the transcript and keep every qualifying code block decorated.
     * @param t - the bound dictionary.
     * @returns a disposer that stops the observer.
     */
    function installCodeButtons(t) {
      // A browser always has both; the guard keeps activation from throwing if
      // this bundle is ever evaluated where no DOM exists.
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      /**
       * Decorate everything currently in the document.
       * @param options - `{ autoLastOnly: true }` allows a single auto-render, for the block in
       *   front of the user, which is what the toggle-on pass wants; `{ settled: true }` marks the
       *   pass that runs after the transcript has held still, which is the only pass that fires;
       *   `{ history: true }` marks a pass as the conversation as it already stands, in which
       *   nothing may fire at all.
       */
      const scan = (options = {}) => {
        const order = Array.from(document.querySelectorAll('pre'))
        // Newest first, so a single allowance lands on what the user is looking at.
        const nodes = options.autoLastOnly === true ? [...order].reverse() : order
        autoAllowance = options.autoLastOnly === true ? 1 : Number.POSITIVE_INFINITY
        // The forced pass is the user asking, so it outranks the history rule; every other
        // pass fires only for blocks that arrived after the transcript settled.
        autoForce = options.autoLastOnly === true
        // Only the quiet pass fires. Everything else is looking at a reply that is still being
        // written, and the block in front of it may well be finished already.
        autoSettled = options.settled === true
        autoHistory = options.history === true
        // The quiet pass answers one reply: the one in front of the user. The boundary is read
        // once, before the walk, so that every block of the pass is judged against the same one.
        const tally = new Map()
        if (autoSettled === true) settleHosts = new Set(newestReplyHosts())
        // Everything on screen when this half wakes up is the conversation as it already stands,
        // so none of it is a reply to auto-render — the newest block included. All of it is
        // stamped before the walk that decorates it, so that no later pass can read one of those
        // blocks as a reply that just arrived.
        if (options.history === true) {
          for (const pre of order) {
            if (pre.closest(`[${OURS_ATTR}]`) !== null) continue
            const body = readBlock(pre)
            if (looksLikePrompt(body.text, body.language)) markHistory(pre)
          }
        }
        try {
          for (const pre of nodes) {
            if (autoSettled === true) lastFireReason = 'not-a-prompt'
            try {
              decorate(pre, t)
            } catch {
              // One malformed block must not abort the rest of the scan.
            }
            if (autoSettled === true) {
              const reason = lastFireReason ?? 'unknown'
              tally.set(reason, (tally.get(reason) ?? 0) + 1)
            }
          }
        } finally {
          autoAllowance = Number.POSITIVE_INFINITY
          autoForce = false
          autoSettled = false
          autoHistory = false
        }
        if (options.settled === true) {
          // What this pass decided, block by block, kept by the host: this is the record that
          // answers "it did not render" with the gate that stopped it instead of a guess.
          diag('settle', {
            replies: settleHosts === null ? 0 : settleHosts.size,
            blocks: order.length,
            outcome: Object.fromEntries(tally)
          })
          settleHosts = null
          // A settled transcript is a turn that has finished answering, which is the only moment
          // at which "it did not call the tool" can be said about a turn at all.
          noteReplyTurn()
        }
        // Every pass ends by putting the reply's board back. Opening a conversation rebuilds the
        // transcript and takes the board with it, and nothing in that rebuild rendered anything —
        // so without this the board stayed gone until a new render happened to redraw it. The
        // signature guard is what keeps a pass that changed nothing from touching the DOM.
        try {
          refreshReplyBoard(t)
        } catch {
          // A pass that cannot draw a board has still decorated its blocks.
        }
      }
      // Whatever is on screen when this half activates is not a reply to anything — it is the
      // conversation as it already stands, so it is decorated and never fired at.
      scan({ history: true })
      rescanBlocks = scan
      let queued = false
      const observer = new MutationObserver((records) => {
        if (looksLikeReplay(records)) {
          let removed = 0
          for (const record of records ?? []) removed += (record?.removedNodes ?? []).length
          diag('replay', { removed })
          stampHistory(records)
        }
        // Every change a live reply makes pushes the render back, so the pass below is looking
        // at a transcript that is still moving: it decorates, and it waits.
        noteActivity()
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
          queued = false
          scan()
        })
      })
      // Text counts as movement: a reply grows by rewriting the text node it already has, and
      // the live elapsed-time row above it is pure text too, so an observer watching only for
      // added and removed nodes reads a transcript still being written as a still one.
      observer.observe(document.body, { childList: true, characterData: true, subtree: true })
      return () => {
        rescanBlocks = null
        observer.disconnect()
      }
    }

    /**
     * Learn whether auto-render was already switched on, without asking the panel.
     *
     * The flag used to have exactly one writer — the panel's effect — and the panel is mounted
     * only while this plugin's page is the active view. So a page that loaded with auto-render
     * already on (the stored setting says so, and the panel's own button reads 开) rendered
     * nothing at all until the user happened to wander into the panel; chat alone never turned
     * it back on. Read the stored answer from the host at activation instead.
     *
     * It must not force a pass: a forced pass fires the newest block on screen, which on a
     * loaded page is a conversation the user has already seen.
     * @returns a promise that settles once the flag is known.
     */
    /**
     * The stored setting as the host has it right now, or `null` if the host cannot answer.
     *
     * A null is not a no. The caller keeps whatever it had, because a page that has lost its host
     * must never decide on its own that the feature is off — that is one more way for the switch
     * to end up disagreeing with the thing it switches.
     *
     * @returns true, false, or null for "no answer".
     */
    async function readAutoSetting() {
      try {
        const status = await api('/status')
        return status?.autoGenerate === true
      } catch {
        return null
      }
    }

    async function bootAutoRender() {
      let wanted = await readAutoSetting()
      if (wanted === null && typeof setTimeout === 'function') {
        // Activation and the host's own routes can cross: the bundle is served by the process
        // that is still registering them, so the first read can be answered with nothing. One
        // retry covers it, and a page that still hears nothing keeps the flag off as before.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        wanted = await readAutoSetting()
      }
      if (wanted !== null) autoRender = wanted
      diag('boot', { autoRender, api: API })
    }

    /**
     * Keep the watcher's flag agreeing with the stored setting, whoever wrote it.
     *
     * The read is the panel's own status route: it spends no quota and needs no new host code,
     * and a page whose host has gone quiet simply keeps its last answer. The flag is handed over
     * *before* the panel is told, so a panel that re-reads status sees the same value the watcher
     * will act on.
     *
     * Coming back to a tab reads once straight away: a page that slept through the change should
     * not spend the next fifteen seconds answering from the past, and the moment it comes back is
     * exactly the moment it is about to be looked at.
     *
     * @returns a disposer for the effect scope.
     */
    function startSettingSync() {
      if (typeof setInterval !== 'function') return () => {}
      const read = async () => {
        const wanted = await readAutoSetting()
        if (wanted === null) return
        const moved = wanted !== autoRender
        autoRender = wanted
        if (moved && typeof onSettingMoved === 'function') onSettingMoved(wanted)
      }
      const timer = setInterval(read, SETTING_POLL_MS)
      const onWake = () => {
        if (typeof document !== 'undefined' && document?.hidden === true) return
        read()
      }
      if (typeof document?.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onWake)
      }
      if (typeof window?.addEventListener === 'function') window.addEventListener('focus', onWake)
      return () => {
        clearInterval(timer)
        if (typeof document?.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onWake)
        }
        if (typeof window?.removeEventListener === 'function') window.removeEventListener('focus', onWake)
      }
    }

    /**
     * The panel page needs the dictionary namespace bound to it as `t`, and the
     * packager supplies locale-bound helpers through the registration's `locale`
     * field; `props.t` is that binding when present, so the fallbacks above only
     * matter before the dictionary lands.
     *
     * The code-block buttons are plain DOM rather than a slot occupant, so they
     * are installed here and torn down with the same effect scope.
     * @param ctx - the client root context.
     */
    // --------------------------------------------------------- floating studio --
    // A draggable window for the per-mode settings. The sidebar panel is one long
    // column, and the question "what will 漫画 use" wants the two modes side by
    // side rather than buried in a form.
    //
    // Plain DOM rather than React: it lives outside the slot tree, so it stays open
    // while the transcript scrolls — the same approach as the image menu.

    /** Marks nodes this half injected, so nothing else claims them. */
    const STUDIO_MARK = 'data-nai-imagegen-studio'
    /** The alt text the render tool puts on every image it returns. */
    const GENERATED_ALT = '生成图片'
    /** The open window, or null. */
    let studio = null
    /**
     * Re-read every artist string the floating window shows, then repaint it.
     *
     * Assigned by `openStudio` for as long as the window exists. The panel calls it
     * after a string is edited: the change lands on the host, and this window would
     * otherwise keep showing the text it read when it was opened.
     */
    let refreshStudioArtist = null
    /**
     * Repaint the compact artist switcher, if it is open.
     *
     * The same story as the line above, for the other window: this one shows the text
     * and the reference picture of whichever entry is in force, and an edit made in the
     * panel changes both without changing the id.
     */
    let refreshArtistDock = null
    /**
     * How to bring the switcher back after it has been dismissed, and how to take that
     * way back away again. Set by `installFloatingStudio`, because the button belongs to
     * the same activation as the window it restores.
     */
    let dockRestore = null

    /** The knobs, mirroring the host's `MODE_FIELDS`. */
    const STUDIO_FIELDS = [
      { key: 'width', label: '宽', kind: 'number', min: 64, max: 2048, step: 64 },
      { key: 'height', label: '高', kind: 'number', min: 64, max: 2048, step: 64 },
      { key: 'steps', label: '步数', kind: 'number', min: 1, max: 50, step: 1 },
      { key: 'scale', label: '引导', kind: 'number', min: 0, max: 20, step: 0.1 },
      { key: 'ucPreset', label: 'UC 预设', kind: 'number', min: 0, max: 3, step: 1 },
      { key: 'maxImagesPerCall', label: '每次上限', kind: 'number', min: 1, max: 16, step: 1 },
      { key: 'model', label: '模型', kind: 'text' },
      { key: 'sampler', label: '采样器', kind: 'text' }
    ]

    /** The two modes. */
    const STUDIO_MODES = [
      { key: 'illustration', label: '🖼 出图' },
      { key: 'comic', label: '📖 漫画' }
    ]

    /** The override fields, mirroring the host's `MODE_FIELDS`. */
    const MODE_KEYS = {      artistId: 1,
      width: 1,
      height: 1,
      steps: 1,
      scale: 1,
      ucPreset: 1,
      maxImagesPerCall: 1,
      model: 1,
      sampler: 1,
      negativePrompt: 1,
      recipe: 1
    }

    /** Shared input styling. */
    const STUDIO_INPUT =
      'height:26px;padding:0 6px;font-size:12px;box-sizing:border-box;' +
      'border-radius:var(--dsw-radius-sm,4px);border:1px solid var(--dsw-alias-border-l1,#d0d0d5);' +
      'background:transparent;color:inherit'

    /**
     * Build one labelled row.
     * @param label - the visible label.
     * @param input - the control.
     * @param options - `{ changed }`; a changed row is marked so it is obvious which
     *   settings are actually overriding the shared default rather than sitting at it.
     * @returns the row element.
     */
    function studioRow(label, input, options = {}) {
      const row = document.createElement('label')
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;font-size:12px'
      const name = document.createElement('span')
      name.textContent = options.changed === true ? `● ${label}` : label
      name.style.cssText =
        'flex:none;width:64px;line-height:26px;' +
        (options.changed === true
          ? 'color:var(--dsw-alias-accent,#2d6cff);font-weight:600'
          : 'color:var(--dsw-alias-label-secondary,#666)')
      if (options.changed === true && typeof options.changedTitle === 'string') name.title = options.changedTitle
      input.style.cssText = `${STUDIO_INPUT};flex:1;min-width:0`
      row.append(name, input)
      return row
    }

    /**
     * The attribute the transcript puts on the node that closes a turn.
     *
     * Every turn ends with its own tail node: it sits after that turn's content and before the
     * next turn's, which makes it the one boundary in the DOM saying where a reply starts and
     * stops. Nothing else on the page carries a role — the class names are hashed per build, and
     * the live markers (`data-streaming`, `data-state="running"`) are not dependable company: the
     * app leaves them behind. That is why the marker check reads them only from the point where
     * this walk says the newest turn begins, and stops believing them once the page has gone still.
     */
    const TURN_TAIL_ATTR = 'data-turn-tail'
    /** How long a report stays in the window's line before the hint comes back. */
    const FIRE_LINE_MS = 6000
    // A double-click is delivered as two clicks, so the button below would press twice. The
    // second press arrives while the first one's renders are still in flight, and would report
    // "already rendering" over the verdict just given; the window is wide enough to swallow two
    // real presses too, which is nobody's intent anyway.
    const PRESS_MERGE_MS = 400

    /**
     * The code blocks of the newest reply, in the order they appear.
     *
     * "Newest" is read off the turn tails: walking the transcript backwards, everything before
     * the first tail belongs to the reply in front of the user, and the tail behind those blocks
     * belongs to the reply above it, which is where the walk stops. A conversation with a single
     * turn has no tail to stop at and is entirely the newest reply, which is what it is. A tail
     * reached with nothing collected yet is the current reply's own tail — its content sits above
     * it — and a second one there means that reply carries no prompt at all.
     *
     * @returns the decorated hosts of that reply, oldest first.
     */
    function newestReplyHosts() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return []
      // One query, so the tails come back in document order among the blocks rather than beside
      // them: two separate walks could not be interleaved afterwards without a tree comparison.
      const walk = Array.from(document.querySelectorAll(`pre, [${TURN_TAIL_ATTR}]`))
      const picked = []
      let boundaries = 0
      for (let index = walk.length - 1; index >= 0; index -= 1) {
        const node = walk[index]
        const tail = typeof node?.getAttribute === 'function' ? node.getAttribute(TURN_TAIL_ATTR) : null
        if (tail !== null) {
          if (picked.length > 0) break
          boundaries += 1
          if (boundaries > 1) break
          continue
        }
        picked.push(node?.parentElement ?? node)
      }
      return picked.reverse()
    }

    /**
     * The hosts of the newest reply that carry a button this half built, oldest first.
     *
     * The quiet pass wants the reply itself, decorated or not, because a block it is about to
     * decorate is one of that reply's too; a press wants only the blocks that have something to
     * press.
     *
     * @returns the decorated hosts of the newest reply, oldest first.
     */
    function latestReplyHosts() {
      return newestReplyHosts().filter((host) => decorated.get(host) !== undefined)
    }

    /**
     * Click every render button the newest reply carries.
     *
     * The reply in front of the user is the one they mean: an older reply's pictures are already
     * in the transcript, and rendering those again would spend quota to duplicate what is already
     * sitting on screen. This reply is the opposite case — a press is a **re-roll**, and NovelAI
     * draws a fresh seed every time, so a block that already has its pictures is the reason to
     * press it rather than a reason to skip it. The one thing left alone is a render already in
     * flight: pressing behind it would queue a second render of the same prompt.
     *
     * @returns `{ clicked, reason, marker }` — how many buttons were pressed, why that is the
     *   number, and which live marker was in the way: `clicked`, `none` when the reply has no
     *   prompt block, `spent` when every prompt of it is already rendering, or `busy` while the
     *   reply is still being written, with `marker` naming what said so.
     */
    function fireLatestReply(t) {
      const busy = blockingMarker()
      if (busy !== null) return { clicked: 0, reason: 'busy', marker: busy }
      // A reply that landed moments ago may not have been through a pass yet, and a block whose
      // text is still settling is rebuilt by this one; a pass that is not the quiet pass never
      // fires anything by itself, so this only prepares the buttons.
      if (typeof rescanBlocks === 'function') rescanBlocks()
      // The press is also a pass of last resort. A reply that has just landed, or one whose
      // button outlived the map that recorded it, has a prompt in it that the map cannot see —
      // and the answer to that is to decorate it here rather than to report that the reply in
      // front of the user has no prompt in it.
      const seen = newestReplyHosts()
      if (typeof t === 'object' && t !== null) {
        for (const host of seen) {
          const pre =
            host === null || host === undefined
              ? null
              : host.tagName === 'PRE'
                ? host
                : typeof host.querySelector === 'function'
                  ? host.querySelector('pre')
                  : null
          if (pre === null || pre === undefined) continue
          try {
            decorate(pre, t)
          } catch {
            // One malformed block must not abort the press.
          }
        }
      }
      const hosts = latestReplyHosts()
      let clicked = 0
      let spent = 0
      /** The button for one host: the map's, or the one the mark finds in the DOM. */
      const buttonFor = (host) =>
        decorated.get(host)?.button ??
        (typeof host?.querySelector === 'function' ? host.querySelector(`button[${FIRE_ATTR}]`) : null)
      for (const host of hosts) {
        const button = buttonFor(host)
        if (button === null || button === undefined || typeof button.click !== 'function') continue
        if (button.disabled === true) {
          spent += 1
          continue
        }
        clicked += 1
        button.click()
      }
      if (clicked === 0 && hosts.length === 0) {
        // Nothing recorded anywhere: the buttons may still be sitting under the reply, carrying
        // their mark. A press that finds one is the press the user asked for.
        for (const host of seen) {
          const button = buttonFor(host)
          if (button === null || button === undefined || typeof button.click !== 'function') continue
          if (button.disabled === true) {
            spent += 1
            continue
          }
          clicked += 1
          button.click()
        }
      }
      if (clicked > 0) return { clicked, reason: 'clicked' }
      // Kept for the next report of "it does nothing": how many blocks the newest reply has and
      // how many marked buttons were under it, which is the difference between a reply with no
      // prompt and a press that could not reach the prompt it has.
      diag('fire', {
        hosts: seen.length,
        blocks: seen.reduce(
          (total, host) =>
            total + (typeof host?.querySelectorAll === 'function' ? host.querySelectorAll('pre').length : 0),
          0
        ),
        marked: seen.reduce(
          (total, host) =>
            total +
            (typeof host?.querySelectorAll === 'function'
              ? host.querySelectorAll(`button[${FIRE_ATTR}]`).length
              : 0),
          0
        ),
        spent
      })
      if (spent > 0) return { clicked: 0, reason: 'spent' }
      return { clicked: 0, reason: hosts.length === 0 ? 'none' : 'spent' }
    }

    /**
     * Open the studio, or repaint an already-open one.
     * @param t - the bound dictionary.
     */
    async function openStudio(t) {
      if (studio !== null) {
        studio.root.style.display = 'flex'
        studio.paint()
        return
      }
      const status = await api('/status')
      const artists = await api('/artists?limit=500').catch(() => ({ artists: [] }))
      let active = String(status.mode ?? '') === 'comic' ? 'comic' : 'illustration'
      /** Working copies, so nothing is written until Save. */
      const draft = {}
      for (const mode of STUDIO_MODES) {
        draft[mode.key] = { ...((status.modeSettings ?? []).find((row) => row.mode === mode.key) ?? {}) }
      }
      const root = document.createElement('div')
      root.setAttribute(STUDIO_MARK, 'window')
      root.style.cssText =
        'position:fixed;z-index:2147483000;right:18px;bottom:70px;width:344px;max-height:76vh;' +
        'display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg,10px);' +
        'border:1px solid var(--dsw-alias-border-l1,#d0d0d5);background:var(--dsw-alias-bg-base,#fff);' +
        'color:var(--dsw-alias-label-primary,inherit);box-shadow:0 12px 40px rgba(0,0,0,0.22);font-size:12px'

      const header = document.createElement('div')
      header.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;flex:none;touch-action:none;' +
        'border-bottom:1px solid var(--dsw-alias-border-l1,#e6e6ea)'
      const title = document.createElement('span')
      title.textContent = t('studioTitle')
      title.style.cssText = 'flex:1;font-weight:600'
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '✕'
      close.style.cssText = 'border:0;background:transparent;cursor:pointer;color:inherit;font-size:14px;padding:0 4px'
      close.addEventListener('click', () => {
        root.remove()
        studio = null
        refreshStudioArtist = null
      })
      header.append(title, close)

      // The window is also a button, and this line is where it says so. It used to advertise a
      // gesture instead ("double-click the window") — and a gesture nobody was told about is a
      // feature nobody has. So the line itself became the button: one press, same act, and it
      // still reports what came of the press, because the outcome worth explaining is the one
      // where nothing was fired. Double-clicking the window keeps working; it is the same press.
      const fireLine = document.createElement('button')
      fireLine.type = 'button'
      fireLine.title = t('studioFireHint')
      fireLine.style.cssText =
        'display:block;width:100%;text-align:left;cursor:pointer;font:inherit;font-size:11px;' +
        'color:var(--dsw-alias-label-secondary,#666);background:transparent;border:0;padding:5px 10px;' +
        'flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,#e6e6ea)'
      fireLine.textContent = t('studioFireNow')
      // An inline-styled button gets no hover from anywhere else, and this one has to look
      // pressable: looking pressable is the entire reason it is a button now.
      fireLine.addEventListener('mouseenter', () => {
        fireLine.style.background = 'var(--dsw-alias-fill-l1,rgba(45,108,255,0.08))'
      })
      fireLine.addEventListener('mouseleave', () => {
        fireLine.style.background = 'transparent'
      })
      let fireTimer = null
      let lastPressAt = 0

      /**
       * Press the latest reply, and say what came of it.
       *
       * The press is a re-roll: NovelAI draws a fresh seed every time, so a block that already has
       * its pictures is exactly what this is for. Only a render already in flight is skipped, and
       * that rule lives in `fireLatestReply`.
       */
      const pressFire = () => {
        const now = typeof Date.now === 'function' ? Date.now() : 0
        if (now !== 0 && now - lastPressAt < PRESS_MERGE_MS) return
        lastPressAt = now
        // `t` travels with the press because the press is also the last pass that can decorate:
        // the newest reply may have arrived with its block undecorated, and this is the only
        // moment that can fix that before answering.
        const outcome = fireLatestReply(t)
        // A refusal is the one outcome worth naming the reason for: the marker is what the plugin
        // saw and decided to wait on, which is the difference between a reply still being written
        // and an attribute the app left lying around. Reading it back off the window is also how
        // the next report of "it does nothing" can say which one it was.
        const busyReport =
          outcome.marker === undefined || outcome.marker === null
            ? t('studioFireBusy')
            : `${t('studioFireBusy')}（${outcome.marker}）`
        const report = {
          clicked: `${t('studioFireStarted')}${outcome.clicked}${t('autoImageUnit')}`,
          busy: busyReport,
          spent: t('studioFireSpent'),
          none: t('studioFireNone')
        }[outcome.reason]
        fireLine.textContent = report ?? t('studioFireNone')
        if (fireTimer !== null && typeof clearTimeout === 'function') clearTimeout(fireTimer)
        if (typeof setTimeout === 'function') {
          fireTimer = setTimeout(() => {
            fireTimer = null
            fireLine.textContent = t('studioFireNow')
          }, FIRE_LINE_MS)
        }
      }

      fireLine.addEventListener('click', pressFire)
      root.addEventListener('dblclick', (event) => {
        // Double-clicking a field, a select or a button is the user picking a word or opening a
        // picker. Pressing the whole reply against that would spend quota on a text selection.
        // The artist list counts too: double-clicking a row is picking a row twice, not asking
        // for the whole reply — that is what the window's own background is for. (The line above
        // is itself a button now, so a double-click on it is two presses, merged by PRESS_MERGE_MS.)
        const target = event === null || event === undefined ? null : event.target
        if (
          target !== null &&
          target !== undefined &&
          typeof target.closest === 'function' &&
          target.closest('input, textarea, select, button, [data-no-window-gesture]') !== null
        ) {
          return
        }
        pressFire()
      })

      const tabs = document.createElement('div')
      tabs.style.cssText = 'display:flex;gap:6px;padding:8px 10px 4px;flex:none'
      const body = document.createElement('div')
      body.style.cssText = 'padding:4px 10px 10px;overflow-y:auto;display:flex;flex-direction:column;gap:7px'
      const actions = document.createElement('div')
      actions.style.cssText =
        'display:flex;gap:8px;align-items:center;padding:8px 10px;flex:none;border-top:1px solid var(--dsw-alias-border-l1,#e6e6ea)'

      /**
       * One line describing the style in force.
       * @param current - the working settings.
       * @returns the text.
       */
      /**
       * Whether one of a mode's fields differs from the shared default.
       *
       * Compared by type: the inputs hand back numbers for numeric fields and
       * strings otherwise, while `/status` reports the resolved value, so a strict
       * `!==` would flag every row the moment a type drifted. An empty value means
       * "inherit", which is not a difference.
       * @param field - the field descriptor.
       * @param current - the mode's working settings.
       * @returns true when it is an override rather than the default.
       */
      const differsFrom = (field, current) => {
        const mine = current[field.key]
        const base = status[field.key]
        if (mine === undefined || mine === null || mine === '') return false
        if (base === undefined || base === null) return true
        if (field.kind === 'number') return Number(mine) !== Number(base)
        return String(mine) !== String(base)
      }

      const artistLine = (current) => {
        const name = current.artistName
        const label = `${t('artistCurrent')}：${name ?? (Number(current.artistId) >= 0 ? `#${Number(current.artistId)}` : t('artistNone'))}`
        // `artistChars` is the *effective* length, so an edit shortens or lengthens it
        // here too; the tag says the text is not the archive's.
        const chars = Number(current.artistChars ?? 0)
        const edited = current.artistEdited === true ? `［${t('studioArtistEdited')}］` : ''
        return `${edited}${chars > 0 ? `${label}（+${chars} ${t('artistCharUnit')}）` : label}`
      }

      /**
       * The text of every artist id this window has read.
       *
       * Painting a tab, switching back and forth and reopening the picker all ask for
       * the same 1500-character prompt otherwise.
       */
      const artistTexts = {}

      /** Read one artist string, remembering it. Null when the id is unknown. */
      const readArtistText = async (id) => {
        const key = String(Number(id))
        if (!(key in artistTexts)) {
          artistTexts[key] = await api(`/artist-text?id=${encodeURIComponent(key)}`).catch(() => null)
        }
        return artistTexts[key]
      }

      /**
       * Fill the read-only preview with the text the current pick will send.
       *
       * Read-only on purpose: the window is the readout and the panel is the editor,
       * and two editors for one value is how the two start disagreeing.
       */
      const paintArtistPreview = async (current, node) => {
        const id = Number(current.artistId ?? -1)
        if (id < 0) {
          node.textContent = t('artistNone')
          return
        }
        const view = await readArtistText(id)
        // The pick may have moved on while this was in flight; painting the previous
        // id's text over the new one is worse than painting nothing.
        if (Number(current.artistId ?? -1) !== id) return
        if (view === null) {
          node.textContent = t('studioFailed')
          return
        }
        node.textContent = view.edited === true ? `［${t('studioArtistEdited')}］${view.positive}` : view.positive
      }

      /** Rebuild the body for the active mode. */
      const paint = () => {
        for (const node of tabs.children) {
          const on = node.dataset.mode === active
          node.style.background = on ? 'var(--dsw-alias-fill-l2,rgba(127,127,127,0.20))' : 'transparent'
          node.style.fontWeight = on ? '600' : '400'
        }
        body.replaceChildren()
        const current = draft[active]

        // A restart is due whenever the code on disk is newer than the process, which
        // is exactly the case where a saved setting appears to do nothing. Saying it
        // here — where the settings are being changed — beats documenting it.
        if (status.restart?.needed === true) {
          const warning = document.createElement('div')
          warning.style.cssText =
            'font-size:11px;line-height:15px;padding:6px 8px;border-radius:4px;' +
            'background:rgba(214,140,0,0.14);color:var(--dsw-alias-label-primary,inherit);' +
            'border:1px solid rgba(190,120,0,0.4);white-space:pre-wrap'
          warning.textContent = `${t('restartNeeded')}\n${(status.restart.files ?? []).join('、')}`
          body.append(warning)
        }

        // The artist string leads: it is the setting most likely to differ between
        // a single illustration and a comic page, and the one that was previously
        // shared by accident.
        //
        // Built by hand rather than declared as a `<select>`: an `<option>` cannot hold
        // a button, and the star has to live on the row it stars — a list you have to
        // leave in order to curate it is a list that gets curated once. It filters as it
        // is typed, which is what 200+ entries need, and it leads with the starred ones.
        //
        // The row is a plain `div` rather than the usual labelled row for the same
        // reason: a `<label>` forwards every click inside it to the control it names,
        // and picking an entry would then also re-toggle the list that picked it.
        const pickWrap = document.createElement('div')
        const pickerRow = document.createElement('div')
        pickerRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;font-size:12px'
        const pickName = document.createElement('span')
        pickName.textContent = t('studioArtist')
        pickName.style.cssText = 'flex:none;width:64px;line-height:26px;color:var(--dsw-alias-label-secondary,#666)'
        // The list is positioned against this, so it stays attached to the row it belongs
        // to while the window's body scrolls under it.
        pickWrap.style.cssText = 'position:relative;flex:1;min-width:0'
        pickerRow.append(pickName, pickWrap)

        const trigger = document.createElement('button')
        trigger.type = 'button'
        trigger.setAttribute('aria-haspopup', 'listbox')
        trigger.setAttribute('aria-expanded', 'false')
        trigger.style.cssText = `${STUDIO_INPUT};display:flex;align-items:center;gap:6px;cursor:pointer;text-align:left`
        const triggerText = document.createElement('span')
        triggerText.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
        const caret = document.createElement('span')
        caret.textContent = '▾'
        caret.style.cssText = 'flex:none;opacity:0.55'
        trigger.append(triggerText, caret)

        /** What the closed picker shows: the entry in force, or that there is none. */
        const pickLabel = () => {
          const id = Number(current.artistId ?? -1)
          if (id < 0) return t('artistNone')
          const name = current.artistName
          return name === null || name === undefined || name === '' ? `#${id}` : `#${id} ${name}`
        }
        triggerText.textContent = pickLabel()

        const popup = document.createElement('div')
        popup.style.cssText =
          'position:absolute;top:calc(100% + 3px);left:0;right:0;z-index:40;display:none;max-height:264px;' +
          'overflow-y:auto;padding:4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d0d0d5);' +
          'background:var(--dsw-alias-bg-base,#fff);box-shadow:0 10px 28px rgba(0,0,0,0.22)'
        // A press in here is not a window gesture. Without this the window's drag takes
        // the pointer on `pointerdown` — and with it the click — so the row under the
        // pointer never hears about being chosen, while the star (a `button`) still does.
        popup.setAttribute('data-no-window-gesture', '')
        const filter = document.createElement('input')
        filter.type = 'text'
        filter.placeholder = t('artistFavSearch')
        // Sticky, so the filter stays where it is while the entries scroll under it.
        filter.style.cssText =
          `${STUDIO_INPUT};width:100%;position:sticky;top:0;z-index:1;margin-bottom:4px;` +
          'background:var(--dsw-alias-bg-base,#fff)'
        const hint = document.createElement('div')
        hint.style.cssText = 'padding:2px 4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)'
        hint.textContent = t('artistFavHint')
        const list = document.createElement('div')
        list.setAttribute('role', 'listbox')
        popup.append(filter, hint, list)
        pickWrap.append(trigger, popup)
        let pickerOpen = false
        const summary = document.createElement('div')
        summary.style.cssText = 'font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#888);white-space:pre-wrap'
        // Built here rather than after the row, because the change handler below paints
        // it: an edit inside the picker has to move both the summary line and the text
        // underneath, or the window contradicts itself.
        const previewLabel = document.createElement('div')
        previewLabel.textContent = t('studioArtistPreview')
        previewLabel.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#888);margin-top:2px'
        const preview = document.createElement('div')
        preview.style.cssText =
          'font-size:11px;line-height:15px;white-space:pre-wrap;max-height:96px;overflow-y:auto;padding:4px 6px;' +
          'border-radius:4px;background:var(--dsw-alias-fill-l1,rgba(127,127,127,0.08));color:var(--dsw-alias-label-secondary,#666)'
        /** Take one entry: the pick moves, and both readouts underneath follow it. */
        const pickArtist = (row) => {
          current.artistId = Number(row.id)
          current.artistName = row.name ?? null
          triggerText.textContent = pickLabel()
          summary.textContent = artistLine(current)
          paintArtistPreview(current, preview)
          closePicker()
        }

        /** One row of the list: the entry, and the star that leads the list. */
        const buildRow = (row) => {
          const item = document.createElement('div')
          item.setAttribute('role', 'option')
          item.setAttribute('data-artist-id', String(row.id))
          const chosen = Number(current.artistId ?? -1) === Number(row.id)
          item.setAttribute('aria-selected', chosen ? 'true' : 'false')
          item.tabIndex = 0
          item.style.cssText =
            'display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;cursor:pointer;line-height:18px' +
            (chosen ? ';background:var(--dsw-alias-fill-l1,rgba(45,108,255,0.10))' : '')
          const text = document.createElement('span')
          text.style.cssText = 'flex:1;min-width:0;word-break:break-word'
          text.textContent = `#${row.id} ${row.name}`
          const star = document.createElement('button')
          star.type = 'button'
          star.textContent = row.favorite === true ? '★' : '☆'
          star.title = row.favorite === true ? t('artistFavRemove') : t('artistFavAdd')
          star.setAttribute('aria-pressed', row.favorite === true ? 'true' : 'false')
          star.style.cssText =
            'flex:none;border:0;background:transparent;cursor:pointer;font-size:15px;line-height:18px;padding:0 2px;' +
            `color:${row.favorite === true ? '#e8a800' : 'var(--dsw-alias-label-tertiary,#8a8a90)'}`
          // The star is not a pick, and stopping the event is the whole difference: the
          // row's own handler never sees this click.
          star.addEventListener('click', (event) => {
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            if (typeof event.preventDefault === 'function') event.preventDefault()
            starring(row)
          })
          item.append(text, star)
          item.addEventListener('click', () => pickArtist(row))
          item.addEventListener('keydown', (event) => {
            if (event?.key !== 'Enter' && event?.key !== ' ') return
            if (typeof event.preventDefault === 'function') event.preventDefault()
            pickArtist(row)
          })
          return item
        }

        /** Draw the list in the order the window is holding, filtered by the box. */
        const paintList = () => {
          list.replaceChildren()
          const needle = String(filter.value ?? '')
            .trim()
            .toLowerCase()
          const rows = (artists.artists ?? []).filter(
            (row) => needle === '' || `#${row.id} ${row.name}`.toLowerCase().includes(needle)
          )
          if (rows.length === 0) {
            const empty = document.createElement('div')
            empty.style.cssText = 'padding:6px 4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)'
            empty.textContent = t('artistFavNone')
            list.append(empty)
            return
          }
          for (const row of rows) list.append(buildRow(row))
        }

        /**
         * Open the list, and decide its order on the way in.
         *
         * This is the one moment the order is settled. Starring something re-sorts
         * nothing while the list is open: the row under the pointer would become a
         * different entry's row, and the click after it would mean something the user
         * never asked for. "Starred goes first" is therefore about the next look at the
         * list, which is exactly what it was asked to be.
         */
        const openPicker = () => {
          artists.artists = favoriteFirst(artists.artists)
          paintList()
          hint.textContent = t('artistFavHint')
          pickerOpen = true
          popup.style.display = 'block'
          trigger.setAttribute('aria-expanded', 'true')
          if (typeof filter.focus === 'function') filter.focus()
        }

        const closePicker = () => {
          pickerOpen = false
          popup.style.display = 'none'
          trigger.setAttribute('aria-expanded', 'false')
          filter.value = ''
        }

        /**
         * Write one star, and say what came of it.
         *
         * The host is the only thing that remembers: a star is a curated list, not a
         * per-session preference, so it is stored beside the archive and read back on
         * both surfaces. A refusal is reported in the hint line rather than left as a
         * ★ that would be gone the next time the list is opened.
         */
        const starring = async (row) => {
          const want = row.favorite !== true
          try {
            const body = await api('/artist-favorite', {
              method: 'POST',
              body: JSON.stringify({ id: Number(row.id), favorite: want })
            })
            row.favorite = (body.favorites ?? []).map((value) => Number(value)).includes(Number(row.id))
            hint.textContent = row.favorite === true ? t('artistFavSaved') : t('artistFavCleared')
            paintList()
          } catch {
            hint.textContent = t('artistFavFailed')
          }
        }

        trigger.addEventListener('click', () => {
          if (pickerOpen) closePicker()
          else openPicker()
        })
        filter.addEventListener('input', () => paintList())
        popup.addEventListener('keydown', (event) => {
          if (event?.key !== 'Escape') return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          closePicker()
        })
        // A click anywhere else in the window puts the list away. Asked of the wrapper,
        // so a click on the trigger does not both toggle the list and be treated as an
        // outside click by the same event.
        root.addEventListener('click', (event) => {
          if (pickerOpen !== true) return
          const target = event?.target
          if (typeof pickWrap.contains === 'function') {
            if (pickWrap.contains(target)) return
          } else if (target === trigger || target === filter || target === list) {
            return
          }
          closePicker()
        })
        // The reference picture of the entry in force, beside the picker.
        //
        // It used to be 26 px and an `<a target="_blank">`: at that size a style guide is
        // a smudge, and the only way to look at it was to leave the page. A press now
        // enlarges it in place instead — the same overlay the transcript's renders use,
        // without the gallery strip, because those pictures are not other attempts at
        // this one.
        const thumbButton = document.createElement('button')
        thumbButton.type = 'button'
        thumbButton.title = t('dockZoom')
        thumbButton.style.cssText =
          'flex:none;width:46px;height:58px;padding:0;border:1px solid var(--dsw-alias-border-l1,#e2e2e6);' +
          'border-radius:4px;overflow:hidden;background:var(--dsw-alias-fill-l1,#eee);cursor:zoom-in'
        if (Number(current.artistId) >= 0) {
          const source = `${API}/artist-image?id=${Number(current.artistId)}`
          const thumb = document.createElement('img')
          thumb.src = source
          thumb.alt = pickLabel()
          thumb.loading = 'lazy'
          thumb.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
          thumbButton.append(thumb)
          thumbButton.addEventListener('click', () => openArtistZoom(source, pickLabel()))
        } else {
          thumbButton.disabled = true
          thumbButton.style.cursor = 'default'
        }
        pickerRow.append(thumbButton)
        body.append(pickerRow, previewLabel, preview)
        paintArtistPreview(current, preview)

        // The comic console's own switches. Only the comic mode has panels to pace
        // and a page to margin, so the illustration side does not show them.
        if (active === 'comic') {
          const groups = (status.modeSettings ?? []).find((row) => row.mode === 'comic')?.recipeGroups ?? []
          const recipe = current.recipe ?? {}
          const heading = document.createElement('div')
          heading.textContent = t('studioRecipe')
          heading.style.cssText = 'font-size:11px;font-weight:600;margin-top:2px;color:var(--dsw-alias-label-secondary,#666)'
          body.append(heading)
          for (const group of groups) {
            const select = document.createElement('select')
            for (const option of group.options) {
              const entry = document.createElement('option')
              entry.value = option.key
              entry.textContent = option.label
              select.append(entry)
            }
            select.value = recipe[group.key] ?? group.default
            const changed = String(select.value) !== String(group.default)
            select.addEventListener('change', () => {
              current.recipe = { ...(current.recipe ?? {}), [group.key]: select.value }
            })
            body.append(studioRow(group.label, select, { changed }))
            // A group whose effect is not obvious — 页数 never reaches the image API,
            // 对白语言 only letters text that already exists — says so rather than
            // reading as a switch that does nothing.
            if (typeof group.note === 'string' && group.note !== '') {
              const note = document.createElement('div')
              note.textContent = group.note
              note.style.cssText = 'font-size:10px;line-height:13px;padding-left:72px;margin-top:-4px;color:var(--dsw-alias-label-tertiary,#888)'
              body.append(note)
            }
          }
        }

        // The aspect ratio leads, because picking a shape is the usual intent and
        // typing two pixel counts the rare one. Choosing a ratio fills both numbers,
        // which stay editable afterwards.
        const ratioSelect = document.createElement('select')
        ratioSelect.style.cssText = STUDIO_INPUT
        const customRatio = document.createElement('option')
        customRatio.value = ''
        ratioSelect.append(customRatio)
        for (const entry of status.ratios ?? []) {
          const option = document.createElement('option')
          option.value = entry.key
          option.textContent = `${entry.label} ${entry.width}×${entry.height}`
          ratioSelect.append(option)
        }
        /** Which preset a size is, or null when it was hand-typed. */
        function ratioKeyOf(w, h) {
          const entry = (status.ratios ?? []).find((row) => row.width === Number(w) && row.height === Number(h))
          return entry === undefined ? null : entry.key
        }
        /**
         * Point the select at whatever the numbers currently are.
         *
         * A hand-typed size is not a preset, so it reports itself as 自定义 with its
         * own dimensions rather than jumping to the nearest ratio, which would be a
         * quiet lie about what will be rendered.
         */
        function syncRatio() {
          const key = ratioKeyOf(current.width, current.height)
          customRatio.textContent = key === null ? `${t('studioRatioCustom')} ${current.width}×${current.height}` : t('studioRatioCustom')
          ratioSelect.value = key === null ? '' : key
        }
        syncRatio()
        ratioSelect.addEventListener('change', () => {
          const entry = (status.ratios ?? []).find((row) => row.key === ratioSelect.value)
          if (entry === undefined) return
          current.width = entry.width
          current.height = entry.height
          // Repaint, so the number inputs and the "changed" markers agree with the
          // new size instead of trailing it by one interaction.
          paint()
        })
        body.append(studioRow(t('studioRatio'), ratioSelect))

        for (const field of STUDIO_FIELDS) {
          const input = document.createElement('input')
          input.type = field.kind === 'number' ? 'number' : 'text'
          if (field.min !== undefined) input.min = String(field.min)
          if (field.max !== undefined) input.max = String(field.max)
          if (field.step !== undefined) input.step = String(field.step)
          input.value = current[field.key] === undefined || current[field.key] === null ? '' : String(current[field.key])
          input.addEventListener('input', () => {
            current[field.key] = field.kind === 'number' ? Number(input.value) : input.value
            // Typing a size by hand has to move the ratio select too, or it would
            // keep claiming the old preset while a different size is queued.
            if (field.key === 'width' || field.key === 'height') syncRatio()
          })
          // Marked when it differs from the shared default, so "which of these is
          // actually doing something" is answerable at a glance. A mode sitting
          // entirely at the defaults renders exactly like the other one, which is
          // what made a save look like it had done nothing.
          body.append(studioRow(field.label, input, { changed: differsFrom(field, current) }))
        }

        const negative = document.createElement('textarea')
        negative.rows = 3
        negative.style.cssText = `${STUDIO_INPUT};height:auto;padding:6px;resize:vertical;width:100%`
        negative.value = current.negativePrompt ?? ''
        negative.addEventListener('input', () => {
          current.negativePrompt = negative.value
        })
        body.append(studioRow(t('studioNegative'), negative, { changed: String(current.negativePrompt ?? '') !== String(status.negativePrompt ?? '') }))

        summary.textContent = artistLine(current)
        body.append(summary)
        const note = document.createElement('div')
        note.style.cssText = 'font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#888)'
        note.textContent = t('studioHint')
        body.append(note)
      }

      for (const mode of STUDIO_MODES) {
        const tab = document.createElement('button')
        tab.type = 'button'
        tab.dataset.mode = mode.key
        tab.textContent = mode.label
        tab.style.cssText = `${STUDIO_INPUT};flex:1;cursor:pointer`
        tab.addEventListener('click', () => {
          active = mode.key
          paint()
        })
        tabs.append(tab)
      }

      const statusLine = document.createElement('span')
      statusLine.style.cssText = 'flex:1;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)'
      const save = document.createElement('button')
      save.type = 'button'
      save.textContent = t('studioSave')
      save.style.cssText =
        'height:28px;padding:0 14px;font-size:12px;cursor:pointer;font-weight:600;' +
        'border-radius:var(--dsw-radius-sm,4px);border:1px solid var(--dsw-alias-accent,#2d6cff);' +
        'background:transparent;color:inherit'
      save.addEventListener('click', async () => {
        statusLine.textContent = `${t('studioSave')}…`
        try {
          const modes = {}
          for (const mode of STUDIO_MODES) {
            const row = {}
            for (const [key, value] of Object.entries(draft[mode.key])) {
              // Only override fields travel; everything else is derived and must not
              // be written back as if it were a setting.
              if (!Object.prototype.hasOwnProperty.call(MODE_KEYS, key)) continue
              if (value === undefined || value === null) continue
              if (typeof value === 'number' && !Number.isFinite(value)) continue
              row[key] = value
            }
            modes[mode.key] = row
          }
          await api('/config', {
            method: 'POST',
            body: JSON.stringify({ modes })
          })
          const fresh = await api('/status')
          for (const mode of STUDIO_MODES) {
            draft[mode.key] = { ...((fresh.modeSettings ?? []).find((row) => row.mode === mode.key) ?? {}) }
          }
          // Repaint the injected stylesheet at once, so the change takes effect
          // without closing and reopening the window.
          refreshImageSizing?.()
          statusLine.textContent = `${t('studioSaved')} ✓`
          paint()
        } catch (error) {
          statusLine.textContent = `${t('studioFailed')}：${error.message}`
        }
      })
      actions.append(save, statusLine)

      // Dragging.
      //
      // Two things were wrong with binding move/up to the header:
      //
      //   1. A pointer that leaves the header mid-drag stops delivering moves to it, so
      //      the window froze the instant the cursor outran the title bar — which is
      //      most of a drag. Capture fixes it: once captured, every move comes here
      //      regardless of what the cursor is over.
      //   2. `offsetLeft`/`offsetTop` are relative to the offset parent, which for a
      //      fixed element is not the viewport. `getBoundingClientRect()` is, and it is
      //      in the same coordinate space as `clientX`/`clientY`.
      //
      // The whole window is a handle, minus the controls, because the point of a
      // floating window is getting it out of the way of whatever it covers.
      //
      // `[data-no-window-gesture]` is the other half of that list, and it is not
      // cosmetic: `setPointerCapture` below retargets the entire gesture — the click
      // included — to the window root, so a plain `div` the pointer went down on never
      // hears about its own click. Fields, buttons and links are excluded by their own
      // tags; the artist list's rows are divs, so that list says so for itself.
      const DRAG_IGNORE = 'input,select,textarea,button,a,[contenteditable="true"],[data-no-window-gesture]'
      let dragging = null

      /** Start a drag unless the press landed on something interactive. */
      function beginDrag(event) {
        if (event.button !== undefined && event.button !== 0) return
        const target = event.target
        if (typeof target?.closest === 'function' && target.closest(DRAG_IGNORE) !== null) return
        const rect = root.getBoundingClientRect()
        dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
        // Pin the position in left/top, so the drag does not fight the initial
        // right/bottom anchoring.
        root.style.right = 'auto'
        root.style.bottom = 'auto'
        root.style.left = `${Math.round(rect.left)}px`
        root.style.top = `${Math.round(rect.top)}px`
        root.style.cursor = 'grabbing'
        // Keep receiving moves even when the cursor leaves the window entirely.
        if (typeof root.setPointerCapture === 'function') {
          try {
            root.setPointerCapture(event.pointerId)
          } catch {}
        }
        // Otherwise the drag turns into a text selection.
        event.preventDefault()
      }

      root.addEventListener('pointerdown', beginDrag)
      root.addEventListener('pointermove', (event) => {
        if (dragging === null) return
        if (event.pointerId !== undefined && event.pointerId !== dragging.id) return
        const step = (value, min, max) => Math.max(min, Math.min(max, value))
        const width = root.offsetWidth || 320
        const viewportWidth = window.innerWidth || width
        const viewportHeight = window.innerHeight || 600
        // Free movement, but never all the way out of reach: a sliver stays
        // grabbable on every edge.
        const nextLeft = step(dragging.left + (event.clientX - dragging.x), 60 - width, viewportWidth - 60)
        const nextTop = step(dragging.top + (event.clientY - dragging.y), 0, viewportHeight - 40)
        root.style.left = `${Math.round(nextLeft)}px`
        root.style.top = `${Math.round(nextTop)}px`
      })
      /** Finish a drag. */
      const endDrag = (event) => {
        if (dragging === null) return
        if (event?.pointerId !== undefined && event.pointerId !== dragging.id) return
        if (typeof root.releasePointerCapture === 'function') {
          try {
            root.releasePointerCapture(dragging.id)
          } catch {}
        }
        dragging = null
        root.style.cursor = ''
      }
      root.addEventListener('pointerup', endDrag)
      root.addEventListener('pointercancel', endDrag)

      root.append(header, fireLine, tabs, body, actions)
      document.body.append(root)
      /**
       * Re-read every artist string and repaint, for the panel's benefit.
       *
       * The cache is dropped first — that is what makes this a re-read rather than a
       * repaint of the text read when the window opened, which is the whole point of
       * a panel edit reaching this window.
       */
      refreshStudioArtist = () => {
        for (const key of Object.keys(artistTexts)) delete artistTexts[key]
        if (studio === null) return
        studio.paint()
      }
      studio = { root, paint }
      paint()
    }

    /**
     * One floating corner button: press it to open a window, drag it to park it.
     *
     * Both windows need one and the mechanics are the same either way — capture the
     * pointer so a drag outlives the cursor leaving the button, treat a few pixels of
     * travel as a click so an unsteady hand does not turn 「打开」 into 「挪一下」, and
     * remember where it was left. What differs is only what a press runs.
     *
     * @param options - `{ mark, glyph, title, posKey, corner, onOpen }`.
     * @returns a disposer.
     */
    function mountLauncher(options) {
      const launcher = document.createElement('button')
      launcher.type = 'button'
      launcher.setAttribute(STUDIO_MARK, options.mark)
      launcher.textContent = options.glyph
      launcher.title = options.title
      launcher.style.cssText =
        'position:fixed;z-index:2147482000;touch-action:none;line-height:1;cursor:grab;' +
        'width:40px;height:40px;font-size:18px;border-radius:20px;' +
        'border:1px solid var(--dsw-alias-border-l1,#d0d0d5);background:var(--dsw-alias-bg-base,#fff);' +
        'color:inherit;box-shadow:0 4px 16px rgba(0,0,0,0.18)'

      /**
       * Where the button was last left, per browser.
       *
       * `localStorage` rather than the config file: this is where one person parked a
       * button, not a rendering setting, and it should not travel to another machine
       * with the config.
       */
      const LAUNCHER_POS = options.posKey
      /** How far the pointer may travel before a press counts as a drag. */
      const DRAG_SLOP = 4
      /** Set when a drag finished, so the click that follows does not open the studio. */
      let suppressClick = false

      /**
       * The remembered position, if it is still usable.
       *
       * A window that shrank since the position was saved can leave the button
       * entirely off-screen, which looks exactly like the plugin having vanished.
       * @returns `{ left, top }`, or null to fall back to the corner.
       */
      function readLauncherPos() {
        try {
          const raw = window.localStorage?.getItem(LAUNCHER_POS)
          if (typeof raw !== 'string') return null
          const parsed = JSON.parse(raw)
          const left = Number(parsed?.left)
          const top = Number(parsed?.top)
          if (!Number.isFinite(left) || !Number.isFinite(top)) return null
          const viewportWidth = window.innerWidth || 0
          const viewportHeight = window.innerHeight || 0
          if (left < -20 || top < -20 || left > viewportWidth - 20 || top > viewportHeight - 20) return null
          return { left, top }
        } catch {
          return null
        }
      }

      /**
       * Place the button.
       * @param pos - `{ left, top }`, or null for this button's own corner.
       */
      function applyLauncherPos(pos) {
        if (pos === null) {
          launcher.style.left = 'auto'
          launcher.style.top = 'auto'
          launcher.style.right = options.corner.right
          launcher.style.bottom = options.corner.bottom
          return
        }
        launcher.style.right = 'auto'
        launcher.style.bottom = 'auto'
        launcher.style.left = `${Math.round(pos.left)}px`
        launcher.style.top = `${Math.round(pos.top)}px`
      }

      applyLauncherPos(readLauncherPos())

      /**
       * Run what this button runs, unless the press that produced this click was a drag.
       *
       * The click event arrives after a drag too, so without the guard a move would
       * also pop the window open — the opposite of what moving it was for.
       * @param event - the click.
       */
      function onLauncherClick(event) {
        if (suppressClick) {
          suppressClick = false
          event?.preventDefault?.()
          return
        }
        options.onOpen(launcher)
      }

      // The button drags as well as clicks. It used to be pinned to the corner, which
      // only became a problem once the studio window started opening over it and the
      // way to close the window was the button underneath.
      let press = null
      launcher.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return
        const rect = launcher.getBoundingClientRect()
        press = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false }
        if (typeof launcher.setPointerCapture === 'function') {
          try {
            launcher.setPointerCapture(event.pointerId)
          } catch {}
        }
      })
      launcher.addEventListener('pointermove', (event) => {
        if (press === null || event.pointerId !== press.id) return
        const dx = event.clientX - press.x
        const dy = event.clientY - press.y
        // A few pixels of travel still counts as a click, so a slightly unsteady
        // hand does not turn "open the studio" into "nudge the button".
        if (!press.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return
        press.moved = true
        launcher.style.cursor = 'grabbing'
        const size = launcher.offsetWidth || 40
        const viewportWidth = window.innerWidth || size
        const viewportHeight = window.innerHeight || size
        const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
        press.left = clamp(press.left + dx, 0, viewportWidth - size)
        press.top = clamp(press.top + dy, 0, viewportHeight - size)
        press.x = event.clientX
        press.y = event.clientY
        applyLauncherPos({ left: press.left, top: press.top })
      })
      /** Settle a press: remember a move, or let a click through. */
      function endLauncherPress(event) {
        if (press === null) return
        if (event?.pointerId !== undefined && event.pointerId !== press.id) return
        const held = press
        press = null
        launcher.style.cursor = 'grab'
        if (typeof launcher.releasePointerCapture === 'function') {
          try {
            launcher.releasePointerCapture(held.id)
          } catch {}
        }
        if (!held.moved) return
        suppressClick = true
        try {
          window.localStorage?.setItem(LAUNCHER_POS, JSON.stringify({ left: Math.round(held.left), top: Math.round(held.top) }))
        } catch {
          // A browser that refuses storage just means the position is not remembered.
        }
      }
      launcher.addEventListener('pointerup', endLauncherPress)
      launcher.addEventListener('pointercancel', endLauncherPress)
      launcher.addEventListener('click', onLauncherClick)
      document.body.append(launcher)
      return () => launcher.remove()
    }

    /**
     * Add the two floating launchers: the settings window, and the artist switcher.
     *
     * Two buttons rather than one menu, because they answer two questions at two
     * frequencies: the studio is where a mode gets set up, and the switcher is where a
     * style gets changed between two attempts at the same idea. The switcher opens on
     * activation instead of waiting behind its own button — but it can be put away, and
     * the second button is what brings it back.
     *
     * The 「重新生图」 press is the other half of a style change, and it lives in the
     * switcher's own header: press the new string without opening anything else.
     *
     * @param t - the bound dictionary.
     * @returns a disposer.
     */
    function installFloatingStudio(t) {
      // A real document always has all of these; the check keeps activation from
      // throwing in a host that has no DOM, and the launcher's dedupe genuinely
      // needs `querySelector`.
      if (
        typeof document === 'undefined' ||
        typeof document.body?.append !== 'function' ||
        typeof document.querySelector !== 'function'
      ) {
        return () => {}
      }
      if (document.querySelector(`[${STUDIO_MARK}="launcher"]`) !== null) return () => {}
      const removeStudio = mountLauncher({
        mark: 'launcher',
        glyph: '🎛',
        title: t('studioTitle'),
        posKey: 'nai-imagegen:launcher-pos',
        corner: { right: '18px', bottom: '18px' },
        onOpen: (button) => {
          openStudio(t).catch((error) => {
            button.title = `${t('studioFailed')}：${error.message}`
          })
        }
      })
      // The switcher is not summoned. A window that hides behind a button is a window
      // you forget you have, and this one is meant to be one press away at all times —
      // so it is simply there, from the moment the plugin is active. What is left of
      // the button is the way back, shown only once the window has been dismissed.
      let restoreDock = null
      const showDockRestore = () => {
        if (restoreDock !== null) return
        restoreDock = mountLauncher({
          mark: 'launcher-dock',
          glyph: '🎨',
          title: t('dockTitle'),
          posKey: 'nai-imagegen:dock-launcher-pos',
          corner: { right: '18px', bottom: '70px' },
          onOpen: (button) => {
            hideDockRestore()
            openArtistDock(t).catch((error) => {
              button.title = `${t('dockFailed')}：${error.message}`
            })
          }
        })
      }
      const hideDockRestore = () => {
        if (restoreDock === null) return
        restoreDock()
        restoreDock = null
      }
      dockRestore = { show: showDockRestore, hide: hideDockRestore }
      // Fire and forget: a host that answers slowly must not hold up activation.
      openArtistDock(t).catch(() => {})
      return () => {
        hideDockRestore()
        removeFire()
        dockRestore = null
        removeStudio()
        if (studio !== null) {
          studio.root.remove()
          studio = null
        }
        if (artistDock !== null) {
          artistDock.root.remove()
          artistDock = null
        }
        if (artistZoom !== null) closeArtistZoom()
        // Those hooks belong to those windows; a late panel save must not paint a
        // window that no longer exists.
        refreshStudioArtist = null
        refreshArtistDock = null
      }
    }

    // ------------------------------------------------------- image display size --
    // A generated page is 832x1216 and draws at the full column width, which pushes
    // the rest of the conversation off-screen. The rules are injected as a
    // stylesheet rather than set on each element: the transcript re-renders and
    // replaces nodes, and an attribute selector survives that where an inline style
    // does not.

    /** The src fragment identifying our own output, from `/status`. */
    let imageMatch = '_out/nai/'
    /** Set by `installImageSizing` so a settings save can repaint the stylesheet. */
    let refreshImageSizing = null

    /**
     * The stylesheet for one display setting.
     *
     * Pure, so the clamping and the zoom rule can be asserted without a browser.
     *
     * @param display - `{ width, maxHeight, match }`, any field optional.
     * @returns the CSS text.
     */
    function buildImageSizingCss(display) {
      const width = Math.min(100, Math.max(10, Number(display?.width) || 100))
      const maxHeight = Math.max(0, Number(display?.maxHeight) || 0)
      // This fragment lands inside a quoted attribute selector, so anything that
      // could close the quote or escape it is dropped rather than trusted.
      const match = String(display?.match ?? '_out/nai/').replace(/["'\\]/g, '')
      // Both selectors: the marked attribute (set by the right-click menu) and the
      // path fragment, so sizing works even before anything has been marked.
      const selector = `img[${IMG_ATTR}="1"], img[src*="${match}"]`
      // `!important`, because the shell's own stylesheet may be inserted after this one:
      // same specificity, later wins, and the scale would look like it did nothing. The
      // attribute selector is the one that actually matches; the path fragment is a
      // bonus for hosts that keep the address intact.
      const rules = [
        `${selector} {`,
        `  width: ${width}% !important;`,
        '  max-width: 100% !important;',
        '  height: auto !important;',
        maxHeight > 0 ? `  max-height: ${maxHeight}px !important;` : '',
        '  object-fit: contain !important;',
        '  cursor: zoom-in;',
        '  border-radius: var(--dsw-radius-sm, 4px);',
        '}'
      ]
      if (display?.clickZoom !== false) {
        // Enlarging is not restricted to this plugin's renders — every content image the
        // sweep marked answers a click — so this rule keys off the zoomable mark rather
        // than the selector the scale uses. Enlarging opens an overlay, so nothing here
        // ever changes a picture's size in place: the conversation keeps its layout.
        rules.push(`img[${ZOOMABLE_ATTR}="1"] {`, '  cursor: zoom-in;', '}')
      }
      return rules.filter((line) => line !== '').join('\n')
    }

    // ------------------------------------------------------------- enlargement --
    // Enlarging is an overlay over the page, not a change to the image's own layout.
    // Resizing a picture in place moves the whole conversation around and fights every
    // container that sized it — a sidebar grid, a link, a table cell. A popup leaves the
    // page exactly as it was.

    /** The overlay that is open, if any. */
    let lightbox = null
    /**
     * The strip of earlier renders of that overlay, if any.
     *
     * Kept beside the overlay so the arrow keys can reach it: the strip is what turns the
     * enlargement from a dead end into a viewer.
     */
    let lightboxStrip = null

    /** The two side handles of the enlargement, so a mouse steps it the way the keys do. */
    const LIGHTBOX_ARROW_ATTR = 'data-nai-imagegen-lightbox-arrow'

    /** The backdrop: above everything, click anywhere to close. */
    const LIGHTBOX_STYLE = {
      position: 'fixed',
      top: '0',
      right: '0',
      bottom: '0',
      left: '0',
      zIndex: '2147483000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.82)',
      cursor: 'zoom-out',
      // Room along the top for the strip of earlier renders, so the picture is never
      // covered by it.
      padding: '104px 2vw 3vh',
      boxSizing: 'border-box'
    }

    /** The enlarged picture. `important`, so no host stylesheet can shrink it. */
    const LIGHTBOX_IMAGE_STYLE = {
      width: 'auto',
      height: 'auto',
      maxWidth: '96vw',
      maxHeight: 'calc(100vh - 140px)',
      objectFit: 'contain',
      borderRadius: '4px',
      boxShadow: '0 12px 48px rgba(0, 0, 0, 0.5)'
    }

    /** The strip of other renders, along the top of the overlay. */
    const LIGHTBOX_STRIP_STYLE = {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      height: '96px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '10px 12px',
      overflowX: 'auto',
      overflowY: 'hidden',
      background: 'rgba(0, 0, 0, 0.55)',
      boxSizing: 'border-box'
    }

    /** One thumbnail of that strip. */
    const LIGHTBOX_THUMB_STYLE = {
      width: '64px',
      height: '76px',
      objectFit: 'cover',
      flex: '0 0 auto',
      cursor: 'pointer',
      borderRadius: '4px'
    }

    /** The thumbnail whose picture is the one on screen. */
    const LIGHTBOX_THUMB_ACTIVE = {
      opacity: '1',
      border: '2px solid rgba(255, 255, 255, 0.95)'
    }

    /** Every other thumbnail. */
    const LIGHTBOX_THUMB_IDLE = {
      opacity: '0.55',
      border: '2px solid transparent'
    }

    /** `3 / 20`, parked at the top right. */
    const LIGHTBOX_COUNT_STYLE = {
      position: 'absolute',
      top: '108px',
      right: '16px',
      zIndex: '2',
      font: '12px/1.4 system-ui, sans-serif',
      color: 'rgba(255, 255, 255, 0.85)',
      background: 'rgba(0, 0, 0, 0.5)',
      padding: '3px 9px',
      borderRadius: '999px',
      cursor: 'default'
    }

    /** A click target on each side of the picture: the same step the arrow keys take. */
    const LIGHTBOX_ARROW_STYLE = {
      position: 'absolute',
      top: '50%',
      transform: 'translateY(-50%)',
      width: '52px',
      height: '52px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxSizing: 'border-box',
      borderRadius: '999px',
      background: 'rgba(0, 0, 0, 0.45)',
      border: '1px solid rgba(255, 255, 255, 0.28)',
      color: 'rgba(255, 255, 255, 0.92)',
      font: '26px/1 system-ui, sans-serif',
      padding: '0',
      zIndex: '3',
      cursor: 'pointer',
      userSelect: 'none'
    }

    /**
     * Apply a style map with `!important`.
     *
     * The display scale is injected with the same flag, and it keys off the src of the
     * very image being enlarged — an inline declaration beats a stylesheet only when it
     * carries the flag too.
     *
     * @param node - the element.
     * @param style - declarations, camelCase.
     */
    function applyImportant(node, style) {
      for (const [key, value] of Object.entries(style)) {
        const property = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
        if (typeof node.style?.setProperty === 'function') node.style.setProperty(property, value, 'important')
        else if (node.style !== undefined) node.style[key] = value
      }
    }

    /** Esc closes the overlay; the arrow keys step along the strip. */
    function onLightboxKey(event) {
      if (event?.key === 'Escape' || event?.key === 'Esc') {
        closeLightbox()
        return
      }
      if (lightboxStrip === null) return
      if (event?.key === 'ArrowLeft') lightboxStrip.show(lightboxStrip.index() - 1)
      else if (event?.key === 'ArrowRight') lightboxStrip.show(lightboxStrip.index() + 1)
      else return
      event.preventDefault?.()
    }

    /** Close the overlay, if one is open. */
    function closeLightbox() {
      if (lightboxStrip !== null) lightboxStrip = null
      if (lightbox === null) return
      lightbox.remove()
      lightbox = null
      document.removeEventListener('keydown', onLightboxKey, true)
    }

    /**
     * Show an image large, over the page, with the other renders in a strip along the top.
     *
     * The strip is the point of the overlay rather than decoration on it: comparing two
     * attempts at one prompt is the single most common thing anyone does with these
     * pictures, and without a strip that means closing this, scrolling the conversation and
     * clicking the other one. Every PNG in the output directory is one click away instead,
     * newest first, with the arrow keys walking the same list.
     *
     * @param image - the `<img>` that was clicked.
     * @param options - `{ items, index }` to walk a batch instead of the gallery. A board
     *   hands over the reply it stands for, so ← and → stay inside one answer's renders.
     * @returns the overlay, or null when there is no document to put it in.
     */
    function openLightbox(image, options) {
      closeLightbox()
      if (typeof document?.createElement !== 'function') return null
      const host = document.body ?? document.documentElement
      if (host === null || host === undefined || typeof host.append !== 'function') return null
      const source = String(image?.currentSrc ?? image?.getAttribute?.('src') ?? image?.src ?? '')
      if (source === '') return null
      // The dictionary arrives with the caller — a board and a transcript image both have one —
      // because a label is all the side handles need from it.
      const t = typeof options?.t === 'function' ? options.t : (key) => key
      const overlay = document.createElement('div')
      // Marked as a control surface, so the sweep leaves the overlay alone: it must not be
      // claimed by the display scale, and a click on it closes rather than opens again.
      overlay.setAttribute(STUDIO_MARK, 'lightbox')
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      applyImportant(overlay, LIGHTBOX_STYLE)

      const big = document.createElement('img')
      big.setAttribute('src', source)
      big.setAttribute('alt', String(image?.getAttribute?.('alt') ?? ''))
      applyImportant(big, LIGHTBOX_IMAGE_STYLE)

      const strip = document.createElement('div')
      strip.setAttribute(STUDIO_MARK, 'lightbox-strip')
      applyImportant(strip, LIGHTBOX_STRIP_STYLE)

      const count = document.createElement('div')
      applyImportant(count, LIGHTBOX_COUNT_STYLE)
      count.addEventListener('click', (event) => event.stopPropagation())

      overlay.append(strip, count, big)
      overlay.addEventListener('click', closeLightbox)
      host.append(overlay)
      lightbox = overlay

      // The picture that was clicked is in the list even when its file is already gone from
      // the output directory: the overlay must always have something to show.
      //
      // A caller that knows the neighbours hands them over instead, and then the gallery is
      // not read at all: a batch of four renders from one reply is a set the user is
      // comparing, and the two hundred files behind it are not.
      const batch = Array.isArray(options?.items) ? options.items : null
      const items = [{ url: source, name: nameFromSrc(image) }]
      const thumbs = []
      let index = 0
      if (batch !== null) {
        const rows = batch
          .map((item) => ({ url: String(item?.url ?? ''), name: String(item?.name ?? '') }))
          .filter((item) => item.url !== '')
        if (rows.length > 0) {
          items.length = 0
          for (const row of rows) items.push(row)
          const asked = Math.trunc(Number(options?.index ?? 0))
          index = Number.isFinite(asked) ? Math.max(0, Math.min(items.length - 1, asked)) : 0
        }
      }

      /**
       * The two side handles, filled once `show` exists so a click can step the same list the
       * arrow keys walk. Only a set with somewhere to go shows them.
       */
      const arrows = { prev: null, next: null }

      /** Put the item at `at` on screen, wrapping at both ends. */
      const show = (at) => {
        if (items.length === 0) return
        index = ((at % items.length) + items.length) % items.length
        big.setAttribute('src', items[index].url)
        // The right-click menu reads the name off the element first and out of the address
        // second. For a gallery file the two agree; the element's own name is what keeps
        // 「另存为」 from landing under whatever the address happens to spell.
        if (typeof items[index].name === 'string' && items[index].name !== '') {
          big.setAttribute('data-nai-name', items[index].name)
        }
        for (let i = 0; i < thumbs.length; i += 1) {
          applyImportant(thumbs[i], i === index ? LIGHTBOX_THUMB_ACTIVE : LIGHTBOX_THUMB_IDLE)
        }
        count.textContent = `${index + 1} / ${items.length}`
        // One picture is not a set: a handle that only points at itself is noise.
        const many = items.length > 1
        for (const arrow of [arrows.prev, arrows.next]) {
          if (arrow !== null) arrow.style.display = many ? '' : 'none'
        }
        const active = thumbs[index]
        if (active !== undefined && typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ block: 'nearest', inline: 'center' })
        }
      }

      /**
       * A handle on one side of the picture.
       *
       * The gallery arrives after the overlay does, so the first render can be a set of one and
       * a step later be a set of twenty; visibility follows the list rather than the moment.
       *
       * @param direction - -1 for the previous picture, 1 for the next.
       * @returns the button.
       */
      const buildArrow = (direction) => {
        const arrow = document.createElement('button')
        arrow.setAttribute('type', 'button')
        arrow.setAttribute(LIGHTBOX_ARROW_ATTR, String(direction))
        const label = t(direction < 0 ? 'zoomPrev' : 'zoomNext')
        arrow.setAttribute('aria-label', label)
        arrow.setAttribute('title', label)
        arrow.textContent = direction < 0 ? '‹' : '›'
        applyImportant(arrow, {
          ...LIGHTBOX_ARROW_STYLE,
          [direction < 0 ? 'left' : 'right']: '16px'
        })
        arrow.addEventListener('click', (event) => {
          // The backdrop closes on any click; a step must not also put the overlay away.
          event.stopPropagation()
          if (items.length <= 1) return
          show(index + direction)
        })
        // A press is not a drag on the page underneath.
        arrow.addEventListener('pointerdown', (event) => event.stopPropagation())
        overlay.append(arrow)
        return arrow
      }
      arrows.prev = buildArrow(-1)
      arrows.next = buildArrow(1)

      /** Rebuild the strip and redraw the picture. */
      const paint = () => {
        strip.replaceChildren(...thumbs)
        show(index)
      }

      /** Add one thumbnail, remembering the index it stands for. */
      const addThumb = (item) => {
        const at = thumbs.length
        const thumb = document.createElement('img')
        thumb.setAttribute('src', item.url)
        thumb.setAttribute('alt', item.name)
        thumb.setAttribute('title', item.name)
        applyImportant(thumb, { ...LIGHTBOX_THUMB_STYLE, ...LIGHTBOX_THUMB_IDLE })
        thumb.addEventListener('click', (event) => {
          // Clicking a thumbnail switches the picture; it must not also close the overlay
          // through the backdrop handler above.
          event.stopPropagation()
          show(at)
        })
        thumbs.push(thumb)
      }

      if (batch !== null && items.length > 1) {
        // A batch arrives whole, so every thumbnail is built up front and the gallery is
        // never asked for: the strip is the set the user is choosing between.
        for (const item of items) addThumb(item)
      } else {
        addThumb(items[0])
      }
      paint()
      document.addEventListener('keydown', onLightboxKey, true)
      lightboxStrip = { show, index: () => index }
      if (batch !== null) return overlay
      // The rest of the gallery comes from the host, newest first. It is written into the
      // same list, so later thumbnails behave exactly like the first one.
      api('/gallery?limit=200')
        .then((body) => {
          if (lightbox !== overlay) return
          const rows = Array.isArray(body?.files) ? body.files : []
          const current = nameFromSrc(image)
          for (const row of rows) {
            const name = String(row?.name ?? '')
            if (name === '' || name === current) continue
            const item = { url: `${API}/file?name=${encodeURIComponent(name)}`, name }
            items.push(item)
            addThumb(item)
          }
          if (items.length > 1) paint()
        })
        .catch(() => {
          // A gallery that cannot be read is not a failure: the overlay still shows the
          // picture that was clicked, which is all it promised.
        })
      return overlay
    }

    // -------------------------------------------------------- artist switcher --
    // The artist string is the one setting that changes between two attempts at the same
    // idea, and the studio window is a whole window for one button. This is that block
    // alone — the picker, the text it will send, the reference picture — and a pick is
    // written through the moment it is made. A quick switcher with a Save button would
    // just be a worse studio.

    /** The overlay showing one reference picture, if any. */
    let artistZoom = null
    /** The key handler of that overlay, so it can be taken off again. */
    let artistZoomKey = null

    /** Put the enlargement away. */
    function closeArtistZoom() {
      if (artistZoomKey !== null) {
        document.removeEventListener('keydown', artistZoomKey, true)
        artistZoomKey = null
      }
      if (artistZoom === null) return
      artistZoom.remove()
      artistZoom = null
    }

    /**
     * Show one artist reference picture over the page.
     *
     * Deliberately not `openLightbox`: that overlay carries the strip of earlier
     * renders, and beside a style guide the strip would be a lie — those pictures are
     * not other attempts at this one. Same backdrop, same key, no strip.
     *
     * @param source - the image address.
     * @param caption - what the picture is called.
     * @returns the overlay, or null when there is nothing to show.
     */
    function openArtistZoom(source, caption) {
      const url = String(source ?? '')
      if (url === '') return null
      closeArtistZoom()
      if (typeof document?.createElement !== 'function') return null
      const host = document.body ?? document.documentElement
      if (host === null || host === undefined || typeof host.append !== 'function') return null
      const overlay = document.createElement('div')
      overlay.setAttribute(STUDIO_MARK, 'artist-zoom')
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      applyImportant(overlay, { ...LIGHTBOX_STYLE, padding: '5vh 2vw', cursor: 'zoom-out' })

      const big = document.createElement('img')
      big.setAttribute('src', url)
      big.setAttribute('alt', String(caption ?? ''))
      applyImportant(big, { ...LIGHTBOX_IMAGE_STYLE, maxHeight: 'calc(100vh - 10vh)' })

      const label = document.createElement('div')
      applyImportant(label, {
        position: 'absolute',
        top: '12px',
        left: '16px',
        right: '16px',
        textAlign: 'center',
        font: '12px/1.5 system-ui, sans-serif',
        color: 'rgba(255, 255, 255, 0.82)',
        cursor: 'default'
      })
      label.textContent = String(caption ?? '')

      overlay.append(label, big)
      overlay.addEventListener('click', closeArtistZoom)
      artistZoomKey = (event) => {
        if (event?.key !== 'Escape' && event?.key !== 'Esc') return
        event.preventDefault?.()
        closeArtistZoom()
      }
      document.addEventListener('keydown', artistZoomKey, true)
      host.append(overlay)
      artistZoom = overlay
      return overlay
    }

    /** The compact switcher, if it is open. */
    let artistDock = null

    /**
     * Build the request that writes one artist id into one mode.
     *
     * `save` on the host merges the config's top level, so `modes` arrives whole or not
     * at all: sending one mode would replace the other one's overrides with nothing.
     * Hence the read first — and the filter, so that only real override fields travel
     * and the derived ones (the name, the character count) are never written back as if
     * someone had typed them.
     *
     * @param mode - `illustration` or `comic`.
     * @param id - the artist id; negative for none.
     * @returns the full `modes` object.
     */
    async function modesPatchFor(mode, id) {
      const fresh = await api('/status')
      const modes = {}
      for (const entry of fresh.modeSettings ?? []) {
        const next = {}
        for (const [key, value] of Object.entries(entry.overrides ?? {})) {
          if (!Object.prototype.hasOwnProperty.call(MODE_KEYS, key)) continue
          if (value === undefined || value === null) continue
          if (typeof value === 'number' && !Number.isFinite(value)) continue
          next[key] = value
        }
        modes[entry.mode] = next
      }
      modes[mode] = { ...(modes[mode] ?? {}), artistId: Number(id) }
      return modes
    }

    /**
     * Open the artist switcher, or repaint an already-open one.
     *
     * @param t - the bound dictionary.
     */
    async function openArtistDock(t) {
      if (artistDock !== null) {
        artistDock.root.style.display = 'flex'
        if (dockRestore !== null) dockRestore.hide?.()
        await artistDock.paint()
        return
      }
      if (dockRestore !== null) dockRestore.hide?.()
      const artists = await api('/artists?limit=500').catch(() => ({ artists: [] }))

      const root = document.createElement('div')
      root.setAttribute(STUDIO_MARK, 'dock')
      root.style.cssText =
        'position:fixed;z-index:2147483000;right:18px;bottom:70px;width:272px;' +
        'display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg,10px);' +
        'border:1px solid var(--dsw-alias-border-l1,#d0d0d5);background:var(--dsw-alias-bg-base,#fff);' +
        'color:var(--dsw-alias-label-primary,inherit);box-shadow:0 12px 40px rgba(0,0,0,0.22);font-size:12px'

      const header = document.createElement('div')
      header.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:7px 8px;flex:none;cursor:move;touch-action:none;' +
        'border-bottom:1px solid var(--dsw-alias-border-l1,#e6e6ea)'
      const title = document.createElement('span')
      title.textContent = t('dockTitle')
      title.style.cssText = 'flex:1;min-width:0;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'

      // Which mode a pick lands on. The artist string is per mode, and a window that
      // does not say which one it is about to change is a window you have to remember
      // things about — so the mode is a control here, and it flips on a press.
      const modeChip = document.createElement('button')
      modeChip.type = 'button'
      modeChip.style.cssText =
        'flex:none;height:22px;padding:0 8px;font-size:11px;cursor:pointer;border-radius:11px;' +
        'border:1px solid var(--dsw-alias-border-l1,#d0d0d5);background:transparent;color:inherit'

      const closeButton = document.createElement('button')
      closeButton.type = 'button'
      closeButton.textContent = '✕'
      closeButton.setAttribute('aria-label', t('dockTitle'))
      closeButton.style.cssText = 'flex:none;border:0;background:transparent;cursor:pointer;color:inherit;font-size:13px;padding:0 3px'

      // Re-render the newest reply from here. Switching the string is half an iteration;
      // pressing it is the other half, and the press belongs beside the picker that
      // changed it — opening the studio to reach it would defeat the window. Same act as
      // the studio's own line, so it goes through the studio's own function.
      const fireButton = document.createElement('button')
      fireButton.type = 'button'
      fireButton.textContent = `↻ ${t('dockFire')}`
      fireButton.title = t('studioFireHint')
      // The verdict has to fit a header that also holds a title, a mode chip and a close
      // button, so the label is clamped and the whole sentence goes in the tooltip.
      fireButton.style.cssText =
        'flex:none;max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'height:22px;padding:0 7px;font-size:11px;cursor:pointer;border-radius:11px;' +
        'border:1px solid var(--dsw-alias-border-l1,#d0d0d5);' +
        'background:var(--dsw-alias-fill-l1,rgba(45,108,255,0.08));color:inherit'
      let fireAt = 0
      let fireTimer = null
      /** One press, one report, then back to naming itself. */
      const fireDock = () => {
        // A double-click is two clicks, and the second would arrive on a render already
        // in flight and overwrite the verdict with "already rendering".
        if (Date.now() - fireAt < PRESS_MERGE_MS) return
        fireAt = Date.now()
        // Same reasoning as the window's own press: the dock is often the first thing pressed
        // after a reply lands, and it is the press that has to decorate what it just missed.
        const outcome = fireLatestReply(t)
        const report =
          outcome?.reason === 'clicked'
            ? `${t('studioFireStarted')}${outcome.clicked}${t('autoImageUnit')}`
            : outcome?.reason === 'busy'
              ? `${t('studioFireBusy')}（${outcome.marker}）`
              : outcome?.reason === 'spent'
                ? t('studioFireSpent')
                : t('studioFireNone')
        fireButton.textContent = outcome?.reason === 'clicked' ? `↻ ${report}` : report
        fireButton.title = report
        if (fireTimer !== null) clearTimeout(fireTimer)
        fireTimer = setTimeout(() => {
          fireTimer = null
          fireButton.textContent = `↻ ${t('dockFire')}`
          fireButton.title = t('studioFireHint')
        }, FIRE_LINE_MS)
      }
      fireButton.addEventListener('click', fireDock)
      header.append(title, fireButton, modeChip, closeButton)

      const body = document.createElement('div')
      body.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px'
      const rowWrap = document.createElement('div')
      rowWrap.style.cssText = 'display:flex;gap:8px;align-items:center'

      // The reference picture leads the window's left edge: it is the reason this window
      // has a thumbnail at all, and at 46 px in the settings window it was too small to
      // answer the question it exists for.
      const thumbButton = document.createElement('button')
      thumbButton.type = 'button'
      thumbButton.title = t('dockZoom')
      // Small on purpose: the picture is a reminder of which string is in force, not the
      // subject of the window. Big enough to recognise, small enough that the picker is
      // what the eye lands on — and a press still opens it full size.
      thumbButton.style.cssText =
        'flex:none;width:42px;height:54px;padding:0;border:1px solid var(--dsw-alias-border-l1,#e2e2e6);' +
        'border-radius:4px;overflow:hidden;background:var(--dsw-alias-fill-l1,#eee);cursor:zoom-in;' +
        'display:flex;align-items:center;justify-content:center'
      const thumb = document.createElement('img')
      thumb.alt = ''
      thumb.loading = 'lazy'
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover;display:none'
      const thumbEmpty = document.createElement('span')
      thumbEmpty.textContent = '—'
      thumbEmpty.style.cssText = 'font-size:16px;opacity:0.4'
      thumbButton.append(thumb, thumbEmpty)

      const side = document.createElement('div')
      side.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px'
      const sideLabel = document.createElement('div')
      sideLabel.textContent = t('studioArtist')
      sideLabel.style.cssText = 'font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#888)'

      const pickWrap = document.createElement('div')
      pickWrap.style.cssText = 'position:relative'
      const trigger = document.createElement('button')
      trigger.type = 'button'
      trigger.setAttribute('aria-haspopup', 'listbox')
      trigger.setAttribute('aria-expanded', 'false')
      trigger.style.cssText =
        `${STUDIO_INPUT};display:flex;align-items:center;gap:6px;cursor:pointer;text-align:left;font-size:12px`
      const triggerText = document.createElement('span')
      triggerText.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      const caret = document.createElement('span')
      caret.textContent = '▾'
      caret.style.cssText = 'flex:none;opacity:0.55'
      trigger.append(triggerText, caret)

      const popup = document.createElement('div')
      // Anchored to the right edge so a long list opens leftwards, inside the viewport,
      // rather than off the right side of a window that is already in the corner.
      popup.style.cssText =
        'position:absolute;top:calc(100% + 3px);right:0;width:236px;z-index:40;display:none;max-height:250px;' +
        'overflow-y:auto;padding:4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d0d0d5);' +
        'background:var(--dsw-alias-bg-base,#fff);box-shadow:0 10px 28px rgba(0,0,0,0.22)'
      // A press in the list must not be taken by the window drag — `setPointerCapture`
      // retargets the whole gesture, the click included, to the root.
      popup.setAttribute('data-no-window-gesture', '')
      const filter = document.createElement('input')
      filter.type = 'text'
      filter.placeholder = t('artistFavSearch')
      filter.style.cssText =
        `${STUDIO_INPUT};width:100%;position:sticky;top:0;z-index:1;margin-bottom:4px;` +
        'background:var(--dsw-alias-bg-base,#fff)'
      const list = document.createElement('div')
      list.setAttribute('role', 'listbox')
      // One line that can say what a star did. It sits above the list rather than under the
      // window, so the window itself stays exactly one row tall.
      const hint = document.createElement('div')
      hint.textContent = t('artistFavHint')
      hint.style.cssText =
        'padding:0 2px 4px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#888)'
      popup.append(filter, hint, list)
      pickWrap.append(trigger, popup)
      side.append(sideLabel, pickWrap)
      rowWrap.append(thumbButton, side)

      // One row, and nothing under it. This window is a switcher, so the 「生效文本」 block the
      // studio carries is not repeated here: the string itself is what the studio is for, and
      // a window whose whole job is one press should not be two thirds reading matter. What a
      // pick owes back is only whether it landed, and that is said on the control that was
      // pressed rather than in a line that makes the window taller.
      body.append(rowWrap)

      /** The entry in force, as `/status` last answered. */
      let current = null
      /** Which mode a pick lands on; settled from the host on the first paint. */
      let active = null
      /** Set while a pick is being written, so two presses cannot race. */
      let busy = false
      let pickerOpen = false
      /** The timer that puts the trigger's own label back after it reported something. */
      let flashTimer = null
      /** What the trigger says when it is not reporting a press. */
      let restingText = ''

      /** How the picker names what is in force. */
      const pickLabel = () => {
        const id = Number(current?.artistId ?? -1)
        if (id < 0) return t('artistNone')
        const name = current?.artistName
        return name === null || name === undefined || name === '' ? `#${id}` : `#${id} ${name}`
      }

      /** Say something on the trigger itself, then go back to naming the pick. */
      const flash = (text, tone, holdMs) => {
        if (flashTimer !== null) {
          clearTimeout(flashTimer)
          flashTimer = null
        }
        triggerText.textContent = text
        trigger.style.borderColor =
          tone === 'bad' ? '#d9534f' : tone === 'good' ? '#3c9d5d' : 'var(--dsw-alias-border-l1,#d0d0d5)'
        if (holdMs === 0) return
        flashTimer = setTimeout(() => {
          flashTimer = null
          trigger.style.borderColor = 'var(--dsw-alias-border-l1,#d0d0d5)'
          triggerText.textContent = restingText
        }, holdMs ?? 1600)
      }

      /** Put the picker's own label back, unless a press is still being reported. */
      const restTrigger = () => {
        restingText = pickLabel()
        if (flashTimer === null) triggerText.textContent = restingText
      }

      /** Say which mode the next pick lands on. */
      const paintMode = () => {
        const entry = STUDIO_MODES.find((mode) => mode.key === active) ?? STUDIO_MODES[0]
        modeChip.textContent = entry.label
      }

      /** Show the reference picture, or the empty mark when there is none. */
      const paintThumb = () => {
        const id = Number(current?.artistId ?? -1)
        if (id < 0) {
          thumb.style.display = 'none'
          thumb.removeAttribute('src')
          thumbEmpty.style.display = ''
          thumbButton.style.cursor = 'default'
          return
        }
        thumb.setAttribute('src', `${API}/artist-image?id=${id}`)
        thumb.style.display = 'block'
        thumbEmpty.style.display = 'none'
        thumbButton.style.cursor = 'zoom-in'
      }

      /**
       * One row of the list: the entry, and the star that decides the order it leads.
       *
       * The star is here for the same reason it is in the studio — a curated handful has
       * to come first — and it behaves the same way: it is not a pick.
       */
      const buildRow = (row) => {
        const item = document.createElement('div')
        item.setAttribute('role', 'option')
        item.setAttribute('data-artist-id', String(row.id))
        const chosen = Number(current?.artistId ?? -1) === Number(row.id)
        item.setAttribute('aria-selected', chosen ? 'true' : 'false')
        item.tabIndex = 0
        item.style.cssText =
          'display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;cursor:pointer;' +
          'line-height:18px;font-size:12px' +
          (chosen ? ';background:var(--dsw-alias-fill-l1,rgba(45,108,255,0.10))' : '')
        const text = document.createElement('span')
        text.style.cssText = 'flex:1;min-width:0;word-break:break-word'
        text.textContent = row.name === undefined || row.name === null || row.name === '' ? `#${row.id}` : `#${row.id} ${row.name}`
        item.append(text)
        // The 「none」 row is not an entry in the archive, so there is nothing to curate about
        // not using a string, and it carries no star.
        if (Number(row.id) >= 0) {
          const star = document.createElement('button')
          star.type = 'button'
          star.textContent = row.favorite === true ? '★' : '☆'
          star.title = row.favorite === true ? t('artistFavRemove') : t('artistFavAdd')
          star.setAttribute('aria-pressed', row.favorite === true ? 'true' : 'false')
          star.style.cssText =
            'flex:none;border:0;background:transparent;cursor:pointer;font-size:15px;line-height:18px;padding:0 2px;' +
            `color:${row.favorite === true ? '#e8a800' : 'var(--dsw-alias-label-tertiary,#8a8a90)'}`
          // Starring is not picking: stopping the event is the whole difference, and the
          // row's own handler never sees this click.
          star.addEventListener('click', (event) => {
            event?.stopPropagation?.()
            event?.preventDefault?.()
            starring(row)
          })
          item.append(star)
        }
        item.addEventListener('click', () => applying(row.id, row.name ?? null))
        item.addEventListener('keydown', (event) => {
          if (event?.key !== 'Enter' && event?.key !== ' ') return
          event.preventDefault?.()
          applying(row.id, row.name ?? null)
        })
        return item
      }

      /**
       * Write one star, and say what came of it.
       *
       * The order is decided when the list opens and never under the pointer: a list that
       * re-sorted on the click that starred something would hand the next click to a
       * different entry. That is the studio's rule, and this window keeps it exactly.
       */
      const starring = async (row) => {
        const want = row.favorite !== true
        try {
          const body = await api('/artist-favorite', {
            method: 'POST',
            body: JSON.stringify({ id: Number(row.id), favorite: want })
          })
          row.favorite = (body.favorites ?? []).map((value) => Number(value)).includes(Number(row.id))
          hint.textContent = row.favorite === true ? t('artistFavSaved') : t('artistFavCleared')
          paintList()
        } catch {
          hint.textContent = t('artistFavFailed')
        }
      }

      /** Draw the list, filtered by the box. */
      const paintList = () => {
        list.replaceChildren()
        const needle = String(filter.value ?? '')
          .trim()
          .toLowerCase()
        // Clearing the pick has to be one press away, so "none" is a row like any other
        // rather than a state you reach by picking something else.
        const noneRow = { id: -1, name: t('artistNone') }
        const rows = [noneRow, ...(artists.artists ?? [])].filter(
          (row) => needle === '' || `#${row.id} ${row.name}`.toLowerCase().includes(needle)
        )
        if (rows.length === 0) {
          const empty = document.createElement('div')
          empty.style.cssText = 'padding:6px 4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)'
          empty.textContent = t('artistFavNone')
          list.append(empty)
          return
        }
        for (const row of rows) list.append(buildRow(row))
      }

      const openPicker = () => {
        artists.artists = favoriteFirst(artists.artists)
        hint.textContent = t('artistFavHint')
        paintList()
        pickerOpen = true
        popup.style.display = 'block'
        trigger.setAttribute('aria-expanded', 'true')
        filter.focus?.()
      }

      const closePicker = () => {
        pickerOpen = false
        popup.style.display = 'none'
        trigger.setAttribute('aria-expanded', 'false')
        filter.value = ''
      }

      /**
       * Write one pick through, and say what came of it.
       *
       * This is the whole difference between this window and the studio: there is no
       * draft to save. The host is written first and the window then re-reads it, so what
       * is on screen is what the next render will use — a window that showed the pick
       * before the write succeeded would be lying exactly when it matters.
       */
      const applying = async (id, name) => {
        if (busy) return
        busy = true
        closePicker()
        trigger.disabled = true
        flash(`${t('dockApplying')}…`, 'idle', 0)
        try {
          const modes = await modesPatchFor(active ?? 'illustration', id)
          await api('/config', { method: 'POST', body: JSON.stringify({ modes }) })
          await paint()
          flash(`${t('dockApplied')} ✓`, 'good', 1400)
          // The settings window holds its own copy of the pick; if it is open it has to
          // follow, or the two windows disagree about what the next render will use.
          if (typeof refreshStudioArtist === 'function') refreshStudioArtist()
        } catch (error) {
          flash(`${t('dockFailed')}：${error.message}`, 'bad', 4000)
        } finally {
          busy = false
          trigger.disabled = false
        }
      }

      /** Re-read the host and repaint everything this window shows. */
      const paint = async () => {
        let status
        try {
          status = await api('/status')
        } catch (error) {
          // Nothing was picked out of the list here; the picker is the only thing this
          // window shows, so the trigger is where the failure goes.
          flash(`${t('studioFailed')}：${error.message}`, 'bad', 4000)
          return
        }
        if (active === null) active = String(status.mode ?? '') === 'comic' ? 'comic' : 'illustration'
        current = { ...((status.modeSettings ?? []).find((row) => row.mode === active) ?? {}) }
        restTrigger()
        paintMode()
        paintThumb()
      }

      modeChip.addEventListener('click', () => {
        active = active === 'comic' ? 'illustration' : 'comic'
        paint().catch(() => {})
      })
      trigger.addEventListener('click', () => {
        if (pickerOpen) closePicker()
        else openPicker()
      })
      filter.addEventListener('input', () => paintList())
      popup.addEventListener('keydown', (event) => {
        if (event?.key !== 'Escape') return
        event.preventDefault?.()
        closePicker()
      })
      root.addEventListener('click', (event) => {
        if (pickerOpen !== true) return
        const target = event?.target
        if (typeof pickWrap.contains === 'function') {
          if (pickWrap.contains(target)) return
        } else if (target === trigger || target === filter || target === list) {
          return
        }
        closePicker()
      })
      thumbButton.addEventListener('click', () => {
        const id = Number(current?.artistId ?? -1)
        if (id < 0) return
        openArtistZoom(`${API}/artist-image?id=${id}`, pickLabel())
      })
      closeButton.addEventListener('click', () => {
        root.remove()
        artistDock = null
        refreshArtistDock = null
        // Dismissing is not the same as being gone: the way back takes its place, so the
        // switcher can be put away for an afternoon without being lost for the session.
        if (dockRestore !== null) dockRestore.show?.()
      })
      // The window is not modal, so Escape may belong to whatever has focus — it only
      // closes this one, and only when the picker is already shut, which keeps the key
      // doing what the open list says it does.
      root.addEventListener('keydown', (event) => {
        if (event?.key !== 'Escape' && event?.key !== 'Esc') return
        if (pickerOpen) return
        event.preventDefault?.()
        closeButton.click()
      })

      // Dragging, on the same terms as the studio window: the whole window is the
      // handle, minus the controls, and every edge keeps a grabbable sliver.
      const DRAG_IGNORE = 'input,select,textarea,button,a,[contenteditable="true"],[data-no-window-gesture]'
      let dragging = null
      root.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return
        const target = event.target
        if (typeof target?.closest === 'function' && target.closest(DRAG_IGNORE) !== null) return
        const rect = root.getBoundingClientRect()
        dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
        root.style.right = 'auto'
        root.style.bottom = 'auto'
        root.style.left = `${Math.round(rect.left)}px`
        root.style.top = `${Math.round(rect.top)}px`
        if (typeof root.setPointerCapture === 'function') {
          try {
            root.setPointerCapture(event.pointerId)
          } catch {}
        }
        event.preventDefault()
      })
      root.addEventListener('pointermove', (event) => {
        if (dragging === null) return
        if (event.pointerId !== undefined && event.pointerId !== dragging.id) return
        const step = (value, min, max) => Math.max(min, Math.min(max, value))
        const width = root.offsetWidth || 272
        const viewportWidth = window.innerWidth || width
        const viewportHeight = window.innerHeight || 600
        const nextLeft = step(dragging.left + (event.clientX - dragging.x), 60 - width, viewportWidth - 60)
        const nextTop = step(dragging.top + (event.clientY - dragging.y), 0, viewportHeight - 40)
        root.style.left = `${Math.round(nextLeft)}px`
        root.style.top = `${Math.round(nextTop)}px`
      })
      const endDrag = (event) => {
        if (dragging === null) return
        if (event?.pointerId !== undefined && event.pointerId !== dragging.id) return
        if (typeof root.releasePointerCapture === 'function') {
          try {
            root.releasePointerCapture(dragging.id)
          } catch {}
        }
        dragging = null
      }
      root.addEventListener('pointerup', endDrag)
      root.addEventListener('pointercancel', endDrag)

      root.append(header, body)
      document.body.append(root)
      refreshArtistDock = () => {
        if (artistDock === null) return
        artistDock.paint()
      }
      artistDock = { root, paint }
      await paint()
    }

    /**
     * Inject the sizing stylesheet and wire click-to-enlarge.
     * @param t - the bound dictionary.
     * @returns a disposer.
     */
    function installImageSizing(t) {
      if (
        typeof document === 'undefined' ||
        typeof document.createElement !== 'function' ||
        typeof document.querySelector !== 'function'
      ) {
        return () => {}
      }
      // A real document always has a head; the check keeps activation from throwing
      // in a host that has no DOM, which is also how the test harness runs this.
      const head = document.head ?? document.body
      if (head === null || head === undefined || typeof head.append !== 'function') return () => {}
      let style = document.querySelector(`style[${STUDIO_MARK}="sizing"]`)
      if (style === null) {
        style = document.createElement('style')
        style.setAttribute(STUDIO_MARK, 'sizing')
        head.append(style)
      }

      /** Whether a click enlarges, mirrored from the config so the handler can read it. */
      let clickZoomOn = true

      /** Re-read the setting from the host and repaint the rules. */
      const refresh = async () => {
        try {
          const status = await api('/status')
          imageMatch = String(status.display?.match ?? '_out/nai/')
          clickZoomOn = status.display?.clickZoom !== false
          style.textContent = buildImageSizingCss(status.display)
        } catch {
          // A failed read keeps the last good rules rather than clearing them.
        }
        // The rules only reach images that carry a mark, so sweep as part of the repaint:
        // a scale saved a second ago has to apply to the image on screen. The same pass is
        // the moment to notice an image whose address stopped resolving.
        sweepImages()
        sweepBrokenImages()
      }

      // Sweeping once is not enough. An image arrives as a new node, and its size is
      // unknown until the bitmap decodes — `load` does not bubble, so it is caught in
      // the capture phase, while new nodes come from the observer. Both funnel into one
      // debounced pass, because scrolling a transcript fires mutations continuously.
      let sweepPending = false
      const sweepSoon = () => {
        if (sweepPending) return
        sweepPending = true
        const run = () => {
          sweepPending = false
          sweepImages()
          sweepBrokenImages()
        }
        if (typeof setTimeout === 'function') setTimeout(run, 120)
        else run()
      }
      const observer =
        typeof MutationObserver === 'function' && document.body !== null && document.body !== undefined
          ? new MutationObserver(sweepSoon)
          : null
      if (observer !== null && typeof observer.observe === 'function') {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src']
        })
      }
      document.addEventListener('load', sweepSoon, true)

      const onClick = (event) => {
        const target = event.target
        if (target === null || target === undefined) return
        if (String(target.tagName ?? '').toUpperCase() !== 'IMG') return
        if (!clickZoomOn) return
        // Decided live, so a click that lands before the sweep still enlarges the image
        // it hit — and any content image qualifies, not only this plugin's renders.
        if (!isZoomableImage(target)) return
        // A board thumbnail carries its own batch, and opens it in its own handler. Enlarging
        // it here as well would open the gallery of every file over that batch a moment later.
        if (typeof target.getAttribute === 'function' && target.getAttribute(BOARD_CLICK_ATTR) === '1') return
        // The transcript may wrap the image in a link; enlarging is this click's job,
        // and the right-click menu still offers save-as.
        event.preventDefault()
        // An overlay, not a resize in place: the picture keeps the size the conversation
        // gave it, and nothing on the page moves.
        openLightbox(target, { t })
      }

      /** A transcript image whose address stopped resolving is served by us instead. */
      const onImageError = (event) => {
        const target = event.target
        if (target === null || target === undefined) return
        if (String(target.tagName ?? '').toUpperCase() !== 'IMG') return
        repairBrokenImage(target)
      }

      document.addEventListener('click', onClick, true)
      // `error` does not bubble, so the capture phase is how a failed `<img>` is heard.
      document.addEventListener('error', onImageError, true)
      sweepImages()
      sweepBrokenImages()
      refreshImageSizing = refresh
      refresh()
      return () => {
        document.removeEventListener('click', onClick, true)
        document.removeEventListener('error', onImageError, true)
        document.removeEventListener('load', sweepSoon, true)
        if (observer !== null) observer.disconnect()
        if (refreshImageSizing === refresh) refreshImageSizing = null
        closeLightbox()
        style.remove()
      }
    }

    // ── the reply tool ────────────────────────────────────────────────────────
    //
    // The Host registers `nai_reply`; this half owns how its call is shown, and that is two
    // jobs rather than one:
    //
    //   * the call's row in the process fold is a receipt — what it says is that a reply went
    //     through, how much text and what caption;
    //   * the reply itself is painted into the turn's answer area, which is where a reader
    //     looks for it. The row lives inside the turn's process fold, and that fold is shut
    //     until it is opened; a reply left in its own row would be a reply behind a door.
    //
    // The text is read from the call's own arguments — `block.argsRaw` while the call is being
    // written, `block.call.argsRaw` once it has a result — so no second channel exists: no
    // route of its own, no poll, no copy on disk. The row's `data-chat-call-id` is the handle
    // both jobs share, and `[data-chat-turn]` on the flow item above it is how the answer area
    // is found again from a row that is not its child.

    /** The wire name this half draws. One string, so the doctor can compare the halves. */
    const REPLY_TOOL_NAME = 'nai_reply'
    /** Marks a reply painted into the transcript, so a sweep finds its own work. */
    const REPLY_ATTR = 'data-nai-reply'
    /** Marks the receipt row inside the fold. */
    const REPLY_ROW_ATTR = 'data-nai-reply-row'
    /** The style tag this half owns, so a reload does not stack stylesheets. */
    const REPLY_STYLE_ID = 'dsh-nai-imagegen-replies'
    /** How long between attempts to place a reply whose turn has nowhere to put it yet. */
    const REPLY_RETRY_MS = 400
    /**
     * How many attempts are made before a reply is placed beside its own row instead.
     *
     * The wait is for the turn's answer area, which appears when the turn ends; a turn that is
     * still running has genuinely nowhere to put a reply. Sixteen seconds is far longer than
     * that takes on any transcript, and running out is not a failure — the fallback below puts
     * the text next to the call, where it is read with the fold open.
     */
    const REPLY_RETRIES = 40
    /** Marks a reply the turn had already written out as message text, so it is not shown twice. */
    const REPLY_DUPLICATE_ATTR = 'data-nai-reply-duplicate'
    /** How much of a reply has to match the turn's own text before the plain copy is called the same one. */
    const REPLY_PLAIN_HEAD = 24
    /** Below this length a reply and the turn's own text have to be the same words, not a match of the head. */
    const REPLY_PLAIN_MIN = 12
    /**
     * How many turns in a row may answer without calling the tool before the panel says so.
     *
     * A model that ignores the tool is not an error — the answer simply arrives as ordinary text,
     * and nothing is lost. But the reader should be told that the transport is not being used,
     * rather than wondering why the receipt line never appears. Three is what the tavern
     * transports settled on for the same judgement.
     */
    const REPLY_MISS_LIMIT = 3

    /**
     * The dictionary the painted caption line is written in.
     *
     * The painted node is plain DOM, outside the React tree the locale binding lives in, so the
     * binder has to be handed down: `installReplies` takes it from `apply` and keeps it here.
     */
    let replyT = (key) => key

    /**
     * Replies read from tool calls, by call id.
     *
     * Held outside React on purpose: a replay unmounts the rows and puts them back, and the
     * text has to be paintable when they return. Nothing sweeps an entry out — a session's
     * replies are its own words, already on screen, and this map is the only record that the
     * answer area said them.
     */
    const replies = new Map()
    /** The node painted for each reply, and the text it was painted from. */
    const paintedReplies = new Map()
    /** The pending retry chain, so a burst of rows arms one chain rather than one each. */
    let replyRetryTimer = null
    /**
     * Whether a chain is armed, kept apart from its timer handle.
     *
     * The handle is assigned from `setTimeout`'s return value, which in a host that runs timers
     * synchronously — a test harness, or a stubbed clock — lands *after* the callback has already
     * cleared it, and the chain would then believe itself armed forever. The flag is set before
     * the timer is asked for, so a synchronous callback sees the truth.
     */
    let replyRetryArmed = false
    /** How many attempts the chain currently running has made. */
    let replyRetryCount = 0
    /** How many turns in a row have answered without this tool, and the last turn counted. */
    let replyMissStreak = 0
    let replyLastTurn = null

    /**
     * Whether the host says the reply transport is switched on.
     *
     * Read by two different things: the panel draws its button from the host's own answer, and
     * the streak below has to know. A transport that is switched off answers no turn at all, so
     * counting "turns that did not call the tool" against it would report a fault that is really
     * a setting — the switch arguing with the thing it switches. Unknown reads as on, which is
     * what the host ships.
     */
    let replyTransportOn = true

    /**
     * Take the switch's position as the host reports it.
     *
     * Called the moment the host has confirmed a change, and by the activation read — not by a
     * poll, because a switch nobody touched has not moved. Turning it off retires the streak with
     * it: those turns were counted against a tool that is no longer in the list.
     *
     * @param on - what the host reports.
     * @returns the position after this call.
     */
    function setReplyTransport(on) {
      replyTransportOn = on === true
      if (replyTransportOn !== true) {
        replyMissStreak = 0
        replyLastTurn = null
      }
      return replyTransportOn
    }

    /**
     * Learn the switch's position without asking the panel.
     *
     * The panel is mounted only while this plugin's page is the active view, so a page that
     * loaded with the transport off would otherwise keep its own guess. An answer that cannot be
     * read leaves the guess alone: the setting is the host's, and a page that has lost its host
     * must never decide on its own that the transport is off.
     *
     * @returns a promise that settles once the read is done.
     */
    async function bootReplyTransport() {
      try {
        const status = await api('/status')
        if (typeof status?.replyTransport === 'boolean') setReplyTransport(status.replyTransport)
      } catch {
        // No answer is not a no.
      }
    }

    /**
     * Quote a value for a selector, so a call id can never end the selector early.
     * @param value - anything with a `toString`.
     * @returns the value inside double quotes, with quotes and backslashes escaped.
     */
    function quoteForSelector(value) {
      return `"${String(value).replace(/(["\\])/g, '\\$1')}"`
    }

    /**
     * The Tool package's own row element for a call.
     *
     * It is the Tool half that renders this wrapper, and it carries the call id — which is why
     * this half can find a call it did not render, and why the handle survives a replay that
     * rebuilt every element around it.
     *
     * @param callId - the call id.
     * @returns the row, or null when that call is not on screen.
     */
    function replyRowFor(callId) {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
      const key = String(callId ?? '')
      if (key === '') return null
      return document.querySelector(`[data-chat-call-id=${quoteForSelector(key)}]`)
    }

    /**
     * Pull a reply out of a call's raw arguments.
     *
     * While the call is being written the argument string is not JSON yet, and that is the
     * ordinary first render of a long reply: the parse fails, nothing is registered, and the
     * receipt row reports how much has arrived so far. The full string comes twice — once when
     * the call is dispatched, once with its result — and either is enough to paint from, which
     * also means a transcript replayed from the log paints without the Host being asked
     * anything.
     *
     * @param raw - the raw argument text, possibly half written.
     * @returns `{ text, label, complete }`.
     */
    function parseReplyArgs(raw) {
      const source = typeof raw === 'string' ? raw : ''
      if (source.trim() === '') return { text: '', label: null, complete: false }
      let parsed = null
      try {
        parsed = JSON.parse(source)
      } catch {
        return { text: '', label: null, complete: false }
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { text: '', label: null, complete: false }
      }
      const label = typeof parsed.label === 'string' ? parsed.label.trim() : ''
      return {
        text: typeof parsed.text === 'string' ? parsed.text : '',
        label: label === '' ? null : label,
        complete: true
      }
    }

    /**
     * The argument string a call carries, from whichever stage of its life it is in.
     *
     * The three stages differ in where the arguments live: a preparing call has no `kind` and
     * streams its arguments through the slot's partial hook, a dispatched call carries
     * `argsRaw` itself, and a settled result nests the originating call under `call`.
     */
    function replyRawArguments(call, partial) {
      const block = call?.block
      let raw = ''
      if (block !== null && block !== undefined && typeof block === 'object') {
        if ('kind' in block) {
          raw = typeof block.call?.argsRaw === 'string' ? block.call.argsRaw : ''
        } else if (typeof block.argsRaw === 'string') {
          raw = block.argsRaw
        }
      }
      if (raw === '' && typeof partial === 'string') raw = partial
      return raw
    }

    /**
     * What one call says, read from the row's props.
     *
     * When the argument string is not JSON yet — the ordinary first render of a long reply, and
     * every render after it until the call is dispatched — the prose that has already arrived is
     * read straight out of the fragment instead of being left until later. That is what makes
     * the answer area fill as the model writes, rather than staying empty for the whole of a
     * long reply and then appearing in one piece.
     *
     * @param call - the phase-discriminated call the Tool row hands its view.
     * @param partial - the argument prefix the slot's hook offers during `preparing`.
     * @returns `{ raw, text, label, complete, pending }`.
     */
    function replyFromCall(call, partial) {
      const raw = replyRawArguments(call, partial)
      const parsed = parseReplyArgs(raw)
      if (parsed.complete) {
        return { raw, text: parsed.text, label: parsed.label, complete: true, pending: false }
      }
      const growing = readPartialText(raw)
      return { raw, text: growing.text, label: null, complete: false, pending: growing.pending }
    }

    /**
     * Read four hex digits as a code point.
     * @param source - the fragment being read.
     * @param start - where the four digits would begin.
     * @returns the code, or null when the four digits are not all here yet.
     */
    function replyHexAt(source, start) {
      const hex = source.slice(start, start + 4)
      if (hex.length < 4 || /[^0-9a-fA-F]/.test(hex)) return null
      return parseInt(hex, 16)
    }

    /**
     * Read the `text` value out of an argument string that is still being written.
     *
     * A reply that arrives as a function argument arrives in fragments, and a fragment can end
     * in the middle of an escape sequence — which is the one lesson worth taking from the
     * anti-truncation transports the tavern scripts use, where the whole reply is decoded out of
     * `function.arguments` as it streams past. A half sequence is never guessed at: it is held
     * back until the rest of it arrives, because a backslash-u shown as prose would be swapped
     * for its real character a moment later, and a surrogate half shown on its own is a ruined
     * character. Nothing is thrown away either: whatever is left unread is handed back as
     * `pending`, so the caller can say the reply is still being written rather than pretend it
     * finished.
     *
     * Escapes that nobody defined come back as the two characters they were written as, which is
     * what the transports do with them and what a reader would rather see than a lost character.
     *
     * @param raw - the raw argument prefix.
     * @returns `{ text, complete, pending }` — the prose so far, whether the value was closed,
     *   and whether the fragment stopped inside an escape or a half-arrived character pair.
     */
    function readPartialText(raw) {
      const source = typeof raw === 'string' ? raw : ''
      const opening = /"text"\s*:\s*"/.exec(source)
      if (opening === null) return { text: '', complete: false, pending: false }
      let index = opening.index + opening[0].length
      let text = ''
      while (index < source.length) {
        const ch = source[index]
        if (ch === '"') return { text, complete: true, pending: false }
        if (ch !== '\\') {
          index += 1
          text += ch
          continue
        }
        // A backslash on the last character is the beginning of something, not a character.
        if (index + 1 >= source.length) return { text, complete: false, pending: true }
        const marker = source[index + 1]
        if (marker === 'u') {
          const code = replyHexAt(source, index + 2)
          if (code === null) return { text, complete: false, pending: true }
          if (code >= 0xd800 && code <= 0xdbff) {
            // A high half belongs with the low half after it. If the fragment stops here the
            // pair may still be on its way; if the next escape is anything but a low half, the
            // pair can never arrive and this half goes out as the lone character it is.
            if (index + 6 >= source.length) return { text, complete: false, pending: true }
            const pair =
              source[index + 6] === '\\' && source[index + 7] === 'u' ? replyHexAt(source, index + 8) : null
            if (pair !== null && pair >= 0xdc00 && pair <= 0xdfff) {
              text += String.fromCodePoint(65536 + ((code - 0xd800) << 10) + (pair - 0xdc00))
              index += 12
              continue
            }
            text += String.fromCharCode(code)
            index += 6
            continue
          }
          text += String.fromCharCode(code)
          index += 6
          continue
        }
        if (marker === '"') text += '"'
        else if (marker === '\\') text += '\\'
        else if (marker === '/') text += '/'
        else if (marker === 'b') text += '\b'
        else if (marker === 'f') text += '\f'
        else if (marker === 'n') text += '\n'
        else if (marker === 'r') text += '\r'
        else if (marker === 't') text += '\t'
        else text += ch + marker
        index += 2
      }
      return { text, complete: false, pending: false }
    }

    /**
     * How much of a half-written argument string is already prose.
     *
     * The count the receipt row shows while the model is still writing. It is counted in code
     * points, so an emoji or a CJK character is one character and not two, and it is the length
     * of the prose the fragment has actually delivered rather than the length of the fragment.
     *
     * @param raw - the raw argument prefix.
     * @returns the number of characters inside the `text` value so far.
     */
    function partialReplyChars(raw) {
      return Array.from(readPartialText(raw).text).length
    }

    /** Inline emphasis markers, longest first: `**` has to win over `*`. */
    const REPLY_EMPHASIS = [
      { marker: '**', tag: 'strong' },
      { marker: '__', tag: 'strong' },
      { marker: '~~', tag: 'del' },
      { marker: '*', tag: 'em' },
      { marker: '_', tag: 'em' }
    ]

    /**
     * A destination worth writing into an anchor.
     *
     * A reply is model output, and `javascript:` or a `data:` payload in a link would be a
     * script in the transcript. Plain links and relative paths are kept; everything else stays
     * the text it was written as.
     *
     * @param href - the raw destination.
     * @returns the destination, or null when this half will not render it as one.
     */
    function replyHref(href) {
      const value = String(href ?? '').trim()
      if (value === '') return null
      return /^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i.test(value) ? value : null
    }

    /**
     * Find one emphasis run starting at an index.
     * @param source - the line being read.
     * @param index - where the marker would start.
     * @returns `{ tag, inner, length }`, or null when there is no emphasis here.
     */
    function replyEmphasisAt(source, index) {
      for (const rule of REPLY_EMPHASIS) {
        const { marker, tag } = rule
        if (source.slice(index, index + marker.length) !== marker) continue
        const close = source.indexOf(marker, index + marker.length)
        if (close === -1) continue
        const inner = source.slice(index + marker.length, close)
        if (inner.trim() === '') continue
        // `_` inside a word is a name and not emphasis: `snake_case` stays a word, while
        // `_this_` is emphasis. The rule is the usual one — a marker against a word character
        // on the inside, with a word character on the outside, is spelling.
        if (marker.startsWith('_')) {
          const before = index === 0 ? ' ' : source[index - 1]
          const after = source[close + marker.length] ?? ' '
          if (/\w/.test(before) && /\w/.test(inner[0])) continue
          if (/\w/.test(inner[inner.length - 1]) && /\w/.test(after)) continue
        }
        return { tag, inner, length: close + marker.length - index }
      }
      return null
    }

    /**
     * Split one line of a reply into inline nodes.
     *
     * The app's own Markdown renderer is not reachable from this half — a plugin's `require`
     * resolves the frozen platform table plus what its `dsh.client.inject` names, and neither
     * carries it — so the inline grammar a reply actually uses is read here: code spans,
     * emphasis, strikethrough, links and backslash escapes. Anything else is text, which is the
     * honest result for a reader this small.
     *
     * @param text - one line or paragraph, without its block markers.
     * @returns nodes: `{ tag, attrs, children }` for markup, `{ text }` for literal prose.
     */
    function replyInline(text) {
      const source = String(text ?? '')
      const nodes = []
      let buffer = ''
      let index = 0
      const flush = () => {
        if (buffer === '') return
        nodes.push({ text: buffer })
        buffer = ''
      }
      while (index < source.length) {
        const ch = source[index]
        if (ch === '\\' && index + 1 < source.length) {
          buffer += source[index + 1]
          index += 2
          continue
        }
        if (ch === '`') {
          const fence = /^`+/.exec(source.slice(index))[0]
          const close = source.indexOf(fence, index + fence.length)
          if (close !== -1) {
            flush()
            nodes.push({
              tag: 'code',
              attrs: { class: 'nai-reply-inline-code' },
              children: [{ text: source.slice(index + fence.length, close).trim() }]
            })
            index = close + fence.length
            continue
          }
        }
        if (ch === '[') {
          const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(source.slice(index))
          const href = link === null ? null : replyHref(link[2])
          if (link !== null && href !== null) {
            flush()
            nodes.push({
              tag: 'a',
              attrs: { href, target: '_blank', rel: 'noreferrer noopener' },
              children: replyInline(link[1])
            })
            index += link[0].length
            continue
          }
        }
        const emphasis = replyEmphasisAt(source, index)
        if (emphasis !== null) {
          flush()
          nodes.push({ tag: emphasis.tag, attrs: {}, children: replyInline(emphasis.inner) })
          index += emphasis.length
          continue
        }
        buffer += ch
        index += 1
      }
      flush()
      return nodes
    }

    /**
     * Split one table row into trimmed cells.
     * @param line - the row.
     * @returns the cell texts.
     */
    function replyTableCells(line) {
      return String(line)
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((cell) => cell.trim())
    }

    /**
     * Read a pipe table when one starts at a line.
     * @param lines - every line of the reply.
     * @param start - the index to try.
     * @returns `{ block, next }`, or null when this is not a table.
     */
    function replyTableAt(lines, start) {
      const header = lines[start]
      const separator = lines[start + 1]
      if (header === undefined || separator === undefined) return null
      if (!header.includes('|')) return null
      if (!separator.includes('-')) return null
      if (!/^\s{0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(separator)) return null
      const head = replyTableCells(header)
      const align = replyTableCells(separator).map((cell) => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        if (left) return 'left'
        return null
      })
      const rows = []
      let index = start + 2
      while (index < lines.length && lines[index].includes('|') && !/^\s*$/.test(lines[index])) {
        rows.push(replyTableCells(lines[index]))
        index += 1
      }
      const cell = (text, column, tag) => ({
        tag,
        attrs: align[column] === null || align[column] === undefined ? {} : { style: `text-align:${align[column]}` },
        children: replyInline(text)
      })
      return {
        block: {
          tag: 'table',
          attrs: { class: 'nai-reply-table' },
          children: [
            {
              tag: 'thead',
              attrs: {},
              children: [{ tag: 'tr', attrs: {}, children: head.map((text, column) => cell(text, column, 'th')) }]
            },
            {
              tag: 'tbody',
              attrs: {},
              children: rows.map((row) => ({
                tag: 'tr',
                attrs: {},
                children: row.map((text, column) => cell(text, column, 'td'))
              }))
            }
          ]
        },
        next: index
      }
    }

    /**
     * Read a run of list lines into (possibly nested) lists.
     *
     * Depth comes from indentation, with a stack rather than a parser: a deeper line opens a
     * list inside the previous item, a shallower one closes levels until it fits, and a change
     * of marker at one depth starts a second list instead of joining the first — `1.` followed
     * by `-` is two lists even at the same indent.
     *
     * @param lines - every line of the reply.
     * @param start - the index of the first list line.
     * @returns `{ blocks, next }`.
     */
    function parseReplyList(lines, start) {
      const items = []
      let index = start
      while (index < lines.length) {
        const match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[index])
        if (match === null) break
        items.push({
          indent: match[1].replace(/\t/g, '    ').length,
          ordered: /^\d/.test(match[2]),
          text: match[3]
        })
        index += 1
      }
      const blocks = []
      const stack = []
      for (const item of items) {
        while (stack.length > 0 && item.indent < stack[stack.length - 1].indent) stack.pop()
        const current = stack[stack.length - 1]
        const listFor = () => ({ tag: item.ordered ? 'ol' : 'ul', attrs: { class: 'nai-reply-list' }, children: [] })
        if (current === undefined) {
          const list = listFor()
          blocks.push(list)
          stack.push({ indent: item.indent, list })
        } else if (item.indent > current.indent) {
          const list = listFor()
          const parent = current.list.children[current.list.children.length - 1]
          if (parent === undefined) {
            blocks.push(list)
          } else {
            parent.children.push(list)
          }
          stack.push({ indent: item.indent, list })
        } else if ((current.list.tag === 'ol') !== item.ordered) {
          const list = listFor()
          const outer = stack[stack.length - 2]
          const parent = outer === undefined ? undefined : outer.list.children[outer.list.children.length - 1]
          if (parent === undefined) {
            blocks.push(list)
          } else {
            parent.children.push(list)
          }
          stack[stack.length - 1] = { indent: item.indent, list }
        }
        const active = stack[stack.length - 1].list
        active.children.push({ tag: 'li', attrs: {}, children: replyInline(item.text) })
      }
      return { blocks, next: start + items.length }
    }

    /**
     * Turn a reply's Markdown into a tree of blocks.
     *
     * Written here rather than borrowed, for the same reason the inline reader is: the app's
     * renderer is not reachable. The grammar is the one a reply actually uses — headings,
     * paragraphs, fenced code, lists, quotes, rules and tables — and everything past it is
     * passed through as text. A soft line break inside a paragraph becomes a `<br>`: replies
     * here are mostly Chinese, where a single newline is a line and not a space, and a reader
     * that swallowed it would reflow the model's layout into one lump.
     *
     * @param text - the reply body.
     * @returns block nodes.
     */
    function parseReplyMarkdown(text) {
      const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let index = 0
      const startsBlock = (line) =>
        /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
        /^\s{0,3}#{1,6}\s+/.test(line) ||
        /^\s{0,3}>/.test(line) ||
        /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) ||
        /^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)
      while (index < lines.length) {
        const line = lines[index]
        if (/^\s*$/.test(line)) {
          index += 1
          continue
        }
        const fence = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/.exec(line)
        if (fence !== null) {
          const marker = fence[1][0]
          const closing = new RegExp(`^\\s{0,3}\\${marker}{3,}\\s*$`)
          const info = fence[2].trim()
          const body = []
          index += 1
          while (index < lines.length && !closing.test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          if (info !== '') {
            blocks.push({ tag: 'div', attrs: { class: 'nai-reply-lang' }, children: [{ text: info }] })
          }
          blocks.push({
            tag: 'pre',
            attrs: { class: 'nai-reply-code' },
            children: [
              {
                // The language class is the app's own convention, and it keeps a fenced prompt
                // inside a reply recognizable to this plugin's other half: a block that looks
                // like a NovelAI prompt still gets its render button.
                tag: 'code',
                attrs: info === '' ? {} : { class: `language-${info.split(/\s+/)[0]}` },
                children: [{ text: body.join('\n') }]
              }
            ]
          })
          continue
        }
        if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
          blocks.push({ tag: 'hr', attrs: {}, children: [] })
          index += 1
          continue
        }
        const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
        if (heading !== null) {
          blocks.push({ tag: `h${heading[1].length}`, attrs: {}, children: replyInline(heading[2]) })
          index += 1
          continue
        }
        if (/^\s{0,3}>/.test(line)) {
          const quoted = []
          while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
            quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ''))
            index += 1
          }
          blocks.push({ tag: 'blockquote', attrs: {}, children: parseReplyMarkdown(quoted.join('\n')) })
          continue
        }
        if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)) {
          const run = parseReplyList(lines, index)
          blocks.push(...run.blocks)
          index = run.next
          continue
        }
        const table = replyTableAt(lines, index)
        if (table !== null) {
          blocks.push(table.block)
          index = table.next
          continue
        }
        const paragraph = []
        while (
          index < lines.length &&
          !/^\s*$/.test(lines[index]) &&
          !startsBlock(lines[index]) &&
          replyTableAt(lines, index) === null
        ) {
          paragraph.push(lines[index])
          index += 1
        }
        const children = []
        for (const [row, text_] of paragraph.entries()) {
          if (row > 0) children.push({ tag: 'br', attrs: {}, children: [] })
          children.push(...replyInline(text_))
        }
        blocks.push({ tag: 'p', attrs: {}, children })
      }
      return blocks
    }

    /**
     * Materialize a reply tree as DOM.
     *
     * Text goes in through `createTextNode`, never `innerHTML`: a reply is model output, and
     * the one thing this half must not do is let it become markup. That is also why the tree
     * above carries `{ text }` leaves instead of pieces of HTML.
     *
     * @param doc - the document to build in.
     * @param nodes - the tree.
     * @param into - the element to fill; a fragment when absent.
     * @returns the element or fragment filled.
     */
    function replyTreeToDom(doc, nodes, into) {
      const target = into ?? doc.createDocumentFragment()
      for (const node of nodes ?? []) {
        if (node === null || node === undefined) continue
        if (typeof node.text === 'string') {
          target.appendChild(doc.createTextNode(node.text))
          continue
        }
        const element = doc.createElement(node.tag)
        for (const [name, value] of Object.entries(node.attrs ?? {})) element.setAttribute(name, String(value))
        replyTreeToDom(doc, node.children, element)
        target.appendChild(element)
      }
      return target
    }

    /**
     * Fill a painted reply node from a registry entry.
     *
     * The caption line is kept because a reply that arrived through a tool is worth marking —
     * it is the one place the reader can see that the text came through a call rather than
     * being written by the app itself — and the character count is how they can tell the text
     * arrived whole.
     *
     * @param node - the node painted for this reply.
     * @param entry - the registry entry.
     */
    function fillReplyNode(node, entry) {
      const doc = node.ownerDocument ?? document
      const caption = doc.createElement('div')
      caption.className = 'nai-reply-head'
      const title = doc.createElement('span')
      title.className = 'nai-reply-caption'
      title.textContent = replyT('replyCaption')
      caption.appendChild(title)
      if (typeof entry.label === 'string' && entry.label !== '') {
        const label = doc.createElement('span')
        label.className = 'nai-reply-label'
        label.textContent = entry.label
        caption.appendChild(label)
      }
      const count = doc.createElement('span')
      count.className = 'nai-reply-count'
      count.textContent = `${Array.from(entry.text ?? '').length} ${replyT('replyUnit')}`
      caption.appendChild(count)
      if (entry.done === false) {
        const state = doc.createElement('span')
        state.className = 'nai-reply-state'
        state.textContent = replyT('replyWriting')
        caption.appendChild(state)
      }
      const body = doc.createElement('div')
      body.className = 'nai-reply-body'
      if (entry.duplicate === true) {
        const note = doc.createElement('p')
        note.className = 'nai-reply-duplicate'
        note.textContent = replyT('replyDuplicate')
        body.appendChild(note)
      } else {
        body.appendChild(replyTreeToDom(doc, parseReplyMarkdown(entry.text)))
      }
      node.replaceChildren(caption, body)
    }

    /**
     * Build the node a reply is painted into.
     * @param entry - the registry entry.
     * @returns the node.
     */
    function buildReplyNode(entry) {
      const node = document.createElement('div')
      node.className = 'nai-reply'
      node.setAttribute(REPLY_ATTR, entry.callId)
      if (entry.duplicate === true) node.setAttribute(REPLY_DUPLICATE_ATTR, '')
      fillReplyNode(node, entry)
      return node
    }

    /**
     * Mark or unmark a painted reply as a repeat of the turn's own text.
     *
     * The removal is asked of the node rather than assumed of it: the marker is a convenience on
     * top of a reply that is already readable, so a host whose elements carry `setAttribute` and
     * not `removeAttribute` still gets the text painted.
     *
     * @param node - the painted node.
     * @param duplicate - whether the reply repeats what the turn already wrote out.
     */
    function markReplyDuplicate(node, duplicate) {
      if (duplicate === true) {
        node.setAttribute(REPLY_DUPLICATE_ATTR, '')
        return
      }
      if (typeof node.removeAttribute === 'function') node.removeAttribute(REPLY_DUPLICATE_ATTR)
    }

    /**
     * Place one registered reply, or report that there is nowhere to place it yet.
     * @param entry - the registry entry.
     * @returns whether the reply is on screen now.
     */
    function paintReply(entry) {
      const row = replyRowFor(entry.callId)
      if (row === null) return false
      const found = replyAnchorFor(row, replyRetryCount >= REPLY_RETRIES)
      if (found === null) return false
      const parent = found.parent ?? found.anchor?.parentElement ?? null
      if (parent === null || parent === undefined) return false
      // A finished reply that the turn had already written out as message text is not painted a
      // second time. While it is still arriving the comparison is not made: the plain text of a
      // turn that is still being written is a moving target, and the reply growing on screen is
      // worth more than a promise not to repeat it.
      const duplicate = entry.done !== false && replyWrittenAsPlainText(found.item, entry.text)
      const shaped = duplicate === true ? { ...entry, duplicate: true } : entry
      let painted = paintedReplies.get(entry.callId)
      if (painted === undefined) {
        painted = { node: buildReplyNode(shaped), text: entry.text, done: entry.done, duplicate }
        paintedReplies.set(entry.callId, painted)
      }
      if (painted.text !== entry.text || painted.done !== entry.done || painted.duplicate !== duplicate) {
        fillReplyNode(painted.node, shaped)
        markReplyDuplicate(painted.node, duplicate)
        painted.text = entry.text
        painted.done = entry.done
        painted.duplicate = duplicate
      }
      // Position is re-asserted on every pass but written only when it is wrong: a pass that
      // changes nothing must not touch the document, or the observer above would schedule the
      // next pass out of this pass's own work and never stop.
      if (painted.node.parentElement !== parent || painted.node.nextSibling !== found.anchor) {
        parent.insertBefore(painted.node, found.anchor ?? null)
      }
      entry.turn = found.turn
      return true
    }

    /**
     * Where a reply belongs, for the row that carries it.
     *
     * The answer area is what a turn already calls its reply: the assistant's own answer step
     * first, so a turn that also wrote message text keeps our reply above it rather than below
     * where it would read as a second answer, and the turn tail second — which is the anchor
     * of the ordinary case this tool exists for, a turn whose whole answer came through the
     * call and which therefore has no answer step of its own.
     *
     * @param row - an element inside the call's flow item.
     * @param desperate - whether the retry chain has run out, in which case the call's own flow
     *   item is used as the last resort so the text is at least readable with the fold open.
     * @returns `{ anchor, parent, turn }`, or null when the turn cannot be identified yet.
     */
    function replyAnchorFor(row, desperate) {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
      const item = typeof row?.closest === 'function' ? row.closest('[data-chat-turn]') : null
      if (item === null || item === undefined || typeof item.getAttribute !== 'function') return null
      const turn = item.getAttribute('data-chat-turn')
      if (turn === null || turn === undefined || turn === '') return null
      const selector = `[data-chat-turn=${quoteForSelector(turn)}]`
      const answer = document.querySelector(`${selector}[data-turn-process-answer]`)
      if (answer !== null && answer !== undefined && answer !== item) return { anchor: answer, parent: answer.parentElement, turn: String(turn), item }
      const tail = document.querySelector(`[${TURN_TAIL_ATTR}]${selector}`)
      if (tail !== null && tail !== undefined) return { anchor: tail, parent: tail.parentElement, turn: String(turn), item }
      if (desperate === true) {
        return { anchor: item.nextSibling ?? null, parent: item.parentElement, turn: String(turn), item }
      }
      return null
    }

    /**
     * What the turn wrote as ordinary message text, with our own nodes and the tool fold left out.
     *
     * The painted reply is a sibling of the turn's own flow items, so it would otherwise answer
     * for itself: it carries the reply attribute, and that is what this leaves out. The fold is
     * left out too, because the receipt row and the generic tool cards are about the call, not
     * about the answer.
     *
     * @param item - the call's flow item, inside the turn.
     * @returns the turn's plain text.
     */
    function replyPlainText(item) {
      const list = item?.parentElement ?? null
      if (list === null || list === undefined) return ''
      const turn = typeof item.getAttribute === 'function' ? item.getAttribute('data-chat-turn') : null
      let text = ''
      for (const child of list.children ?? []) {
        if (child === null || child === undefined || typeof child.getAttribute !== 'function') continue
        if (turn !== null && child.getAttribute('data-chat-turn') !== turn) continue
        if (child.getAttribute(REPLY_ATTR) !== null) continue
        if (child.getAttribute('data-chat-flow-kind') === 'turn-process') continue
        text += `${child.textContent ?? ''}\n`
      }
      return text
    }

    /**
     * Whether the turn's ordinary text already carries this reply.
     *
     * A long reply is recognised by its head, and the copy already in the message body has to be
     * at least as long as the reply being considered — the same "the longer one wins" rule the
     * tavern transports use, which is what stops a short preamble in the body from hiding a long
     * reply that only came through the call. A short reply is recognised only when the two are
     * the same words, since a few characters of prose are a coincidence far more often than they
     * are a copy.
     *
     * @param item - the call's flow item, inside the turn.
     * @param text - the reply being considered.
     * @returns whether the reply is already on screen as message text.
     */
    function replyWrittenAsPlainText(item, text) {
      const want = String(text ?? '').replace(/\s+/g, ' ').trim()
      if (want === '') return false
      const plain = replyPlainText(item).replace(/\s+/g, ' ').trim()
      if (plain.length < want.length) return false
      if (want.length <= REPLY_PLAIN_MIN) return plain === want
      return plain.includes(want.slice(0, REPLY_PLAIN_HEAD))
    }

    /**
     * Place every registered reply, and repair the ones a re-render dropped.
     *
     * Called from three directions, because no single one of them covers the cases: the
     * receipt row's effect (a live call, which is what the user is watching as it arrives), the
     * transcript observer (a replay, a scroll, a theme change — anything that rebuilt the turn
     * and took the painted node with it), and the retry chain (a reply that arrived before its
     * turn had anywhere to put it).
     *
     * @returns `{ placed, waiting }` — replies on screen, and replies still with nowhere to go.
     */
    function flushReplies() {
      let placed = 0
      let waiting = 0
      for (const entry of replies.values()) {
        if (paintReply(entry)) placed += 1
        else waiting += 1
      }
      if (waiting === 0) {
        replyRetryCount = 0
        // Nothing is left to wait for, so the chain is called off rather than left to wake up and
        // discover that: a pass that has placed every reply is the end of the reason it existed.
        replyRetryArmed = false
        if (replyRetryTimer !== null && typeof clearTimeout === 'function') clearTimeout(replyRetryTimer)
        replyRetryTimer = null
      }
      return { placed, waiting }
    }

    /**
     * Take one reply for painting.
     *
     * The entry is replaced in place rather than re-created, because a call can deliver its
     * text twice — once dispatched, once settled — and the second delivery is the same reply
     * with the same node.
     *
     * @param callId - the call this reply came through.
     * @param text - the reply body.
     * @param label - the model's optional caption.
     * @returns the registry entry, or null when the call has no id to key it by.
     */
    function registerReply(callId, text, label, done) {
      const key = String(callId ?? '')
      if (key === '') return null
      const entry = replies.get(key) ?? { callId: key, turn: null }
      entry.text = text
      entry.label = label ?? null
      // A reply that has not finished arriving is taken, not held back: the answer area filling
      // as the model writes is the point of reading the fragment at all, and the caption says
      // which of the two states the text is in.
      entry.done = done !== false
      replies.set(key, entry)
      // A row that has just arrived is the reason to sweep: whatever held the previous attempt
      // back — a turn with no answer area yet — may be gone by now.
      replyRetryCount = 0
      armReplyRetry()
      return entry
    }

    /** The registry entry for a call, for tests and for the panel. */
    function replyEntryOf(callId) {
      return replies.get(String(callId ?? '')) ?? null
    }

    /** The node painted for a call, or null when nothing has been painted. */
    function replyPaintOf(callId) {
      return paintedReplies.get(String(callId ?? ''))?.node ?? null
    }

    /**
     * Count one settled turn, and say so when the tool has been ignored for a while.
     *
     * A model that answers without calling the tool has not failed: the answer is simply
     * ordinary message text, and nothing is lost. What the reader cannot see is that the
     * transport is not in use, so after a few turns in a row the panel is told. The newest turn
     * on screen is what is counted, once each — a transcript that keeps settling while nothing
     * new has happened must not walk the counter up on its own.
     *
     * @returns the current streak.
     */
    function noteReplyTurn() {
      // A transport that is switched off is not being ignored — it is not there. Counting its
      // turns would turn a setting into a fault report.
      if (replyTransportOn !== true) return replyMissStreak
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return replyMissStreak
      let newest = -1
      for (const node of document.querySelectorAll('[data-chat-turn]') ?? []) {
        const value = typeof node?.getAttribute === 'function' ? node.getAttribute('data-chat-turn') : null
        const parsed = Number(value)
        if (Number.isFinite(parsed) && parsed > newest) newest = parsed
      }
      if (newest < 0) return replyMissStreak
      const turn = String(newest)
      if (turn === replyLastTurn) return replyMissStreak
      const counted = [...replies.values()].some((entry) => String(entry.turn ?? '') === turn)
      replyLastTurn = turn
      if (counted) {
        replyMissStreak = 0
        return replyMissStreak
      }
      replyMissStreak += 1
      if (replyMissStreak === REPLY_MISS_LIMIT) {
        // Said once per streak, not once per turn: the point is to name the situation, and a
        // transcript that goes on ignoring the tool has nothing new to report.
        diag('reply-miss', { streak: replyMissStreak, turn, tool: REPLY_TOOL_NAME })
      }
      return replyMissStreak
    }

    /**
     * What the reply half is doing, for the panel and for tests.
     * @returns counts, and the streak of turns that answered without the tool.
     */
    function replyStats() {
      const entries = [...replies.values()]
      return {
        tool: REPLY_TOOL_NAME,
        delivered: entries.length,
        streaming: entries.filter((entry) => entry.done === false).length,
        painted: paintedReplies.size,
        duplicates: [...paintedReplies.values()].filter((item) => item.duplicate === true).length,
        streak: replyMissStreak,
        turn: replyLastTurn
      }
    }

    /**
     * Keep trying to place the replies that have nowhere to go.
     *
     * The wait is for the turn's answer area, which arrives when the turn does: a reply
     * delivered mid-turn has genuinely nowhere to sit, and giving up would leave the text
     * behind a fold. One chain serves every reply, and it stops as soon as a pass has placed
     * all of them.
     */
    function armReplyRetry() {
      if (typeof setTimeout !== 'function') return
      if (replyRetryArmed === true) return
      const pending = [...replies.values()].some((entry) => !paintedReplies.has(entry.callId))
      if (pending === false) return
      replyRetryArmed = true
      replyRetryTimer = setTimeout(() => {
        replyRetryArmed = false
        replyRetryTimer = null
        const result = flushReplies()
        if (result.waiting > 0 && replyRetryCount < REPLY_RETRIES) {
          replyRetryCount += 1
          armReplyRetry()
        }
      }, REPLY_RETRY_MS)
    }

    /** A hook-shaped no-op, for a slot that did not hand the partial-argument reader down. */
    function emptyPartialArguments() {
      return ''
    }

    /**
     * The receipt row for one reply call — what stands in place of the generic tool card.
     *
     * A keyed hit in `tool.call.toolview` takes the row over, which is why this is deliberately
     * small: the text belongs in the answer area, and this row exists so the fold is not silent
     * about what happened. It reads the call through the same two readers the painting uses,
     * so the count on the row and the count in the reply are never two opinions.
     *
     * @param props - the Tool row's owner props, plus the slot's argument hook.
     * @returns the row element.
     */
    function ReplyRow(props) {
      const callId = String(props?.callId ?? '')
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const usePartial =
        typeof props?.useToolCallArgumentsPartial === 'function'
          ? props.useToolCallArgumentsPartial
          : emptyPartialArguments
      const partial = usePartial()
      const reply = replyFromCall(props?.call, partial)
      const shown = reply.text !== ''
      const done = reply.complete === true
      React.useEffect(() => {
        if (shown) registerReply(callId, reply.text, reply.label, done)
        // The answer area is not a parent of this row, so nothing here can hand it a node: the
        // sweep goes looking. This effect is its cue, and it runs again on every delivery — which
        // is also what redraws the reply each time another fragment of the argument arrives.
        flushReplies()
      }, [callId, shown, done, reply.text, reply.label])
      const chars = shown ? Array.from(reply.text).length : partialReplyChars(reply.raw)
      const state = `${done ? t('replyReceived') : t('replyWriting')} · ${chars} ${t('replyUnit')}`
      return h(
        'div',
        { className: 'nai-reply-row', [REPLY_ROW_ATTR]: callId },
        h('span', { className: 'nai-reply-row-state', key: 'state' }, state),
        reply.label === null ? null : h('span', { className: 'nai-reply-row-label', key: 'label' }, reply.label)
      )
    }

    /**
     * The reply's stylesheet.
     *
     * Minimal on purpose: a reply is meant to read like any other answer, so body type is the
     * app's own scale and only the framing — code, quotes, tables, the caption line — needs
     * rules. Colours come from the app's aliases with fallbacks, so a theme change reaches the
     * reply too.
     */
    const REPLY_CSS = [
      '.nai-reply{margin:10px 0 2px}',
      '.nai-reply-head{display:flex;gap:8px;align-items:baseline;font-size:11px;line-height:15px;margin-bottom:4px;color:var(--dsw-alias-label-tertiary,#888)}',
      '.nai-reply-label{color:var(--dsw-alias-label-secondary,#666)}',
      '.nai-reply-state{font-style:italic;color:var(--dsw-alias-label-secondary,#666)}',
      '.nai-reply[data-nai-reply-duplicate]{margin-top:8px}',
      '.nai-reply-body p.nai-reply-duplicate{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary,#888)}',
      '.nai-reply-body{font-size:14px;line-height:1.65;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,inherit)}',
      '.nai-reply-body p{margin:0 0 10px}',
      '.nai-reply-body h1,.nai-reply-body h2,.nai-reply-body h3,.nai-reply-body h4,.nai-reply-body h5,.nai-reply-body h6{margin:14px 0 6px;line-height:1.35}',
      '.nai-reply-body h1{font-size:19px}.nai-reply-body h2{font-size:17px}.nai-reply-body h3{font-size:15px}',
      '.nai-reply-body ul,.nai-reply-body ol{margin:0 0 10px;padding-left:22px}',
      '.nai-reply-body li{margin:2px 0}',
      '.nai-reply-body blockquote{margin:0 0 10px;padding:2px 10px;border-left:3px solid var(--dsw-alias-border-l1,#d0d0d5);color:var(--dsw-alias-label-secondary,#666)}',
      '.nai-reply-body hr{border:0;border-top:1px solid var(--dsw-alias-border-l1,#d0d0d5);margin:12px 0}',
      '.nai-reply-body a{color:var(--dsw-alias-accent,#2d6cff)}',
      '.nai-reply-lang{margin:8px 0 2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}',
      '.nai-reply-body pre.nai-reply-code{margin:0 0 10px;padding:8px 10px;overflow-x:auto;border:1px solid var(--dsw-alias-border-l1,#d0d0d5);border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-fill-l1,rgba(127,127,127,0.10));font-size:12.5px;line-height:1.55}',
      '.nai-reply-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.92em}',
      '.nai-reply-body code.nai-reply-inline-code{padding:1px 4px;border-radius:3px;background:var(--dsw-alias-fill-l1,rgba(127,127,127,0.14))}',
      '.nai-reply-body pre.nai-reply-code code{background:transparent;padding:0}',
      'table.nai-reply-table{border-collapse:collapse;margin:0 0 10px;font-size:13px}',
      'table.nai-reply-table th,table.nai-reply-table td{border:1px solid var(--dsw-alias-border-l1,#d0d0d5);padding:4px 8px}',
      'table.nai-reply-table th{background:var(--dsw-alias-fill-l1,rgba(127,127,127,0.08))}',
      '.nai-reply-row{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}',
      '.nai-reply-row-label{color:var(--dsw-alias-label-tertiary,#888)}'
    ].join('\n')

    /**
     * Mount the reply stylesheet, once per document.
     *
     * Re-mounting on a reload would stack identical stylesheets, so an existing tag with this
     * name is reused. Nothing here assumes a full DOM: `dataset` and `appendChild` are both
     * newer conveniences than the elements they sit on, and a host that has one but not the
     * other is a host where the styles should still land.
     *
     * @returns the style element this call mounted, or null when there already was one.
     */
    function installReplyStyles() {
      const existing =
        typeof document.querySelector === 'function'
          ? document.querySelector(`style[data-plugin-css=${quoteForSelector(REPLY_STYLE_ID)}]`)
          : null
      if (existing !== null && existing !== undefined) return null
      const tag = document.createElement('style')
      if (tag.dataset !== undefined && tag.dataset !== null) {
        tag.dataset.plugin = 'dsh-nai-imagegen'
        tag.dataset.pluginCss = REPLY_STYLE_ID
      }
      tag.textContent = REPLY_CSS
      const host = document.head ?? document.body
      if (host !== null && host !== undefined) {
        if (typeof host.append === 'function') host.append(tag)
        else if (typeof host.appendChild === 'function') host.appendChild(tag)
      }
      return tag
    }

    /**
     * Watch the transcript for replies that need painting, and keep the styles mounted.
     *
     * The observer is the repair half of the two triggers: the row's own effect catches the
     * live delivery, while anything that rebuilds a turn — a replay, a scroll, a theme change —
     * takes the painted node with it and leaves no row re-render behind to notice. Since a pass
     * that changes nothing writes nothing, this observer's own work cannot keep it awake.
     *
     * @param t - the dictionary binder, used for the caption line painted into the transcript.
     * @returns a disposer that stops the observer and removes the styles.
     */
    function installReplies(t) {
      if (typeof t === 'function') replyT = t
      if (typeof document === 'undefined') return () => {}
      const style = typeof document.createElement === 'function' ? installReplyStyles() : null
      const body = document.body
      if (typeof MutationObserver !== 'function' || body === null || body === undefined) {
        return () => {
          if (style !== null) style.remove()
        }
      }
      let queued = false
      const observer = new MutationObserver(() => {
        if (replies.size === 0 || queued) return
        queued = true
        const run = () => {
          queued = false
          flushReplies()
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
        else if (typeof setTimeout === 'function') setTimeout(run, 0)
        else run()
      })
      observer.observe(body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        if (style !== null) style.remove()
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-nai-imagegen: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => installCodeButtons(t), 'dsh-nai-imagegen: prompt buttons')
      ctx.effect(() => {
        bootAutoRender()
        bootReplyTransport()
        // The flag follows the stored setting for as long as the page lives, not only at
        // activation: a change made anywhere else lands here within `SETTING_POLL_MS`.
        return startSettingSync()
      }, 'dsh-nai-imagegen: auto-render flag')
      ctx.effect(() => installImageMenu(t), 'dsh-nai-imagegen: image menu')
      ctx.effect(() => installFloatingStudio(t), 'dsh-nai-imagegen: floating studio')
      ctx.effect(() => installImageSizing(t), 'dsh-nai-imagegen: image sizing')
      ctx.effect(() => installReplies(t), 'dsh-nai-imagegen: reply rows')

      // The receipt row for `nai_reply`, in place of the generic tool card. A keyed hit takes
      // the row over — the Tool half falls back to a generic card only when no key matches —
      // so this is the whole of how the call is shown in the fold.
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          {
            name: 'tool.call.toolview',
            key: REPLY_TOOL_NAME,
            locale: NS
          },
          ReplyRow
        )
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS
          },
          NaiPanel
        )
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            locale: NS,
            label: () => t('panel')
          },
          PanelIcon
        )
      )
    }

    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    exports.NaiPanel = NaiPanel
    exports.PanelIcon = PanelIcon
    exports.looksLikePrompt = looksLikePrompt
    exports.hashOf = hashOf
    exports.decorate = decorate
    // Test seam for the replay rule: given one observer batch, is this history or a reply?
    exports.looksLikeReplay = looksLikeReplay
    exports.installCodeButtons = installCodeButtons
    exports.installImageMenu = installImageMenu
    exports.markImage = markImage
    // Test seams for the auto-render bounds: the flag, a forced pass, the bootstrap
    // read, and the number of renders already spent against the session budget.
    exports.setAutoRender = (value) => {
      autoRender = value === true
    }
    exports.bootAutoRender = bootAutoRender
    // Test seams for the setting sync: the loop that keeps the flag following the stored
    // answer, and the one-line report of what the last automatic pass did.
    exports.startSettingSync = startSettingSync
    exports.lastAutoLine = lastAutoLine
    exports.rescanBlocks = (options) => {
      if (typeof rescanBlocks === 'function') rescanBlocks(options)
    }
    exports.autoRenderedCount = () => autoDone.size
    // Test seams for the reply row: the wire name it keys on, the reader that turns a call's
    // arguments into a reply, the Markdown reader, the painter, and the two registries — the
    // whole path from a tool call to text standing in the answer area, minus React.
    exports.REPLY_TOOL_NAME = REPLY_TOOL_NAME
    exports.replyFromCall = replyFromCall
    exports.partialReplyChars = partialReplyChars
    exports.parseReplyArgs = parseReplyArgs
    exports.parseReplyMarkdown = parseReplyMarkdown
    exports.replyTreeToDom = replyTreeToDom
    exports.ReplyRow = ReplyRow
    exports.installReplies = installReplies
    exports.registerReply = registerReply
    exports.flushReplies = flushReplies
    exports.replyEntryOf = replyEntryOf
    exports.replyPaintOf = replyPaintOf
    exports.replyRowFor = replyRowFor
    // Test seams for the transport's switch: what the host said, how a change since the page
    // loaded reaches this half, and the read that learns it without the panel being open.
    exports.setReplyTransport = setReplyTransport
    exports.bootReplyTransport = bootReplyTransport
    exports.readPartialText = readPartialText
    exports.replyWrittenAsPlainText = replyWrittenAsPlainText
    exports.noteReplyTurn = noteReplyTurn
    exports.replyStats = replyStats
    // Test seams for the window's double-click: which blocks count as the newest reply, what
    // pressing all of their buttons reports, and the files a block already has — a block that
    // does is not pressed again, and that has to be provable without going through the Host.
    exports.latestReplyHosts = latestReplyHosts
    exports.fireLatestReply = fireLatestReply
    exports.setRendered = (key, files) => {
      generated.set(key, files ?? [])
    }
    // Test seams for the artist switcher: the write it builds from the host's own state,
    // the two overlays, and the launcher mechanic both windows share.
    exports.openArtistDock = openArtistDock
    exports.modesPatchFor = modesPatchFor
    exports.openArtistZoom = openArtistZoom
    exports.closeArtistZoom = closeArtistZoom
    exports.mountLauncher = mountLauncher
    exports.installFloatingStudio = installFloatingStudio
    // Test seams for the reply's board: what it would draw from the reply in front of the
    // user, and the redraw that puts it there.
    exports.replyBoardFiles = replyBoardFiles
    exports.refreshReplyBoard = refreshReplyBoard
    exports.placeBoard = placeBoard
    // A board wider than the answer clips, so the two ends page it; proving that needs the
    // arrows on their own, away from a document that can lay anything out.
    exports.boardArrows = boardArrows
    // One picture at a time: the cell that carries its redraw, and the redraw itself — a single
    // sample, in the slot the old picture had.
    exports.boardCell = boardCell
    exports.rerollBoardFile = rerollBoardFile
    // Test seams for what outlives the page: the store is written on every render and read
    // before the host is asked, so a reload has to be reproducible without reloading anything.
    exports.rememberFiles = rememberFiles
    exports.recallFiles = recallFiles
    exports.resetRenderStore = resetRenderStore
    return module.exports
  }
})
