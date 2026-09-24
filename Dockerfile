# lark-channel-bridge on a container platform (Railway, Docker): the supervisor
# + web console hosting every bot, with all state on a volume at /data.
# See docs/deploy-railway.md.

# Behind a registry mirror: --build-arg NODE_IMAGE=<mirror>/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build the CLI and the inlined web console ----
FROM ${NODE_IMAGE} AS build
RUN npm install -g pnpm@10.33.0
WORKDIR /app
COPY . .
# `prepare` builds dist/ (web console + CLI) as part of the install.
RUN pnpm install --frozen-lockfile

# ---- production dependencies only ----
FROM ${NODE_IMAGE} AS deps
RUN npm install -g pnpm@10.33.0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# ---- runtime ----
FROM ${NODE_IMAGE}
# Pinned so a redeploy never silently changes the agent or its tools under the bots.
# lark-cli lets the agent send cards and use the Lark APIs (calendar, docs, tasks...).
ARG CLAUDE_CODE_VERSION=2.1.280
ARG LARK_CLI_VERSION=1.0.96
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@larksuite/cli@${LARK_CLI_VERSION}" \
  && npm cache clean --force

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY package.json ./
COPY docker/entrypoint.sh /usr/local/bin/bridge-entrypoint
RUN chmod +x /usr/local/bin/bridge-entrypoint /app/bin/lark-channel-bridge.mjs \
  && ln -s /app/bin/lark-channel-bridge.mjs /usr/local/bin/lark-channel-bridge

# State lives on the volume at /data: bots, their encrypted secrets, each bot's
# own Claude Code login and its workspaces. Several people's bots share this
# container, so each bot's agent and tools run as its own OS user
# (LARK_CHANNEL_BOT_USERS); the bridge itself stays root to set them up.
ENV NODE_ENV=production \
    LARK_CHANNEL_HOME=/data/lark-channel \
    LARK_CHANNEL_UI_HOST=0.0.0.0 \
    LARK_CHANNEL_BOT_USERS=1 \
    DISABLE_AUTOUPDATER=1 \
    IS_SANDBOX=1

ENTRYPOINT ["/usr/bin/tini", "--", "bridge-entrypoint"]
