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
        ) : (
          <MermaidRender content={artifact.content} />
        )}
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
