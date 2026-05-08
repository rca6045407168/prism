<!--
This is the canonical Prism-vendored copy of the `debate` skill.

The v0.2 onboarding scanner will install this verbatim into
`~/.claude/skills/debate/SKILL.md` for new users. Until that lands,
users wanting adversarial debate should:

  mkdir -p ~/.claude/skills/debate
  cp skills/debate.md ~/.claude/skills/debate/SKILL.md

Keep this file and `~/.claude/skills/debate/SKILL.md` in sync. The
symlink-aware skill discovery in `electron/commands.ts` surfaces
`/debate` in the slash-command menu on next focus.
-->

---
name: debate
description: Adversarial 2-round debate before shipping high-stakes external content. Critic → Proposer revises → Critic (Round 2) → Judge (SHIP / REVISE AGAIN / SCRAP). ALWAYS trigger when the user's message starts with /debate, /critique, /stresstest, or /devils-advocate; when the user says "stress test this", "challenge this", "debate this", "are you sure", "play devil's advocate", "red team this", "would this work", "poke holes", or "sanity check"; when the user says a draft "sounds like AI" or "isn't in my voice"; when the user explicitly asks to draft external-facing content (cold email, investor outreach, fundraising material, accelerator application, customer first-contact, pricing/contract terms) and the resulting draft is ≥100 words. SKIP for casual exchanges, internal notes, code, or anything the user explicitly marks "first draft / no critique".
---

# Adversarial debate — stress test before shipping

Adapted from FlexHaul's `quality-gate` skill v2.4 "Mode 2" protocol, plus
the four standalone-framework reference implementations at
`outputs/adversarial-debate-frameworks/` (autogen / langgraph / crewai /
dspy). Same 2-round structure, runs inline via Task subagents.

## What this skill does

Forces every triggering draft through TWO rounds of hostile review by a
separate subagent before the final draft surfaces to the user. The cost
of being wrong on a cold email or investor message is high enough that
a single-pass quality check leaves too much on the floor.

```
  draft  →  Round 1 Critic  →  Proposer revises  →  Round 2 Critic  →  Judge
                 (7 dims)         (mandatory)         (verdict)         (SHIP / REVISE / SCRAP)
```

Maximum **3 rounds**. If Round 2 verdict is REVISE AGAIN, run one more
revision + Round 3 critic + Judge, then ship whatever survives.

## Trigger checklist (Step 0)

ALWAYS run debate when ANY of these match:

- User starts message with `/debate`, `/critique`, `/stresstest`, `/devils-advocate`
- User says "stress test", "challenge this", "debate this", "are you sure",
  "play devil's advocate", "red team this", "poke holes", "sanity check"
- User says a draft "sounds like AI" or "isn't in my voice"
- User asks to draft external-facing content (cold/warm email,
  investor outreach, fundraising, accelerator app, pricing email,
  customer first-contact) AND the resulting draft is ≥100 words
- Strategic recommendation that changes direction
- Any external-bound message ≥250 words regardless of category

Skip when:
- Casual reply / acknowledgement
- Internal notes / scratchpad / personal memos
- Code, pure tool output, or strictly factual lookups
- User explicitly says "first draft / no critique / don't debate"
- Already-shipped content the user is reviewing post-hoc (use a
  read-only review pattern instead)

If you skip on a triggering category, log it as a process-failure event
(`mistake-db` skill if available; otherwise note it explicitly in the
output).

## The protocol — four steps, one turn

All four steps run inside ONE assistant message via Task tool calls.
Do not bounce back to the user between rounds.

### Step 1 — Round 1 Critic

Dispatch a Task subagent with `subagent_type: "general-purpose"` and the
following prompt template:

