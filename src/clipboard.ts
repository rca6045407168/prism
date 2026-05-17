/**
 * v0.1.59 — clipboard helper with IPC fallback.
 *
 * `navigator.clipboard.writeText` silently fails in Electron renderers
 * under several focus / policy / CSP edge cases. Every clipboard write
 * in the app routes through here, which tries the browser API first
 * and falls back to the main-process Electron clipboard via IPC.
 *
 * Returns true on success, false if both paths failed.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // v0.1.60: prefer the Electron main-process clipboard whenever it's
  // available. navigator.clipboard.writeText resolves *without writing*
  // when the renderer doesn't have document focus — a silent half-fail
  // that v0.1.59's try/catch fallback never tripped. The Electron
  // main-process path always works.
  if (typeof window !== "undefined" && (window as any).flexhaul?.clipboard?.write) {
    try {
      const res = await window.flexhaul.clipboard.write(text);
      if ("ok" in res && res.ok === true) return true;
    } catch {
      /* fall through to browser API */
    }
  }
  // Browser fallback (only path outside Electron — dev mode in a
  // standalone browser, future web build, etc.).
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
