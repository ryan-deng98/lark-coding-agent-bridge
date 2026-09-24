import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { MeContext } from "@/lib/me";
import type { Me, OnboardState, Status } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { ProfilesView } from "@/views/ProfilesView";
import { ProfileDetail } from "@/views/ProfileDetail";
import { OnboardWizard } from "@/views/OnboardWizard";

const LOGIN_ERRORS: Record<string, string> = {
  denied: "你取消了授权，没有登录。",
  expired: "登录超时了，请重新登录。",
  failed: "登录没有成功，请稍后再试；一直不行的话请联系管理员。",
};

// Lark sends a failed sign-in back as ?login_error=<reason>: show it once, then drop it from the URL.
function takeLoginError(): string | null {
  const query = new URLSearchParams(location.search);
  const code = query.get("login_error");
  if (!code) return null;
  query.delete("login_error");
  const search = query.toString();
  history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
  return LOGIN_ERRORS[code] ?? LOGIN_ERRORS.failed ?? null;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginError] = useState(takeLoginError);
  const [onboard, setOnboard] = useState<OnboardState | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await apiGet<Me>("/api/me"));
      const os = await apiGet<OnboardState>("/api/onboard/state");
      setOnboard(os);
      if (os.hasConfig) {
        setStatus(await apiGet<Status>("/api/status").catch(() => null));
      }
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && e.login) {
        setLoginUrl(e.login);
        return;
      }
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (loginUrl) return <Shell><SignIn loginUrl={loginUrl} error={loginError} /></Shell>;
  if (error) return <Shell><p className="text-destructive text-sm">加载失败：{error}</p></Shell>;
  if (!onboard || !me) return <Shell><p className="text-muted-foreground text-sm">加载中…</p></Shell>;

  return (
    <MeContext.Provider value={me}>
      <Shell>
        <SignedInAs me={me} />
        {!onboard.hasConfig ? (
          <Card>
            <CardHeader><CardTitle>{me.kind === "user" ? "创建你的 AI 助手" : "初始化 AI 助手"}</CardTitle></CardHeader>
            <CardContent>
              <OnboardWizard onCreated={() => void refresh()} />
            </CardContent>
          </Card>
        ) : selected ? (
          <ProfileDetail profile={selected} onBack={() => { setSelected(null); void refresh(); }} />
        ) : (
          <>
            <ProfilesView onOpen={setSelected} />
            {status && (
              <p className="mt-6 text-xs text-muted-foreground">
                单主进程托管所有 profile · v{status.version} · {status.online} 个在线 · 改在线 profile 的配置即时生效
              </p>
            )}
          </>
        )}
        <Toaster />
      </Shell>
    </MeContext.Provider>
  );
}

function SignIn({ loginUrl, error }: { loginUrl: string; error: string | null }) {
  return (
    <Card>
      <CardHeader><CardTitle>Lark AI 助手控制台</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">用你的 Lark 账号登录，创建和管理你自己的 AI 助手。</p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={() => { location.href = loginUrl; }}>用 Lark 登录</Button>
      </CardContent>
    </Card>
  );
}

function SignedInAs({ me }: { me: Me }) {
  if (me.kind !== "user") return null;
  return (
    <div className="mb-4 flex items-center justify-end gap-3 text-sm text-muted-foreground">
      <span>{me.name}{me.admin ? "（管理员）" : ""}</span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void apiPost("/auth/logout", {}).finally(() => location.reload())}
      >
        退出
      </Button>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-3xl p-6">{children}</div>;
}