```
You are a hostile, evidence-driven critic reviewing this draft for the
sender. The sender ships in 30 seconds unless you stop them. Be direct.

DRAFT:
<the draft>

CONTEXT:
<who is this going to, what do they care about, what's the relationship,
 what's the sender's actual goal>

Review across these SEVEN dimensions. For each, give a verdict and 1-3
sentences of reasoning:

1. UNSUPPORTED CLAIMS — list every numeric or factual claim. For each,
   rate FABRICATED (no source, no warrant) / HIGH (plausible but
   unsourced) / MEDIUM (sourced but stale or non-comparable) / LOW (well
   supported). Don't let "~40%" or "3x" slide.

2. OVERCONFIDENCE — where does the draft assert when it should hedge?
   Where does it sound certain about uncertain things?

3. EMPTY CALORIES — what sentences add length without adding signal?
   "Hope this finds you well", multi-clause openers, trailing CTAs that
   don't ask for a specific thing.

4. STRONGEST COUNTERARGUMENT — what's the single most damaging response
   the recipient could give? If you were them, what's the one objection
   the draft doesn't address?

5. AUDIENCE TEST — does this match what the recipient cares about, at
   the altitude they operate at? Is the sender pitching features to
   someone who needs to hear about strategy?

6. STEEL-MAN THE OPPOSITE — what's the strongest argument for NOT sending
   this at all? "Don't send" is a real option.

7. AI-TONE TELLS — hunt for em-dashes, "Reaching out", "Big admirer",
   multi-clause openers, fragments-for-emphasis, "that's where X comes
   in", "it's about", "true magic", any line that sounds LLM-shaped.

Return JSON:
{
  "dimension_findings": {
    "unsupported_claims": [{"claim": "", "rating": "FABRICATED|HIGH|MEDIUM|LOW", "why": ""}],
    "overconfidence": [{"line": "", "why": ""}],
    "empty_calories": [{"line": "", "why": ""}],
    "strongest_counter": "",
    "audience_test": "PASS|FAIL",
    "audience_reason": "",
    "steel_man_opposite": "",
    "ai_tone_tells": [{"phrase": "", "why": ""}]
  },
  "top_3_must_fix": ["", "", ""],
  "overall_severity": "BLOCKING|MAJOR|MINOR|CLEAN"
}
```

### Step 2 — Proposer revises

In the same assistant message, after Step 1 returns, dispatch a second
Task subagent (or do it inline if the revision is small). Prompt:

```
You wrote this draft and a hostile critic just reviewed it. Revise the
draft to address every BLOCKING and MAJOR finding. You may keep MINOR
findings if the fix would degrade voice or flow.

ORIGINAL DRAFT:
<draft>

CRITIC FINDINGS:
<JSON from Step 1>

REVISION CONSTRAINTS:
- Match the original sender's voice. Don't AI-flatten it.
- Don't manufacture new claims to replace old ones — cut, don't invent.
- Keep length within ±20% of the original unless the critic explicitly
  flagged length.
- If a claim was FABRICATED, either remove it or replace with a
  hedged version ("some shippers" instead of "40%").

Return the revised draft as plain text. No preamble, no commentary.
```

### Step 3 — Round 2 Critic

Dispatch the critic again with the SAME prompt as Step 1, but on the
revised draft. Add this line at the top:

```
This is Round 2. The proposer has already addressed Round 1 findings.
Focus on: (a) any Round 1 finding that is NOT actually fixed,
(b) new issues introduced by the revision, (c) whether the draft is
now ship-ready or needs another pass.
```

Return the same JSON shape.

### Step 4 — Judge

Final subagent (or inline). Prompt:

```
You are the judge. Two rounds of critique have run. Decide:

- SHIP — ready to send. No BLOCKING findings remain.
- REVISE AGAIN — close, but at least one BLOCKING finding still stands.
  Run one more round.
- SCRAP — the draft's premise is broken. The critic's STEEL_MAN_OPPOSITE
  is the right answer. Don't send anything in this thread; reassess.

INPUTS:
- Round 1 critic findings: <JSON>
- Revision 1: <text>
- Round 2 critic findings: <JSON>

Return JSON:
{
  "verdict": "SHIP|REVISE_AGAIN|SCRAP",
  "reasoning": "<2-3 sentences>",
  "residual_risks": ["", ""]
}
```

