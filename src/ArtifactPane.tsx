/**
 * Artifact preview pane — renders HTML / SVG / Mermaid in a side panel.
 *
 *  - HTML lands in a sandboxed iframe with srcDoc, no scripts allowed
 *    by default (sandbox="allow-same-origin" but no allow-scripts —
 *    the user can opt in via the "Allow scripts" toggle).
 *  - SVG renders inline by setting the wrapper's innerHTML; we sanitize
 *    by parsing through DOMParser and stripping <script>.
 *  - Mermaid lazy-loads the library from a CDN on first use, then
 *    renders to an inline <svg>.
 *
 * "View source" toggles to a syntax-highlighted source block.
 */
import { useEffect, useRef, useState } from "react";
import { Artifact } from "./artifacts";

type Props = {
  artifact: Artifact;
  onClose: () => void;
};

export function ArtifactPane({ artifact, onClose }: Props) {
  const [showSource, setShowSource] = useState(false);
  const [allowScripts, setAllowScripts] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(artifact.content);
    } catch {
      /* ignore */
    }
  };

  return (
    <aside className="artifact-pane">
      <div className="artifact-header">
        <div className="artifact-title">
          <span className="artifact-type">{artifact.type.toUpperCase()}</span>
          <span>{artifact.title}</span>
        </div>
        <div className="artifact-actions">
          {artifact.type === "html" ? (
            <label className="artifact-toggle" title="Allow inline scripts in HTML preview">
              <input
                type="checkbox"
                checked={allowScripts}
                onChange={(e) => setAllowScripts(e.target.checked)}
              />
              scripts
            </label>
          ) : null}
          <button onClick={() => setShowSource((v) => !v)} title="Toggle source view">
            {showSource ? "Preview" : "Source"}
          </button>
          <button onClick={copy} title="Copy source">Copy</button>
          <button onClick={onClose} title="Close" className="artifact-close">×</button>
        </div>
      </div>
      <div className="artifact-body">
        {showSource ? (
          <pre className="artifact-source">{artifact.content}</pre>
        ) : artifact.type === "html" ? (
          <HtmlRender content={artifact.content} allowScripts={allowScripts} />
        ) : artifact.type === "svg" ? (
          <SvgRender content={artifact.content} />
        ) : artifact.type === "mermaid" ? (
          <MermaidRender content={artifact.content} />
        ) : artifact.type === "diff" ? (
          <DiffRender content={artifact.content} />
        ) : artifact.type === "python" ? (
          <PythonRender content={artifact.content} />
        ) : null}
      </div>
    </aside>
  );
}

function HtmlRender({
  content,
  allowScripts,
}: {
  content: string;
  allowScripts: boolean;
}) {
  // Wrap fragments in a minimal document so styles compute correctly.
  const wrapped = /<html[\s>]/i.test(content)
    ? content
    : `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,sans-serif;padding:16px;color:#111;background:#fff}</style></head><body>${content}</body></html>`;
  const sandbox = allowScripts
    ? "allow-scripts allow-same-origin"
    : "allow-same-origin";
  return (
    <iframe
      title="artifact"
      className="artifact-frame"
      sandbox={sandbox}
      srcDoc={wrapped}
    />
  );
}

function SvgRender({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    // Parse + strip <script> for a cheap sanitizer; this is preview, not
    // load-bearing security. The HTML iframe is the secure path.
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, "image/svg+xml");
      const errs = doc.querySelector("parsererror");
      if (errs) {
        ref.current.textContent = "SVG parse error: " + errs.textContent;
        return;
      }
      doc.querySelectorAll("script").forEach((el) => el.remove());
      ref.current.innerHTML = "";
      const svg = doc.documentElement;
      // Make it stretch to fit the pane
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      ref.current.appendChild(doc.adoptNode(svg));
    } catch (e: any) {
      ref.current.textContent = "Failed to render SVG: " + (e?.message ?? e);
    }
  }, [content]);
  return <div ref={ref} className="artifact-svg" />;
}

let mermaidLoadPromise: Promise<any> | null = null;

