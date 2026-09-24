const TOKEN_KEY = "lark-bridge-ui-token";

// The console link carries the token as `#token=` (a fragment never reaches the
// server, so it stays out of proxy and access logs) or, for local links, `?token=`.
// Keep it for this tab and strip it from the address bar so it isn't left in history.
function takeToken(): string {
  const query = new URLSearchParams(location.search);
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("token") ?? query.get("token");
  if (!fromLink) {
    try {
      return sessionStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
      return "";
    }
  }
  try {
    sessionStorage.setItem(TOKEN_KEY, fromLink);
  } catch {
    // Storage blocked: the token still works for this page load.
  }
  query.delete("token");
  const search = query.toString();
  history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}`);
  return fromLink;
}

const TOKEN = takeToken();

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "x-ui-token": TOKEN,
      "content-type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      (data.error as string) || `HTTP ${res.status}`,
      res.status,
      typeof data.login === "string" ? data.login : undefined,
    );
  }
  return data as T;
}

/** A failed console call; `login` is where to sign in when the session is missing. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly login?: string,
  ) {
    super(message);
  }
}

export const apiGet = <T = unknown>(path: string) => api<T>(path);
export const apiPost = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
