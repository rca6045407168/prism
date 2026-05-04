/**
 * Message renderer with markdown + syntax-highlighted code blocks + copy button.
 *
 * - User messages: rendered as plain text (no markdown — preserves exact input)
 * - Assistant messages: full GFM markdown, code blocks via prism-react-renderer
 * - System messages: plain text, italicized
 *
 * Each assistant message has a "Copy" button that copies the raw markdown.
 * Each code block has its own "Copy" button.
 */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes } from "prism-react-renderer";
import { ChatMessage, ToolEvent } from "./gateway";
import { Artifact } from "./artifacts";

/**
 * Convert a raw tool name like "mcp__claude_ai_Gmail__search_threads"
 * into a friendly two-part label: { provider, action }.
 *
 *   mcp__claude_ai_Gmail__search_threads   → { provider: "Gmail", action: "search threads" }
 *   mcp__plugin_woz_code__Search           → { provider: "WozCode", action: "Search" }
 *   Read                                   → { provider: null,    action: "Read" }
 */
function friendlyToolName(raw: string): { provider: string | null; action: string } {
  if (!raw.startsWith("mcp__")) {
    return { provider: null, action: raw };
  }
  const parts = raw.replace(/^mcp__/, "").split("__");
  // Provider segment may itself be underscore-joined (e.g. claude_ai_Gmail).
  // Heuristic: drop "claude_ai_" or "plugin_" prefixes, take what's left.
  let providerSeg = parts[0] ?? "";
  providerSeg = providerSeg.replace(/^claude_ai_/, "").replace(/^plugin_/, "");
  // Convert snake → spaces, leave PascalCase / Title Case alone
  const provider = providerSeg
    .split("_")
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
    .join(" ");
  const action = (parts[1] ?? "")
    .replace(/_/g, " ")
    .toLowerCase();
  return { provider: provider || null, action: action || "tool" };
}

function ToolStrip({ tools }: { tools: ToolEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tools.length === 0) return null;

  const running = tools.filter((t) => t.status === "running").length;
  const erroredCount = tools.filter((t) => t.status === "error").length;
  const summary =
    running > 0
      ? `Using ${running} tool${running === 1 ? "" : "s"}…`
      : `Used ${tools.length} tool${tools.length === 1 ? "" : "s"}`;

  return (
    <div className={`tools ${running > 0 ? "running" : "done"}`}>
      <button
        className="tools-summary"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Hide tool calls" : "Show tool calls"}
      >
        <span className={`tools-dot ${running > 0 ? "spin" : ""}`} />
        <span>{summary}</span>
        {erroredCount > 0 ? (
          <span className="tools-error-tag">{erroredCount} failed</span>
        ) : null}
        <span className="tools-caret">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded ? (
        <div className="tools-list">
          {tools.map((t) => {
            const { provider, action } = friendlyToolName(t.name);
            return (
              <div key={t.toolUseId} className={`tool-row tool-row-${t.status}`}>
                <div className="tool-row-head">
                  <span className="tool-icon">
                    {t.status === "running" ? "●" : t.status === "error" ? "✕" : "✓"}
                  </span>
                  {provider ? <span className="tool-provider">{provider}</span> : null}
                  <span className="tool-action">{action}</span>
                </div>
                {t.inputPreview ? (
                  <div className="tool-input">{t.inputPreview}</div>
                ) : null}
                {t.resultPreview ? (
                  <div className="tool-result">{t.resultPreview}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function isDarkTheme(): boolean {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark") return true;
  if (explicit === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function CodeBlock({ children, language }: { children: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  const theme = isDarkTheme() ? themes.vsDark : themes.github;

  return (
    <div className="codeblock">
      <div className="codeblock-header">
        <span className="codeblock-lang">{language || "text"}</span>
        <button className="codeblock-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <Highlight code={children.trimEnd()} language={language || "text"} theme={theme}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre className={`codeblock-pre ${className}`} style={style}>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

type Props = {
  message: ChatMessage;
  streaming?: boolean;
  onEdit?: (newText: string) => void;
  artifacts?: Artifact[];
  onOpenArtifact?: (a: Artifact) => void;
  activeArtifactId?: string | null;
};

export function Message({
  message,
  streaming = false,
  onEdit,
  artifacts = [],
  onOpenArtifact,
  activeArtifactId,
}: Props) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1400);
    } catch {
      /* ignore */
    }
  };

  const startEdit = () => {
    setDraft(message.text);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    if (draft.trim() && draft !== message.text && onEdit) {
      onEdit(draft.trim());
    }
  };

  if (message.role === "user") {
    if (editing) {
      return (
        <div className="msg user editing">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitEdit();
              }
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="msg-edit-hint">Enter saves + regenerates · Esc cancels</div>
        </div>
      );
    }
    return (
      <div className="msg user">
        {message.batch && (
          <div className="label batch">
            ▲ Batch · {message.batchCount} prompts in parallel
          </div>
        )}
        {message.text}
        {onEdit && (
          <button
            className="msg-edit"
            onClick={startEdit}
            title="Edit and regenerate from this point"
          >
            ✎ Edit
          </button>
        )}
      </div>
    );
  }

  if (message.role === "system") {
    return <div className="msg system">{message.text}</div>;
  }

  // Assistant — markdown render
  return (
    <div className={`msg assistant${streaming ? " streaming" : ""}`}>
      <button className="msg-copy" onClick={copyAll} title="Copy message">
        {copiedAll ? "Copied" : "Copy"}
      </button>
      {message.tools && message.tools.length > 0 ? (
        <ToolStrip tools={message.tools} />
      ) : null}
      {artifacts.length > 0 && onOpenArtifact ? (
        <div className="artifact-strip">
          {artifacts.map((a) => (
            <button
              key={a.id}
              className={`artifact-chip ${
                activeArtifactId === a.id ? "active" : ""
              }`}
              onClick={() => onOpenArtifact(a)}
              title={`Preview ${a.type.toUpperCase()}`}
            >
              <span className="artifact-chip-type">{a.type}</span>
              <span className="artifact-chip-title">{a.title}</span>
              <span className="artifact-chip-arrow">→</span>
            </button>
          ))}
        </div>
      ) : null}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || "");
            const lang = match ? match[1] : "";
            const content = String(children).replace(/\n$/, "");
            if (inline || !content.includes("\n")) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              );
            }
            return <CodeBlock language={lang}>{content}</CodeBlock>;
          },
          pre({ children }: any) {
            // CodeBlock renders its own <pre>; this is for non-code <pre>
            return <>{children}</>;
          },
          a({ href, children }: any) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href) window.open(href, "_blank");
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {message.text}
      </ReactMarkdown>
    </div>
  );
}