function loadMermaid(): Promise<any> {
  if (mermaidLoadPromise) return mermaidLoadPromise;
  mermaidLoadPromise = new Promise((resolve, reject) => {
    if ((window as any).mermaid) {
      resolve((window as any).mermaid);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js";
    script.async = true;
    script.onload = () => {
      const mermaid = (window as any).mermaid;
      if (!mermaid) {
        reject(new Error("mermaid loaded but global is missing"));
        return;
      }
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.getAttribute("data-theme") === "dark" ||
            window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "default",
          securityLevel: "strict",
        });
      } catch {
        /* ignore */
      }
      resolve(mermaid);
    };
    script.onerror = () => reject(new Error("Failed to load mermaid from CDN"));
    document.head.appendChild(script);
  });
  return mermaidLoadPromise;
}

// v0.1.20: split-view + intra-line diff via react-diff-viewer-continued.
// Falls back to the original line-prefix classifier for shorthand
// +/- diffs that don't have @@ hunks.
function DiffRender({ content }: { content: string }) {
  const [splitView, setSplitView] = useState(true);
  const parsed = parseUnifiedDiff(content);
  if (parsed.kind === "fallback") {
    return <FallbackDiff content={content} />;
  }
  return (
    <div className="artifact-diff">
      <div className="artifact-diff-toolbar">
        <label className="artifact-diff-toggle">
          <input
            type="checkbox"
            checked={splitView}
            onChange={(e) => setSplitView(e.target.checked)}
          />
          split view
        </label>
        {parsed.path ? (
          <span className="artifact-diff-path">{parsed.path}</span>
        ) : null}
      </div>
      <DiffViewerLazy
        oldValue={parsed.oldText}
        newValue={parsed.newText}
        splitView={splitView}
      />
    </div>
  );
}

// Lazy-load react-diff-viewer-continued (~150KB gzipped). Most chats
// never open a diff; pulling it into the critical-path bundle would
// be wasteful.
let _diffViewerLoadPromise: Promise<any> | null = null;
function loadDiffViewer(): Promise<any> {
  if (_diffViewerLoadPromise) return _diffViewerLoadPromise;
  _diffViewerLoadPromise = import("react-diff-viewer-continued").then(
    (mod) => mod.default,
  );
  return _diffViewerLoadPromise;
}

