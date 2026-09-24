import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, KeyRound } from "lucide-react";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import type { AnthropicAccount, ClaudeLoginAttempt } from "@/lib/types";
import { useMe } from "@/lib/me";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";

type Method = "claude-login" | "api-key";
type Busy = "start" | "connect" | "disconnect" | null;

// A Claude bot's own account. Two ways in:
//  - Claude 账号登录: the bot has its own Claude Code config dir, signed in with
//    Anthropic's own `claude auth login`, which the server runs as the bot. This
//    card shows its sign-in address and hands the code from Anthropic's page back.
//  - API key (admins only): pasted once, kept in the profile's encrypted
//    keystore; this page only ever sees a masked hint.
export function AnthropicAccountCard({ profile }: { profile: string }) {
  const me = useMe();
  // Colleagues sign in with their own Claude account; keys are an admin's tool.
  const methods: readonly Method[] = me.admin ? ["claude-login", "api-key"] : ["claude-login"];
  const [account, setAccount] = useState<AnthropicAccount | null>(null);
  const [method, setMethod] = useState<Method>("claude-login");
  const [apiKey, setApiKey] = useState("");
  const [attempt, setAttempt] = useState<ClaudeLoginAttempt | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<Busy>(null);

  const load = useCallback(async () => {
    try {
      const a = await apiGet<AnthropicAccount>(`/api/anthropic?profile=${encodeURIComponent(profile)}`);
      setAccount(a);
      if (a.connected && me.admin) setMethod(a.mode === "claude-login" ? "claude-login" : "api-key");
    } catch (e) {
      toast.error(errorText(e));
    }
  }, [profile]);

  useEffect(() => {
    void load();
  }, [load]);

  function applied(r: AnthropicAccount, done: string) {
    setAccount((prev) => ({ ...r, loginCommand: prev?.loginCommand, companyKey: prev?.companyKey }));
    if (r.restartError) toast.warning(`${done}，但重启 bot 失败：${r.restartError}。请手动重启`);
    else toast.success(r.restarted ? `${done}，bot 已重启生效` : `${done}，bot 下次启动时生效`);
  }

  async function change(kind: Busy, path: string, body: object, done: string) {
    setBusy(kind);
    try {
      const r = await apiPost<AnthropicAccount>(path, { profile, ...body });
      setApiKey("");
      applied(r, done);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function startClaudeLogin() {
    setBusy("start");
    try {
      setAttempt(await apiPost<ClaudeLoginAttempt>("/api/anthropic/claude-login/start", { profile }));
      setCode("");
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function finishClaudeLogin() {
    if (!attempt || !code.trim()) return;
    setBusy("connect");
    try {
      const r = await apiPost<AnthropicAccount>("/api/anthropic/claude-login/finish", {
        profile,
        sessionId: attempt.sessionId,
        code: code.trim(),
      });
      setAttempt(null);
      setCode("");
      applied(r, `已连接 Claude 账号${r.accountHint ? `（${r.accountHint}）` : ""}`);
    } catch (e) {
      // 422: only the pasted text was off, the same sign-in takes another paste.
      if (!(e instanceof ApiError && e.status === 422)) setAttempt(null);
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  function cancelClaudeLogin() {
    if (attempt) {
      void apiPost("/api/anthropic/claude-login/cancel", { profile, sessionId: attempt.sessionId }).catch(() => {});
    }
    setAttempt(null);
    setCode("");
  }

  async function copyLoginCommand() {
    if (!account?.loginCommand) return;
    try {
      await navigator.clipboard.writeText(account.loginCommand);
      toast.success("已复制登录命令");
    } catch {
      toast.error("复制失败，请手动选中复制");
    }
  }

  const connected = account?.connected === true;
  const status = connected
    ? account?.mode === "claude-login"
      ? `这个 bot 用 Claude 账号${account.accountHint ? `（${account.accountHint}）` : ""}回复。`
      : `这个 bot 用 API key ${account?.keyHint ?? ""} 调用 Claude。`
    : account?.companyKey
      ? "没连接自己的账号：这个 bot 用公司的 API key。"
      : me.admin
        ? "未连接：这个 bot 用本机 claude 的登录。"
        : "还没连接 Claude 账号：连上你自己的 Claude 账号后，bot 才能回复你。";

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> Claude 账号
        </CardTitle>
        {connected ? (
          <Badge variant="success">已连接</Badge>
        ) : (
          <Badge variant="outline">{account?.companyKey ? "公司 API key" : me.admin ? "本机 claude 登录" : "未连接"}</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{status}</p>
        {methods.length > 1 && (
          <div className="flex gap-2" role="tablist" aria-label="连接方式">
            {methods.map((m) => (
              <Button
                key={m}
                role="tab"
                aria-selected={method === m}
                size="sm"
                variant={method === m ? "default" : "outline"}
                onClick={() => setMethod(m)}
              >
                {m === "claude-login" ? "Claude 账号登录" : "API Key"}
              </Button>
            ))}
          </div>
        )}

        {method === "claude-login" ? (
          attempt ? (
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              <li className="space-y-1.5">
                <p>打开 Claude 登录页，用你的 Claude 账号（Pro / Max / Team）登录，点「Authorize」授权。Team 账号请选公司的组织。</p>
                <Button asChild size="sm">
                  <a href={attempt.url} target="_blank" rel="noopener noreferrer">
                    打开 Claude 登录页 <ExternalLink />
                  </a>
                </Button>
              </li>
              <li className="space-y-1.5">
                <p>授权后页面会显示一串授权码（Authentication Code），复制后粘贴到这里：</p>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (busy === null) void finishClaudeLogin();
                  }}
                >
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Claude 授权码"
                    placeholder="粘贴授权码"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <Button type="submit" disabled={!code.trim() || busy !== null}>
                    {busy === "connect" ? "连接中…" : "完成连接"}
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">
                  10 分钟内有效。
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto px-1 py-0 text-xs"
                    disabled={busy === "connect"}
                    onClick={cancelClaudeLogin}
                  >
                    取消
                  </Button>
                </p>
              </li>
            </ol>
          ) : (
            <div className="space-y-2">
              <Button disabled={busy !== null} onClick={() => void startClaudeLogin()}>
                {busy === "start"
                  ? "准备中…"
                  : connected && account?.mode === "claude-login"
                    ? "换一个 Claude 账号"
                    : "连接我的 Claude 账号"}
              </Button>
              <p className="text-xs text-muted-foreground">
                在 Claude 官方页面登录。授权码只用一次，由 Claude Code 换成登录凭据，存在这个 bot 自己的目录里，别的 bot 读不到。
              </p>
              {me.admin && account?.loginCommand && (
                <details className="space-y-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">备用：在容器终端里登录</summary>
                  <div className="mt-2 flex items-start gap-2">
                    <code className="flex-1 break-all rounded-md border bg-muted px-3 py-2">{account.loginCommand}</code>
                    <Button variant="outline" size="icon" aria-label="复制登录命令" onClick={copyLoginCommand}>
                      <Copy />
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    disabled={busy !== null}
                    onClick={() => void change("connect", "/api/anthropic/connect-login", {}, "已连接 Claude 账号")}
                  >
                    我已在终端登录，连接
                  </Button>
                </details>
              )}
            </div>
          )
        ) : (
          <div className="space-y-2">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (apiKey.trim() && busy === null) {
                  void change("connect", "/api/anthropic/connect", { apiKey: apiKey.trim() }, "已连接 Anthropic 账号");
                }
              }}
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Anthropic API Key"
                placeholder="sk-ant-api03-…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <Button type="submit" disabled={!apiKey.trim() || busy !== null}>
                {busy === "connect" ? "校验中…" : connected && account?.mode !== "claude-login" ? "更换" : "连接"}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">
              只接受 Claude Console（platform.claude.com）创建的 API key。保存前会先向 Anthropic 校验，只加密存在本机，页面只显示掩码。
            </p>
          </div>
        )}

        {connected && !attempt && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void change("disconnect", "/api/anthropic/disconnect", {}, "已断开")}
          >
            {busy === "disconnect" ? "断开中…" : "断开"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function errorText(e: unknown): string {
  return String((e as Error).message ?? e);
}
