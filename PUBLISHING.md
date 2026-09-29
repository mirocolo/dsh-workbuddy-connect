# 发布到 npm 的步骤

本文件记录把 **`@mirocolo/dsh-workbuddy-connect`** 发布到 npm 的可执行步骤。
仓库里的 `package.json` 已经配置好，无需再改。

## 一、为什么不能沿用 `dsh-workbuddy-connect` 这个名字

| 事实 | 证据 |
|---|---|
| `dsh-workbuddy-connect` 这个包名**已存在且已发布** | npm `latest` = `0.6.4` |
| 它的唯一维护者是 **`corrinehu`**，不是你 | `npm view dsh-workbuddy-connect maintainers` |
| npm 的包名是**先到先得且不可转让**的 | 发布 `dsh-workbuddy-connect@0.7.0` 会直接 **403** |
| `@mirocolo/dsh-workbuddy-connect` **未被占用** | 查询返回 404 |

所以本仓库改为 scoped 包名 `@mirocolo/dsh-workbuddy-connect`。
scoped 包**必须**声明 `publishConfig.access = "public"`，否则首次发布会因默认
`restricted` 而失败 —— 该字段已写入 `package.json`。

## 二、发布前检查

```sh
cd /Users/hexin/Code/github/dsh-workbuddy-connect

# 1. 依赖装齐（本机 npm 缓存有 root 属主文件，需绕开）
pnpm install --config.cache=/tmp/npmcache-dsh

# 2. 类型检查 + 全部测试 + 构建
pnpm run check

# 3. 确认要发布的文件清单（不产生 tarball）
npm pack --dry-run
```

`pnpm run check` 目前的结果是 **600/601 通过**，唯一失败的是
`tests/host-heartbeat.spec.ts` 里的一条用例，它**与本次升级无关**：
该用例依赖 `ps -o lstart=` 读取进程启动时间，而本机沙箱禁用了 `ps`
（`spawnSync ps EPERM`）。在未改动的原始代码上同样失败。在有正常 `ps`
权限的机器（或 CI）上应当通过。

## 三、发布

```sh
# 1. 登录（会打开浏览器授权；如开启 2FA 会要求输入一次性验证码）
npm login --config.cache=/tmp/npmcache-dsh
npm whoami --config.cache=/tmp/npmcache-dsh   # 应输出 mirocolo

# 2. 提交代码（package.json 的 version 是唯一版本来源）
git add -A
git commit -m "chore: release 0.7.0 (DSH 0.1.7 core support; publish as @mirocolo/dsh-workbuddy-connect)"

# 3. 打 tag 并推送
git tag -a v0.7.0 -m "v0.7.0"
git push origin dev --follow-tags

# 4. 发布（prepack 会自动重新构建 lib/）
npm publish --config.cache=/tmp/npmcache-dsh
```

> **不要**加 `--access public`：已经写在 `publishConfig` 里了，重复无意义。
>
> 若想带**溯源证明**（推荐，CI 场景尤其如此）：
> `npm publish --provenance --config.cache=/tmp/npmcache-dsh`
> 这要求从 GitHub Actions 等受支持的 CI 环境发布。

## 四、发布后验证

```sh
npm view @mirocolo/dsh-workbuddy-connect version dist-tags --config.cache=/tmp/npmcache-dsh
# 期望：version = 0.7.0，dist-tags.latest = 0.7.0

# 在一个干净的临时目录里真实安装一次
cd "$(mktemp -d)"
npm init -y >/dev/null
npm install @mirocolo/dsh-workbuddy-connect --config.cache=/tmp/npmcache-dsh
node -e "console.log(require('@mirocolo/dsh-workbuddy-connect/package.json').version)"
```

用户安装方式：

```sh
dsh plugin --profile web add @mirocolo/dsh-workbuddy-connect
```

## 五、后续发版

只需改 `package.json` 的 `version` 后重复第三节。
SemVer 建议：

- **patch** (`0.7.x`)：修 bug、改文案
- **minor** (`0.x.0`)：支持新的 DSH 内核 —— 同时要把 `peerDependencies` 里
  7 个 `@deepseek-ai/dsh-*` 的 range 补上新的一段
- **major** (`x.0.0`)：破坏性变更

### 支持新内核时的固定动作

以 DSH `0.1.8-rc.1` 为例：

1. 先查包是否都发布了：
   ```sh
   for p in dsh-llm dsh-settings dsh-attachment dsh-home-paths dsh-host-webserver \
            dsh-llm-pi-ai dsh-atomic-write dsh-client-ui-renderer dsh-client-ui-slots dsh-client-locale; do
     printf '%-30s ' "$p"
     npm view "@deepseek-ai/$p@0.1.8-rc.1" version --config.cache=/tmp/npmcache-dsh 2>&1 | head -1
   done
   ```
2. 把 `devDependencies` 的 10 个 `@deepseek-ai/dsh-*` 提到新版本。
3. 在 `peerDependencies` 的每一段后面追加新的 range，例如
   `|| ^0.1.8-rc.1`（`^0.1.8-rc.1` 同时覆盖 `0.1.8` 正式版）。
4. `pnpm run check`，重点看 **typecheck** —— 内核的破坏性变更
   一定会先在类型上暴露出来（本次 0.1.7 的三处破坏都是这样发现的）。
5. 更新两个 README 的版本对应表。
