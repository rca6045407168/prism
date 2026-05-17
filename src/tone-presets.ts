/**
 * v0.1.55 — Tone targeting (audience-aware drafting).
 *
 * Senior employees flex tone — terse with peers, clear with customers,
 * precise with legal, hedged in public. Prism today has one voice
 * (whatever the model defaults to). Tone presets let the user attach
 * an audience-target tag to the next turn; the message is sent with
 * a prefix instructing the model to adopt that voice.
 *
 * Sticky selection: once a tone is picked, it stays until cleared.
 * "Default" (no tag) is the baseline.
 *
 * Out of scope for v0.1.55:
 *   - Per-chat saved tones
 *   - LLM-learned tone targets
 *   - Composed tones ("internal AND terse")
 */
export type TonePreset = {
  id: string;
  label: string;
  emoji: string;
  prefix: string; // text prepended to the user message
  hint: string;
};

export const TONE_PRESETS: TonePreset[] = [
  {
    id: "default",
    label: "Default",
    emoji: "💬",
    prefix: "",
    hint: "No tone tag — model uses its baseline voice.",
  },
  {
    id: "internal",
    label: "Internal",
    emoji: "🏢",
    prefix:
      "[Tone: Internal — write for a senior teammate. Terse, technical, " +
      "skip the polite filler, link to facts.]",
    hint: "Terse, technical, peer-to-peer. Skip pleasantries.",
  },
  {
    id: "customer",
    label: "Customer",
    emoji: "💼",
    prefix:
      "[Tone: Customer-facing — clear, jargon-free, warm but professional. " +
      "Acknowledge any inconvenience, state the situation, state the action " +
      "you're taking, and give them a clear ETA. No hedging.]",
    hint: "Clear, jargon-free, warm but professional.",
  },
  {
    id: "legal",
    label: "Legal",
    emoji: "⚖️",
    prefix:
      "[Tone: Legal — precise, hedged. Use \"appears to\", \"based on the " +
      "information provided\", \"subject to review\". Do NOT make " +
      "definitive claims about liability, fault, or contract " +
      "interpretation — flag those as items for counsel review.]",
    hint: "Precise, hedged, flags items for counsel review.",
  },
  {
    id: "public",
    label: "Public",
    emoji: "📰",
    prefix:
      "[Tone: Public / broadcast — assume this may be quoted, archived, or " +
      "screenshotted. Brand-safe. No insider jokes. No mention of " +
      "specific customers, dollar amounts, or unreleased products. " +
      "Cite numbers only if already public.]",
    hint: "Brand-safe, broadcast-grade. No insiders, no $-amounts.",
  },
  {
    id: "investor",
    label: "Investor",
    emoji: "📈",
    prefix:
      "[Tone: Investor update — confident but honest. Lead with the metric " +
      "or milestone. Quantify wins (MRR, conversions, shipped releases). " +
      "Name risks before the investor has to ask. Close with the " +
      "specific ask.]",
    hint: "Confident, honest, metrics-first, names risks early.",
  },
];

export function applyTone(text: string, toneId: string | null): string {
  if (!toneId || toneId === "default") return text;
  const preset = TONE_PRESETS.find((t) => t.id === toneId);
  if (!preset || !preset.prefix) return text;
  return `${preset.prefix}\n\n${text}`;
}