function DiffViewerLazy({
  oldValue,
  newValue,
  splitView,
}: {
  oldValue: string;
  newValue: string;
  splitView: boolean;
}) {
  const [Comp, setComp] = useState<any>(null);
  useEffect(() => {
    let cancelled = false;
    loadDiffViewer().then((c) => {
      if (!cancelled) setComp(() => c);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!Comp) {
    return <div className="artifact-diff-loading">Loading diff viewer…</div>;
  }
  const dark =
    document.documentElement.getAttribute("data-theme") === "dark" ||
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return (
    <Comp
      oldValue={oldValue}
      newValue={newValue}
      splitView={splitView}
      useDarkTheme={dark}
      hideLineNumbers={false}
      compareMethod={"diffWords"}
    />
  );
}

// Reconstruct old + new sides of a unified diff so the viewer can
// render them in split view. Returns "fallback" for shorthand +/-
// diffs that don't have @@ hunks.
function parseUnifiedDiff(content: string): {
  kind: "ok";
  oldText: string;
  newText: string;
  path: string | null;
} | { kind: "fallback" } {
  const lines = content.split("\n");
  const hasHunk = lines.some((l) => l.startsWith("@@"));
  if (!hasHunk) return { kind: "fallback" };

  let path: string | null = null;
  const pathMatch =
    content.match(/^\+\+\+ b\/([^\n]+)/m) ||
    content.match(/^\+\+\+ ([^\n]+)/m);
  if (pathMatch) path = pathMatch[1].trim();

  const oldParts: string[] = [];
  const newParts: string[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) {
      if (oldParts.length > 0) oldParts.push("");
      if (newParts.length > 0) newParts.push("");
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      newParts.push(line.slice(1));
    } else if (line.startsWith("-")) {
      oldParts.push(line.slice(1));
    } else if (line.startsWith(" ") || line === "") {
      const ctx = line.startsWith(" ") ? line.slice(1) : line;
      oldParts.push(ctx);
      newParts.push(ctx);
    }
  }

  return {
    kind: "ok",
    oldText: oldParts.join("\n"),
    newText: newParts.join("\n"),
    path,
  };
}

// Safety net for shorthand +/- diffs without @@ hunks — same
// classifier as v0.1.19's original DiffRender.
function FallbackDiff({ content }: { content: string }) {
  const lines = content.split("\n");
  const rendered = lines.map((line, i) => {
    let cls = "diff-context";
    let prefix = "";
    if (line.startsWith("+++") || line.startsWith("---")) {
      cls = "diff-fileheader";
    } else if (line.startsWith("@@")) {
      cls = "diff-hunk";
    } else if (line.startsWith("+")) {
      cls = "diff-add";
      prefix = "+";
    } else if (line.startsWith("-")) {
      cls = "diff-del";
      prefix = "-";
    } else if (line.startsWith(" ")) {
      cls = "diff-context";
    }
    return (
      <div key={i} className={`diff-line ${cls}`}>
        {prefix ? <span className="diff-prefix">{prefix}</span> : null}
        <span className="diff-text">
          {prefix ? line.slice(1) : line || " "}
        </span>
      </div>
    );
  });
  return (
    <div className="artifact-diff artifact-diff-fallback">{rendered}</div>
  );
}

/**
 * PythonRender — runs Python in the browser via Pyodide, lazy-loaded
 * from CDN on first use. Manual "Run" button (no auto-execute, since
 * Python can have side effects). Output captures stdout + stderr.
 */
let pyodideLoadPromise: Promise<any> | null = null;

function loadPyodide(): Promise<any> {
  if (pyodideLoadPromise) return pyodideLoadPromise;
  pyodideLoadPromise = new Promise((resolve, reject) => {
    if ((window as any).pyodide) {
      resolve((window as any).pyodide);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.js";
    script.async = true;
    script.onload = async () => {
      try {
        const py = await (window as any).loadPyodide({
          indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/",
        });
        (window as any).pyodide = py;
        resolve(py);
      } catch (e) {
        reject(e);
      }
    };
    script.onerror = () => reject(new Error("Failed to load Pyodide from CDN"));
    document.head.appendChild(script);
  });
  return pyodideLoadPromise;
}

function PythonRender({ content }: { content: string }) {
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMsg, setLoadingMsg] = useState<string>("");

  const run = async () => {
    setRunning(true);
    setError(null);
    setOutput("");
    setLoadingMsg("Loading Python runtime…");
    try {
      const py = await loadPyodide();
      setLoadingMsg("Running…");
      const captured: string[] = [];
      py.setStdout({ batched: (s: string) => captured.push(s) });
      py.setStderr({ batched: (s: string) => captured.push(s) });
      const result = await py.runPythonAsync(content);
      const stdoutText = captured.join("");
      const resultText =
        result === undefined || result === null
          ? ""
          : typeof result === "object"
          ? (() => {
              try { return result.toString(); } catch { return String(result); }
            })()
          : String(result);
      const combined =
        (stdoutText.trim() ? stdoutText : "") +
        (resultText && resultText !== "undefined" && resultText !== "null"
          ? (stdoutText.trim() ? "\n" : "") + resultText
          : "");
      setOutput(combined || "(no output)");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRunning(false);
      setLoadingMsg("");
    }
  };

  return (
    <div className="artifact-python">
      <div className="artifact-python-toolbar">
        <button
          className="artifact-python-run"
          onClick={run}
          disabled={running}
        >
          {running ? "Running…" : "▶ Run"}
        </button>
        {loadingMsg ? (
          <span className="artifact-python-status">{loadingMsg}</span>
        ) : null}
      </div>
      <pre className="artifact-python-source">{content}</pre>
      {output ? (
        <div className="artifact-python-output">
          <div className="artifact-python-output-label">Output</div>
          <pre>{output}</pre>
        </div>
      ) : null}
      {error ? <div className="artifact-error">{error}</div> : null}
      <div className="artifact-python-note">
        Sandboxed execution via Pyodide. No filesystem or network access.
        Python runtime (~10MB) loads from CDN on first run, then cached.
      </div>
    </div>
  );
}

function MermaidRender({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!ref.current) return;
    ref.current.textContent = "Loading diagram…";

    loadMermaid()
      .then(async (mermaid) => {
        if (cancelled || !ref.current) return;
        try {
          // mermaid 10's render returns { svg, bindFunctions }
          const id = `mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const { svg } = await mermaid.render(id, content);
          if (cancelled || !ref.current) return;
          ref.current.innerHTML = svg;
        } catch (e: any) {
          if (cancelled) return;
          setError(e?.message ?? String(e));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message ?? String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [content]);

  return (
    <div className="artifact-mermaid">
      <div ref={ref} className="artifact-mermaid-svg" />
      {error ? <div className="artifact-error">{error}</div> : null}
    </div>
  );
}
