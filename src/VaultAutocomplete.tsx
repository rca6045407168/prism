/**
 * Vault autocomplete dropdown (v0.1.40).
 *
 * Triggers when the user types `[[` in the composer textarea. Shows a
 * fuzzy-matched list of notes from `~/Documents/Obsidian Vault/`.
 * Selecting one replaces the `[[<fragment>` with `[[<title>]]` in the
 * textarea AND attaches the note's body as turn context (so claude can
 * see it on send).
 *
 * Design echo: same shape + keyboard model as SlashCommandMenu.tsx.
 * Renders above the composer (`bottom: 60px` from the composer top).
 *
 * Why client-side fuzzy match: the vault is bounded to ~1500 notes, and
 * a single pass through the list takes <2ms. A server-side index would
 * be overkill and add latency to the typeahead.
 */
import { useEffect, useMemo, useState } from "react";

export type VaultNote = {
  title: string;
  relPath: string;
  absPath: string;
  mtimeMs: number;
};

type Props = {
  open: boolean;
  query: string;
  notes: VaultNote[];
  selectedIndex: number;
  onSelect: (note: VaultNote) => void;
  onHoverIndex: (i: number) => void;
};

/** Score a candidate against the query. Used for ranking. Returns 0 for
 *  no match. Higher = better. Mirrors slash-command scoring shape. */
function score(title: string, q: string): number {
  if (!q) return 1; // unqueried — show all by recency
  const t = title.toLowerCase();
  const query = q.toLowerCase();
  if (t === query) return 1000;
  if (t.startsWith(query)) return 500 - title.length;
  const idx = t.indexOf(query);
  if (idx >= 0) return 200 - idx;
  // character-fuzzy fallback (subsequence)
  let i = 0;
  for (const ch of t) {
    if (ch === query[i]) i += 1;
    if (i >= query.length) return 50 - title.length;
  }
  return 0;
}

const MAX_RESULTS = 8;

export function rankVaultNotes(
  notes: VaultNote[],
  query: string,
): VaultNote[] {
  const scored = notes
    .map((n) => ({ n, s: score(n.title, query) }))
    .filter((x) => x.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s ||
        // tie-break: recency (mtime desc)
        b.n.mtimeMs - a.n.mtimeMs,
    )
    .slice(0, MAX_RESULTS);
  return scored.map((x) => x.n);
}

export function VaultAutocomplete({
  open,
  query,
  notes,
  selectedIndex,
  onSelect,
  onHoverIndex,
}: Props) {
  // Cap the visible list to MAX_RESULTS for UI stability.
  const ranked = useMemo(() => rankVaultNotes(notes, query), [notes, query]);
  if (!open || ranked.length === 0) return null;
  const safeIdx = Math.max(0, Math.min(selectedIndex, ranked.length - 1));
  return (
    <div className="vault-autocomplete">
      <div className="vault-autocomplete-head">
        Linking to vault note · <kbd>↑↓</kbd> <kbd>Enter</kbd> <kbd>Esc</kbd>
      </div>
      {ranked.map((n, i) => (
        <button
          key={n.relPath}
          className={`vault-autocomplete-row ${i === safeIdx ? "active" : ""}`}
          onMouseEnter={() => onHoverIndex(i)}
          onClick={() => onSelect(n)}
          // Don't let the click steal focus from the textarea — we want
          // the cursor still in the composer after selection.
          onMouseDown={(e) => e.preventDefault()}
        >
          <span className="vault-autocomplete-title">{n.title}</span>
          <span className="vault-autocomplete-path">
            {n.relPath.replace(/\.md$/, "")}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Helper for App.tsx: detect a `[[…` open-bracket trigger in the
 *  current textarea value at the cursor. Returns the in-progress query
 *  fragment and its replacement range, or null if no trigger active. */
export function detectVaultTrigger(
  text: string,
  caret: number,
): { query: string; replaceFrom: number; replaceTo: number } | null {
  // Scan backwards from caret for "[[" without a closing "]]" between.
  // The trigger is active while the user is between [[ and the next
  // whitespace / newline / closing bracket.
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "\n" || ch === "]" || ch === undefined) return null;
    if (ch === "[" && text[i - 1] === "[") {
      const start = i - 1; // index of first "["
      const fragment = text.slice(i + 1, caret);
      // No spaces in note titles for the trigger (Obsidian allows them
      // but it conflicts with composer's normal flow — easy to type a
      // long sentence and accidentally trigger). Stop at first whitespace.
      if (/\s/.test(fragment)) return null;
      return { query: fragment, replaceFrom: start, replaceTo: caret };
    }
    i -= 1;
  }
  return null;
}
