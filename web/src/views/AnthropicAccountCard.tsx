import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { AnthropicAccount } from "@/lib/types";
import { useMe } from "@/lib/me";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";

type Method = "claude-login" | "api-key";
type Busy = "connect" | "disconnect" | null;

// A Claude bot's own Anthropic account. Two ways in:
//  - Claude 账号登录: the bot gets its own Claude Code config dir; the user signs
//    it in with the official `claude auth login` (Anthropic's own flow — the
//    bridge never sees the credential), then connects it here.
//  - API key: pasted once, kept in the profile's encrypted keystore; this page
//    only ever sees a masked hint.
export function AnthropicAccountCard({ profile }: { profile: string }) {
  const me = useMe();
  // A Claude login is run over SSH in the container: an admin's job, not a colleague's.
  const methods: readonly Method[] = me.admin ? ["claude-login", "api-key"] : ["api-key"];
  const [account, setAccount] = useState<AnthropicAccount | null>(null);
  const [method, setMethod] = useState<Method>(methods[0] ?? "api-key");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<Busy>(null);

  const load = useCallback(async () => {
    try {
      const a = await apiGet<AnthropicAccount>(`/api/anthropic?profile=${encodeURIComponent(profile)}`);
      setAccount(a);
      if (a.connected && me.admin) setMethod(a.mode === "claude-login" ? "claude-login" : "api-key");
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    }
  }, [profile]);

  useEffect(() => {
    void load();
  }, [load]);

  async function change(kind: Busy, path: string, body: object, done: string) {
    setBusy(kind);
    try {
      const r = await apiPost<AnthropicAccount>(path, { profile, ...body });
      setApiKey("");
      setAccount((prev) => ({ ...r, loginCommand: prev?.loginCommand }));
      if (r.restartError) toast.warning(`${done}，但重启 bot 失败：${r.restartError}。请手动重启`);
      else toast.success(r.restarted ? `${done}，bot 已重启生效` : `${done}，下次启动 bot 时生效`);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
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
  const status = !connected
    ? account?.companyKey
      ? "没连接自己的账号：这个 bot 用公司的 API key。"
      : me.admin
        ? "未连接：这个 bot 用本机 claude 的登录。"
        : "还没有可用的 Claude 账号：在下面填你自己的 API key，或请管理员配置公司 API key。"
    : account?.mode === "claude-login"
      ? `这个 bot 用它自己的 Claude 账号登录${account.accountHint ? `（${account.accountHint}）` : ""}。`
      : `这个 bot 用你的 API key ${account?.keyHint ?? ""} 调用 Claude。`;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> Anthropic 账号
        </CardTitle>
        {connected ? (
          <Badge variant="success">已连接</Badge>
        ) : (
          <Badge variant="outline">{account?.companyKey ? "公司 API key" : me.admin ? "本机 claude 登录" : "未连接"}</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{status}</p>
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

        {method === "claude-login" ? (
          <div className="space-y-2">
            <p className="text-sm">1. 在终端运行下面的命令，浏览器里登录你的 Claude 账号（Pro / Max / Team / Enterprise）：</p>
            <div className="flex items-start gap-2">
              <code className="flex-1 break-all rounded-md border bg-muted px-3 py-2 text-xs">
                {account?.loginCommand ?? "…"}
              </code>
              <Button variant="outline" size="icon" aria-label="复制登录命令" onClick={copyLoginCommand}>
                <Copy />
              </Button>
            </div>
            <p className="text-sm">2. 登录完成后：</p>
            <Button
              disabled={busy !== null}
              onClick={() => void change("connect", "/api/anthropic/connect-login", {}, "已连接 Claude 账号")}
            >
              {busy === "connect" ? "检查登录中…" : connected && account?.mode === "claude-login" ? "重新检查并连接" : "我已登录，连接"}
            </Button>
            <p className="text-xs text-muted-foreground">
              这个 bot 有独立的 Claude Code 配置目录，不影响你本机 claude 的登录；登录全程在 Anthropic 官方流程里完成，bridge 拿不到凭据。
            </p>
          </div>
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

        {connected && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void change("disconnect", "/api/anthropic/disconnect", {}, "已断开，改用本机 claude 登录")}
          >
            {busy === "disconnect" ? "断开中…" : "断开，改用本机登录"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
