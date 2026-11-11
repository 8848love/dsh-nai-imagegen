# 回溯手册 · dsh-nai-imagegen

改坏了要能退回来，而且要退到「哪一次」是确定的。这个插件的一切历史都在
`8848love/dsh-nai-imagegen` 的 `plugins/dsh-nai-imagegen` 目录里，本地克隆一般是 `C:\nailongwang`。

> 铁律：仓库里还有其他项目，所有命令都带插件路径或只影响插件目录。
> 不 `git reset --hard`、不 `git clean -fdx`、不 `git push --force` —— 三条都会顺手毁掉别人的东西。

## 0. 先看清现在在哪

```bash
cd C:\nailongwang
git status --short -- plugins/dsh-nai-imagegen    # 插件目录有没有未提交改动
git log --oneline -15 -- plugins/dsh-nai-imagegen # 这个插件最近发生了什么
git tag --list "nai-imagegen-*" --sort=-v:refname # 有哪些发布点
```

想找「某个功能是哪次进去的」：

```bash
git log -p -- plugins/dsh-nai-imagegen/client.js | Select-String -Pattern 'boardReroll' -Context 3
```

## 1. 只退一个文件到某个发布点

最常用：新改的那处坏了，但其他改动要留。

```bash
git checkout nai-imagegen-v1.0.0 -- plugins/dsh-nai-imagegen/client.js
git commit -m "回退 client.js 到 nai-imagegen-v1.0.0（展板重画改版）"
git push origin main
```

动手前先看一眼差异，确认退回的是你要的：

```bash
git diff nai-imagegen-v1.0.0 -- plugins/dsh-nai-imagegen/client.js
```

## 2. 整包退到某个发布点

```bash
# 工作区直接摆成该发布点的样子（会覆盖插件目录，未提交的插件改动先 stash）
git stash push -m "退版前暂存" -- plugins/dsh-nai-imagegen
git checkout nai-imagegen-v1.0.0 -- plugins/dsh-nai-imagegen
git commit -m "整包回退到 nai-imagegen-v1.0.0"
git push origin main
```

## 3. 撤销某一次提交（保留它之后的改动）

当那次提交已经推上去、又不想把后面的工作一起抹掉时：

```bash
git revert --no-edit <提交哈希>
git push origin main
```

`revert` 会生成一条反向提交，历史仍然完整 —— 这是推过的提交唯一安全的撤销方式。

## 4. 另一台机器上回退已安装的副本

那边是按 git 装的，所以退版 = 换到旧标签再重装：

```bash
git clone --depth 1 --filter=blob:none --sparse --branch nai-imagegen-v1.0.0 https://github.com/8848love/dsh-nai-imagegen.git
cd nailongwang
git sparse-checkout set plugins/dsh-nai-imagegen
cd plugins/dsh-nai-imagegen
node bootstrap.mjs --mode link --apply      # 或 --mode copy --apply
```

装完自检：

```bash
node tests/verify.mjs          # 期望 0 failed
node tests/doctor-probe.mjs
```

## 5. 本机工作目录被改坏（`C:\DSH\bundle-nai-imagegen`）

工作目录是编辑现场，仓库才是账本。以仓库为准覆盖回来：

```bash
cd C:\nailongwang
git checkout nai-imagegen-v1.0.0 -- plugins/dsh-nai-imagegen
# 然后把这份拷回工作目录
robocopy C:\nailongwang\plugins\dsh-nai-imagegen C:\DSH\bundle-nai-imagegen /MIR /XD node_modules .git
```

反过来，如果工作目录才是好的、仓库落后了，用发布脚本推上去（默认预演）：

```bash
cd C:\DSH\bundle-nai-imagegen
node publish.mjs --message "把工作副本同步到仓库" --apply
```

## 6. 回退之后必须做的两件事

1. **跑测试**：`node tests/verify.mjs`，`0 failed` 才算这次回退站得住。
2. **写日志**：在 `CHANGELOG.md` 顶部加一条，说明退回到哪个标签、为什么退。

## 7. 什么时候算「不能自己退」

- 远端 `origin/main` 上有别人的提交、而你要推的改动会覆盖它 → 先 `git pull --rebase` 看冲突，冲突交给人。
- 需要 `--force` 才能推上去 → 停手，说明有人在改写同一段历史。
- 不确定某次改动是不是自己要退的 → 先 `git show <哈希> --stat` 看清范围再动手。