If verdict is REVISE_AGAIN, run ONE more revision cycle (Steps 2 + 3 + 4),
then ship whatever survives. **Hard cap at 3 rounds total.**

## Output format

Prepend this debate-summary block before the final draft so the user can
audit that the debate actually ran:

```
┌── Adversarial debate ──────────────────────────────┐
│ Rounds run: 2                                  │
│ Round 1 severity: <BLOCKING/MAJOR/MINOR/CLEAN>  │
│ Round 2 severity: <…>                           │
│ Judge verdict: <SHIP/REVISE/SCRAP>              │
│ Top fixes applied: <1-line summary, up to 3>    │
│ Residual risks: <1-line summary, up to 2>       │
└────────────────────────────────────────┘

<final revised draft, exactly as you'd send it>
```

If SCRAP, the block contains the verdict + reasoning, and the final
output is a short paragraph explaining what to do instead ("don't send;
the premise is wrong because …"). Do NOT ship a draft when the verdict
is SCRAP.

## Worked example

User sends:

```
/debate

Draft a cold email to Sarah Chen, VP Supply Chain at Acme Brands. Acme
ships ~2000 LTL/month, currently uses project44 + 6 carrier portals.
FlexHaul is 3-person seed-stage, 4 paying customers.
```

Your assistant message dispatches:

1. **Drafter Task** — produces v0 of the cold email
2. **Round 1 Critic Task** — 7-dim review, returns JSON
3. **Proposer Task** — revises against findings
4. **Round 2 Critic Task** — reviews revision
5. **Judge Task** — verdict

Then renders the debate-summary block + final draft. Total cost ~$0.05-0.15
at haiku/sonnet rates.

## Anti-patterns

- ❌ Single-round critique. The whole point is the proposer gets to
  defend; without Round 2 you don't know if the revision actually fixed
  the issue or just papered over it.
- ❌ Letting the critic and the proposer be the same agent. Self-critique
  is well documented to under-detect issues. Use separate subagents.
- ❌ Generic critique ("this could be better", "consider tightening").
  Every finding must cite the specific line / claim / phrase.
- ❌ Skipping the debate-summary block. The block is the audit trail; if
  it's missing the user can't tell whether Mode 2 actually ran.
- ❌ Asking the user mid-debate ("should I revise more?"). The judge
  decides. Cap at 3 rounds; ship whatever's there.
- ❌ Running debate on internal notes, code, or factual lookups. The
  trigger checklist is conservative for a reason — inflicting 5 LLM
  calls on every prompt would be insane.

## Cost discipline

Five Task calls per full debate (drafter × 0–1 if drafting from scratch,
critic × 2, proposer × 1, judge × 1). At sonnet rates that's roughly
$0.05-0.15 per debate. For high-stakes content this is rounding error
relative to the cost of shipping a bad cold email.

If the same draft enters the debate three times in one session, raise it
as a structural issue — something is wrong with the trigger logic or
the proposer is fighting the critic in a loop. Don't burn rounds 4-5.

## Standalone framework alternatives

For offline / scheduled / batch use cases (score 200 cold emails
overnight, optimize the critic prompt against historical reply data,
build a UI showing the debate to the end user), four reference
implementations live at:

- `outputs/adversarial-debate-frameworks/autogen_demo/`
- `outputs/adversarial-debate-frameworks/langgraph_demo/`
- `outputs/adversarial-debate-frameworks/crewai_demo/`
- `outputs/adversarial-debate-frameworks/dspy_demo/`

Use this skill for: drafting one investor email right now, inline.
Use those frameworks for: batch / measurable / optimizable workflows.
