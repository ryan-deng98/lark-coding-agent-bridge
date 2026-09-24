# 部署到 Railway

一个 Railway 服务里跑 supervisor + 网页控制台，托管所有 bot。bot 配置、加密后的密钥、每个 bot 自己的 Claude Code 登录、工作区都放在挂载到 `/data` 的 volume 上，重新部署不会丢。

## 1. 准备

装 Railway CLI 并登录（登录在浏览器里完成）：

```bash
brew install railway
railway login
```

## 2. 创建服务

在仓库根目录：

```bash
railway init --name lark-bridge          # 新建项目
railway add --service lark-bridge        # 新建空服务
railway service link lark-bridge         # 把当前目录关联到这个服务
railway volume add --mount-path /data    # 挂 volume
railway domain --port 8080               # 生成公网域名，控制台用
```

## 3. 设置变量

| 变量 | 值 | 作用 |
|---|---|---|
| `LARK_CHANNEL_KEYSTORE_SECRET` | 随机值 | 加密 volume 上的 App Secret 等密钥。**设一次就别再改**，改了之前存的密钥就解不开了 |
| `LARK_CHANNEL_UI_TOKEN` | 随机值 | 控制台访问 token。有它就能管理所有 bot，只给管理员 |
| `ANTHROPIC_API_KEY`（可选） | 公司的 API key | 没连接自己账号的 bot 用它；连了 Claude 账号的 bot 不会用到 |

随机值从管道直接写进 Railway，不经过命令行参数和 shell 历史：

```bash
openssl rand -hex 32 | tr -d '\n' | railway variable set --stdin LARK_CHANNEL_KEYSTORE_SECRET --skip-deploys
openssl rand -hex 32 | tr -d '\n' | railway variable set --stdin LARK_CHANNEL_UI_TOKEN --skip-deploys
railway variable set PORT=8080 --skip-deploys
```

`PORT=8080` 和上一步域名指向的端口一致。其余的镜像里已经配好：`LARK_CHANNEL_HOME=/data/lark-channel`，控制台监听 `0.0.0.0:$PORT`，只接受 `RAILWAY_PUBLIC_DOMAIN` 这个域名的请求。Railway 在美国机房，直连 Anthropic 和 Lark，不需要代理。

## 4. 部署

```bash
railway up --detach
```

按仓库里的 `Dockerfile` 构建（`railway.toml` 指定）。之后改了代码再跑一次 `railway up`；也可以在 Railway 里把服务连到 GitHub 仓库，推送即部署。

## 5. 创建第一个 bot

1. 打开 `https://<域名>/#token=<LARK_CHANNEL_UI_TOKEN>`（token 在 Railway 的 Variables 页能看到）。token 放在 `#` 后面，浏览器不会把它发给服务器，页面读到后也会从地址栏里去掉。
2. 第一次打开是开通向导：选 Claude，用 Lark/飞书扫码，自动创建应用。
3. 在 bot 列表里启动它。

## 6. 连接 bot 自己的 Claude 账号

1. 控制台 → bot 详情 →「Claude 账号」→「连接我的 Claude 账号」。
2. 点「打开 Claude 登录页」，用自己的 Claude 账号（Pro / Max / Team / Enterprise）登录并授权。Team 账号选公司的组织。
3. 把页面上显示的授权码复制回控制台，点「完成连接」。bot 自动重启生效，在 Lark 里发 `/status` 可以看到当前账号。

登录由服务器上以这个 bot 的系统用户运行的 `claude auth login` 完成：授权码只用一次，Claude Code 把它换成登录凭据，存在这个 bot 自己的配置目录（`/data/lark-channel/profiles/<bot>/claude-code/`）。bridge 不保存授权码，也不读取凭据。

备用（管理员）：卡片里「备用：在容器终端里登录」给出一条命令，`railway ssh` 进容器运行它，再点「我已在终端登录，连接」。

## 运维

