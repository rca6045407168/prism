/**
 * Artifact detection — scans assistant markdown for code blocks that are
 * worth rendering as a live preview rather than as syntax-highlighted
 * source. Three types supported in v0.1.18:
 *
 *   - html     → sandboxed iframe (full document or fragment)
 *   - svg      → inline SVG
 *   - mermaid  → rendered as SVG via the mermaid library, lazy-loaded
 *
 * Each artifact gets a stable id derived from (messageIndex, blockIndex)
 * so re-renders don't churn React keys.
 *
 * The detector is intentionally conservative — only fenced blocks with
 * an explicit language tag count. We don't try to "guess" HTML from raw
 * text.
 */

export type ArtifactType = "html" | "svg" | "mermaid";

export type Artifact = {
  id: string;
  type: ArtifactType;
  title: string;
  content: string;
};

const FENCE_RE = /```(\w+)\s*\n([\s\S]*?)\n```/g;

const SUPPORTED_LANGS: Record<string, ArtifactType> = {
  html: "html",
  htm: "html",
  svg: "svg",
  mermaid: "mermaid",
  mmd: "mermaid",
};

/**
 * Heuristic title for an artifact. For HTML we look for <title>, then
 * the first <h1>; for SVG we look for <title>; for mermaid we use the
 * diagram type ("flowchart", "sequenceDiagram", etc.). Falls back to
 * the language label.
 */
function titleFor(type: ArtifactType, content: string, fallback: number): string {
  if (type === "html") {
    const m =
      content.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ||
      content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m) {
      const text = m[1].replace(/<[^>]+>/g, "").trim();
      if (text) return text.slice(0, 60);
    }
    return `HTML preview ${fallback}`;
  }
  if (type === "svg") {
    const m = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) return m[1].trim().slice(0, 60);
    return `SVG preview ${fallback}`;
  }
  // mermaid — first non-empty line is usually the diagram type
  const firstLine = content.split("\n").find((l) => l.trim());
  if (firstLine) {
    const word = firstLine.trim().split(/\s+/)[0];
    return `Mermaid · ${word}`;
  }
  return `Mermaid ${fallback}`;
}

/**
 * Extract every supported artifact from a markdown blob. The `idPrefix`
 * is typically the index of the message in the chat so ids are stable
 * across re-renders.
 */
export function extractArtifacts(text: string, idPrefix: string): Artifact[] {
  if (!text) return [];
  const out: Artifact[] = [];
  let match: RegExpExecArray | null;
  // Reset regex state across calls
  FENCE_RE.lastIndex = 0;
  let blockIdx = 0;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const lang = (match[1] ?? "").toLowerCase();
    const body = match[2] ?? "";
    blockIdx += 1;
    const type = SUPPORTED_LANGS[lang];
    if (!type) continue;
    if (body.trim().length < 4) continue;
    out.push({
      id: `${idPrefix}-art-${blockIdx}`,
      type,
      title: titleFor(type, body, blockIdx),
      content: body,
    });
  }
  return out;
}
