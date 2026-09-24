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

1. 控制台 → bot 详情 →「Anthropic 账号」→「Claude 账号登录」，复制登录命令。
2. 进容器：

   ```bash
   railway ssh
   ```

   粘贴登录命令，在浏览器里登录 Claude（Pro / Max / Team / Enterprise），把页面给的 code 粘回终端。
3. 回控制台点「我已登录，连接」，bot 自动重启生效。在 Lark 里发 `/status` 可以看到当前账号。

凭据保存在这个 bot 自己的配置目录（`/data/lark-channel/profiles/<bot>/claude-code/`），bridge 不读取它。

## 运维

- 日志：`railway logs`
- 升级 Claude Code / lark-cli：改 `Dockerfile` 里的 `CLAUDE_CODE_VERSION` / `LARK_CLI_VERSION`，重新部署
- 备份：Railway 的 volume Backups
- `railway.toml`（Config as Code）Railway 只支持到 2026-12-01，之前要迁到 `.railway/railway.ts`（`railway config migrate`）

## 安全须知

- 控制台 token 等于所有 bot 的管理权：能创建 bot、改配置，而 bot 能在容器里执行命令。
- bot 在容器里以 `bypassPermissions` 运行（容器就是沙箱：root 用户，`IS_SANDBOX=1`）。所有 bot 在同一个容器里，彼此能读到对方的工作区和登录凭据。给全公司自助使用之前，需要按人登录控制台、按人隔离容器（下一阶段）。

## 本地用 Docker 试跑

在仓库外建一个 `~/.lark-bridge.env`，放两行固定值（`LARK_CHANNEL_KEYSTORE_SECRET=…`、`LARK_CHANNEL_UI_TOKEN=…`，各自用 `openssl rand -hex 32` 生成一次）。放仓库外是为了不被提交、也不被打进镜像；仓库里的 `*.env` 已经在 `.gitignore` / `.dockerignore` 里。

```bash
docker build -t lark-bridge .
docker run --rm -p 8080:8080 -v lark-bridge-data:/data --env-file ~/.lark-bridge.env lark-bridge
```

然后打开 `http://localhost:8080/#token=<LARK_CHANNEL_UI_TOKEN>`。Docker Hub 拉不动时，构建加 `--build-arg NODE_IMAGE=m.daocloud.io/docker.io/library/node:22-bookworm-slim`。
