/**
 * File/image attachment helpers for the composer (v0.1.25).
 *
 * The chat path: a File from drag-drop or <input> is read into an
 * ArrayBuffer, base64-encoded, and IPC'd to main.ts which writes it
 * to <userData>/uploads/<chatId>/<timestamped-name> and returns the
 * absolute path. On send, we prepend `@<path>` references to the
 * user's message so claude's Read tool pulls the file inline.
 */

export type AttachedFile = {
  id: string;
  name: string;
  path: string;          // absolute path on disk after save
  sizeBytes: number;
  mimeType: string;
  previewUrl?: string;   // object URL (for images), revoke when removed
};

export const MAX_ATTACHMENTS_PER_TURN = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Chunked ArrayBuffer → base64. Avoids the spread-into-args crash that
 * fires on files >~64KB with the naive `btoa(String.fromCharCode(...))`.
 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Save a single File via IPC. Returns the persisted AttachedFile or
 * `null` on failure. The error string is logged so the caller can
 * decide whether to surface it.
 */
export async function saveAttachment(
  chatId: string,
  file: File,
): Promise<AttachedFile | null> {
  if (file.size > MAX_FILE_BYTES) {
    console.warn(
      `[attachments] ${file.name} (${humanBytes(file.size)}) exceeds cap`,
    );
    return null;
  }
  try {
    const buf = await file.arrayBuffer();
    const dataBase64 = arrayBufferToBase64(buf);
    const result = await window.flexhaul.files.save({
      chatId,
      fileName: file.name,
      dataBase64,
    });
    if (!result.ok) {
      console.warn(`[attachments] save failed: ${result.error}`);
      return null;
    }
    const att: AttachedFile = {
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: file.name,
      path: result.path,
      sizeBytes: result.sizeBytes,
      mimeType: file.type || "application/octet-stream",
      previewUrl: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined,
    };
    return att;
  } catch (e) {
    console.warn("[attachments] threw", e);
    return null;
  }
}

/** Compose the user message with attachment references for claude to
 *  Read inline. Format chosen to be unambiguous to claude's tooling. */
export function buildMessageWithAttachments(
  text: string,
  attached: AttachedFile[],
): string {
  if (attached.length === 0) return text;
  const refs = attached
    .map((a) => `- @${a.path} (${humanBytes(a.sizeBytes)}, ${a.mimeType || "file"})`)
    .join("\n");
  // Header explicit so claude doesn't confuse paths with user-quoted
  // text. claude's Read tool picks these up because `@<absolute-path>`
  // is the standard syntax it scans for.
  return `${text}\n\nAttached files (please Read these as part of answering):\n${refs}`;
}
