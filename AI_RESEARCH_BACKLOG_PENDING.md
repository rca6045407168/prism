---
type: research-backlog-pending
date: 2026-05-17
project: prism
source: /Users/richardchen/Documents/Obsidian Vault/_Claude-Knowledge/AI-Research-Backlog/2026-05-17.md
items_total: 3
status: pending-implementation
staged_by: research-backlog-implementer.sh
staged_at: 2026-05-17T12:51:28-07:00
---

# AI Research Backlog -- Pending Implementation (prism)

You are Claude Code, opened in /Users/richardchen/code/prism. Below are 3 items proposed for implementation today. Read the master backlog at `source:` for full context.

## Protocol
1. Read master backlog at source for cross-project context.
2. Pick highest-score item with status: proposed.
3. Branch off main: git checkout -b research/2026-05-17-{item-id}.
4. Implement against listed target_files.
5. Run tests. Do not ship on regression.
6. Open PR with item-id in title, paper link in body, acceptance criteria checklist.
7. Update master backlog: proposed -> implementing -> shipped.

## Stop conditions
- MST-052: Prism is NOT FlexHaul. No carrier/broker/rate/Tyson/Wakool terms
- MST-051: do not import heavy upstream stacks as deps; patterns only
- target_files don't exist

## Items (sorted by score, descending)

```yaml
project: prism
paper: https://arxiv.org/abs/2605.10999
paper_title: SkillGen Verified Inference-Time Agent Skill Synthesis
primitives: [SKILLS, EXTRACTION]
target_files:
  - src/profile-store.ts
  - src/profile-synthesis/
  - src/mcp/visibility-layer.ts
action: |
  Prism's profile-store.ts already has BRIGHT-Pro + SURE-RAG auto-profile logic.
  SkillGen's inference-time synthesis pattern (no fine-tune, verifier-gated promotion)
  is a clean fit — profiles get proposed from user-interaction traces, verified against
  a synthesized test set, and only promoted if the verifier passes. Implement the
  PATTERN, not the upstream stack (MST-051). Stay vanilla TypeScript, no Python deps.
  Use the existing /think best-of-N path as the verifier substrate.
score: 7.5
status: proposed
effort: M
why: |
  The auto-profile system is Prism's killer feature. Manual profile authorship doesn't
  scale. SkillGen's verifier-gated promotion is exactly the gate Prism needs to ship
  auto-generated profiles safely.
acceptance:
  - profile-synthesis/ adds a synthesizer that proposes a candidate profile from N user-interaction traces.
  - Verifier uses /think best-of-N to score the candidate against auto-generated test prompts.
  - Bundle size delta <100KB (MST-051 budget). No FlexHaul terms anywhere (MST-052).
```

```yaml
project: prism
paper: https://arxiv.org/abs/2603.13017
paper_title: Structured Distillation for Personalized Agent Memory 11x Token Reduction
primitives: [MEMORY, COST]
target_files:
  - src/profile-store.ts
  - src/memory/distillation.ts
action: |
  profile-store.ts holds growing per-user interaction history. Distilling each
  exchange into a structured object with verbatim drill-down (the paper's exact
  pattern) cuts the inference cost of profile-aware queries by ~11x without losing
  retrieval quality. Implement vanilla TypeScript distillation; no heavy ML deps.
score: 6.5
status: proposed
effort: S
why: |
  Cost matters for desktop deployment where the user pays the API bill directly.
  Smaller per-call payloads also mean faster /think loops.
acceptance:
  - distillation.ts compresses profile history >=8x on a 100-message sample.
  - Retrieval-quality regression within 3pp of verbatim baseline.
  - Bundle delta <50KB. No new runtime deps.
```

```yaml
project: prism
paper: https://arxiv.org/abs/2512.02543
paper_title: Inference-Time Distillation Cost-Efficient Agents Without Fine-Tuning
primitives: [COST, PLANNER]
target_files:
  - src/think/best-of-n.ts
  - src/think/cascade.ts
action: |
  Paper reports 2.5x cost reduction at matched accuracy via dynamic in-context learning
  plus self-consistency cascades. /think best-of-N already runs N candidates — add a
  cascade that escalates to a stronger model only when low-cost agreement fails.
  Pattern absorption only; no upstream framework imports (MST-051).
score: 6.0
status: proposed
effort: S
why: |
  /think is the highest-cost code path in Prism. A 2x cost cut is felt immediately
  by users paying their own API bill.
acceptance:
  - cascade.ts implements escalate-on-disagreement with a tunable agreement threshold.
  - Measured 1.5x+ cost reduction at matched accuracy on a fixed eval prompt set.
  - Cascade thresholds are config, not hard-coded.
```


---

When done, the implementer renames this file to AI_RESEARCH_BACKLOG_SHIPPED-2026-05-17.md.
