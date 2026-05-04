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
import { ChatMessage } from "./gateway";

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
};

export function Message({ message, streaming = false }: Props) {
  const [copiedAll, setCopiedAll] = useState(false);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1400);
    } catch {
      /* ignore */
    }
  };

  if (message.role === "user") {
    return (
      <div className="msg user">
        {message.batch && (
          <div className="label batch">
            ▲ Batch · {message.batchCount} prompts in parallel
          </div>
        )}
        {message.text}
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
