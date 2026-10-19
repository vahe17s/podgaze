// Which page may use Podgaze's bridge: the app's own renderer, either from the dev server (development only) or
// from the bundled files next to main.js.
export function appUrlCheck(rendererRoot: string, devServer: boolean): (url: string) => boolean {
  return (url) => {
    if (!url) return false;
    if (!devServer) return url.startsWith(rendererRoot);
    try {
      return new URL(url).origin === rendererRoot;
    } catch {
      return false;
    }
  };
}

// A bridge call is trusted only from the main frame of an app page, never from an iframe or a navigated-to page.
export function fromAppFrame(event: unknown, isAppUrl: (url: string) => boolean): boolean {
  const frame = (event as { senderFrame?: { url?: string; parent?: unknown } | null } | null)?.senderFrame;
  return Boolean(frame && !frame.parent && isAppUrl(frame.url ?? ""));
}
