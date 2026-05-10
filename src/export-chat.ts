/**
 * Markdown export for a Prism chat (v0.1.25).
 *
 * Serializes a chat's full message history to a clean markdown file
 * the user can paste into Obsidian / share via gist / archive. Lives
 * renderer-side because everything we need is already in localStorage;
 * no IPC required.
 */
import { Chat, ChatMessage } from "./chats";

function ts(d: number | string | Date): string {
  return new Date(d).toISOString().replace("T", " ").slice(0, 19);
}

function serializeMessage(m: ChatMessage): string {
  const role =
    m.role === "user" ? "## User" :
    m.role === "assistant" ? "## Prism" :
    "## System";
  const batchTag =
    m.batch && m.role === "user"
      ? `\n\n_▲ Batch · ${m.batchCount ?? "?"} prompts in parallel_`
      : "";
  const toolsTag =
    m.tools && m.tools.length > 0 && m.role === "assistant"
      ? `\n\n_Tools used: ${m.tools
          .map((t) => t.name + (t.status === "error" ? " (failed)" : ""))
          .join(", ")}_`
      : "";
  return `${role}${batchTag}\n\n${m.text}${toolsTag}`;
}

export function chatToMarkdown(chat: Chat): string {
  const header = [
    `# ${chat.title}`,
    "",
    `_Exported from Prism · ${ts(new Date())}_`,
    `_Chat created: ${ts(chat.createdAt)}_`,
    `_Messages: ${chat.messages.length}_`,
    "",
    "---",
    "",
  ].join("\n");

  const body = chat.messages.map(serializeMessage).join("\n\n---\n\n");

  return header + body + "\n";
}

/** Trigger a browser download for the given chat. Pure renderer; no IPC. */
export function downloadChatAsMarkdown(chat: Chat): void {
  const md = chatToMarkdown(chat);
  const safeTitle = chat.title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  const filename = `prism-${safeTitle || "chat"}-${ts(new Date()).slice(0, 10)}.md`;
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