- 日志：`railway logs`
- 升级 Claude Code / lark-cli：改 `Dockerfile` 里的 `CLAUDE_CODE_VERSION` / `LARK_CLI_VERSION`，重新部署
- 备份：Railway 的 volume Backups
- `railway.toml`（Config as Code）Railway 只支持到 2026-12-01，之前要迁到 `.railway/railway.ts`（`railway config migrate`）

## 7. 让同事自助使用（Lark 登录）

1. 准备一个登录用的 Lark 企业自建应用（可以复用现有的，比如「LibrAI AI 助手控制台」）：
   - 安全设置 → 重定向 URL：`https://<域名>/auth/lark/callback`
   - 版本管理与发布：可用范围选全部成员（或试点同事），发布。不在可用范围里的人登录会被 Lark 拒绝（错误码 20010）
2. 把它的凭证写进 Railway（secret 用 `--stdin`，粘贴后 Ctrl-D）：

   ```bash
   railway variable set LARK_CHANNEL_LOGIN_APP_ID=<App ID> LARK_CHANNEL_LOGIN_TENANT=lark --skip-deploys
   railway variable set --stdin LARK_CHANNEL_LOGIN_APP_SECRET --skip-deploys
   railway redeploy
   ```

3. 同事打开 `https://<域名>/`，点「用 Lark 登录」→ 扫码建自己的 bot → 在 bot 页面「连接我的 Claude 账号」（见第 6 步）。他们只看得到、只改得了自己的 bot。每人需要自己的 Claude 订阅（公司 Team 的席位，或个人 Pro / Max）。
4. （可选，默认不用）公司 API key：`railway variable set --stdin ANTHROPIC_API_KEY`。设了之后，没连自己账号的 bot 都用它（`/status` 显示「公司 API key」）。

可选变量：

| 变量 | 作用 |
|---|---|
| `LARK_CHANNEL_ADMINS` | 逗号分隔的 union_id，这些人用 Lark 登录后也是管理员（能看全部 bot） |
| `LARK_CHANNEL_LOGIN_TENANT_KEY` | 只允许这个租户的人登录（登录日志里有 tenant 尾号） |

## 安全须知

- 控制台 token 和 `LARK_CHANNEL_ADMINS` 里的人是管理员，能管理所有 bot。
- 每个 bot 用自己的系统用户运行（`LARK_CHANNEL_BOT_USERS=1`，uid 从 20001 起）：读不到别人的工作区、Claude 登录、lark-cli 凭证和 App Secret，也读不到 bridge 的配置、控制台 token 和会话密钥。bridge 本身是 root，只负责分配用户和整理文件权限。
- bot 仍以 `bypassPermissions` 运行，能在自己的目录里随意执行命令；公司 API key 在每个 bot 的环境里，任何一个同事的 bot 都能读到它。
- 登录会话 12 小时有效，签名密钥在 `/data/lark-channel/console-session.key`（只有 root 可读）。要立刻踢掉所有人：删掉这个文件后 `railway restart`。
- `/ps`、`/exit` 在多人模式下禁用（它们能看到、关掉别人的 bot）。

## 本地用 Docker 试跑

在仓库外建一个 `~/.lark-bridge.env`，放两行固定值（`LARK_CHANNEL_KEYSTORE_SECRET=…`、`LARK_CHANNEL_UI_TOKEN=…`，各自用 `openssl rand -hex 32` 生成一次）。放仓库外是为了不被提交、也不被打进镜像；仓库里的 `*.env` 已经在 `.gitignore` / `.dockerignore` 里。

```bash
docker build -t lark-bridge .
docker run --rm -p 8080:8080 -v lark-bridge-data:/data --env-file ~/.lark-bridge.env lark-bridge
```

然后打开 `http://localhost:8080/#token=<LARK_CHANNEL_UI_TOKEN>`。Docker Hub 拉不动时，构建加 `--build-arg NODE_IMAGE=m.daocloud.io/docker.io/library/node:22-bookworm-slim`。
