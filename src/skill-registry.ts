/**
 * v0.1.49 — Skill registry browser data.
 *
 * Curated ~20 high-value skills surfaced in Settings → Skills tab.
 * Pattern stolen from awesome-openclaw-skills (48k stars, 5,211 skills)
 * — the full registry is at https://github.com/VoltAgent/awesome-openclaw-skills
 * and the Skills tab links out to it.
 *
 * This curated list focuses on skills that meaningfully extend Prism for
 * the contexts the user actually operates in (FlexHaul, trader,
 * real-estate, dev productivity, content). Adding more entries: append
 * to SKILLS and the UI auto-renders.
 *
 * NOT a dynamic fetcher in v1 — parsing 5,211 skills from the awesome
 * README reliably is its own project. v0.1.49.1+ can add live fetch.
 */

export type Skill = {
  slug: string;
  name: string;
  description: string;
  category: SkillCategory;
  source: string; // GitHub repo URL or installer source
  installCmd: string; // copy-paste command
  tags: string[];
};

export type SkillCategory =
  | "productivity"
  | "dev"
  | "writing"
  | "research"
  | "data"
  | "finance"
  | "real-estate"
  | "communication"
  | "meta";

export const SKILLS: Skill[] = [
  // — productivity —
  {
    slug: "calendar",
    name: "Calendar Assistant",
    description: "Read + create Google Calendar events with natural-language scheduling.",
    category: "productivity",
    source: "https://github.com/clawhub/calendar-assistant",
    installCmd: "clawhub install calendar-assistant",
    tags: ["calendar", "scheduling", "google"],
  },
  {
    slug: "gmail-triage",
    name: "Gmail Triage",
    description: "Bulk-classify Gmail inbox into action/wait/archive lanes; surface what needs you today.",
    category: "productivity",
    source: "https://github.com/clawhub/gmail-triage",
    installCmd: "clawhub install gmail-triage",
    tags: ["gmail", "inbox-zero"],
  },
  {
    slug: "meeting-notes",
    name: "Meeting Notes Extractor",
    description: "Pull Fireflies/Granola transcripts → decisions + action items + commitments graph.",
    category: "productivity",
    source: "https://github.com/clawhub/meeting-notes",
    installCmd: "clawhub install meeting-notes",
    tags: ["fireflies", "granola", "decisions"],
  },

  // — dev —
  {
    slug: "code-reviewer",
    name: "PR Code Reviewer",
    description: "Reviews a GitHub PR diff for bugs, security, style. Inline suggestions via gh api.",
    category: "dev",
    source: "https://github.com/clawhub/code-reviewer",
    installCmd: "clawhub install code-reviewer",
    tags: ["github", "code-review", "pr"],
  },
  {
    slug: "test-generator",
    name: "Test Generator",
    description: "Given a function, generates unit + edge-case tests in your project's test framework.",
    category: "dev",
    source: "https://github.com/clawhub/test-generator",
    installCmd: "clawhub install test-generator",
    tags: ["testing", "vitest", "pytest", "jest"],
  },
  {
    slug: "git-rebase-explainer",
    name: "Git Rebase Explainer",
    description: "Walks you through a rebase conflict resolution — file-by-file diff narration.",
    category: "dev",
    source: "https://github.com/clawhub/git-rebase",
    installCmd: "clawhub install git-rebase-explainer",
    tags: ["git", "rebase", "merge"],
  },

  // — writing —
  {
    slug: "investor-update",
    name: "Investor Update Drafter",
    description: "Drafts monthly investor update from your MRR + commits + meeting notes. Richard-voice presets.",
    category: "writing",
    source: "https://github.com/clawhub/investor-update",
    installCmd: "clawhub install investor-update",
    tags: ["fundraising", "investor-relations"],
  },
  {
    slug: "tweet-polisher",
    name: "Tweet Polisher",
    description: "Refines a draft tweet for clarity + hook strength. Keeps your voice.",
    category: "writing",
    source: "https://github.com/clawhub/tweet-polisher",
    installCmd: "clawhub install tweet-polisher",
    tags: ["twitter", "x", "social"],
  },
  {
    slug: "linkedin-post",
    name: "LinkedIn Post Drafter",
    description: "Drafts + iterates LinkedIn posts. Hooks, narrative arc, CTA.",
    category: "writing",
    source: "https://github.com/clawhub/linkedin-post",
    installCmd: "clawhub install linkedin-post",
    tags: ["linkedin", "personal-brand"],
  },

  // — research —
  {
    slug: "arxiv-scanner",
    name: "Arxiv Daily Scanner",
    description: "Scans cs.CL / cs.AI / cs.MA daily for papers matching your interests; produces a brief.",
    category: "research",
    source: "https://github.com/clawhub/arxiv-scanner",
    installCmd: "clawhub install arxiv-scanner",
    tags: ["arxiv", "research", "ml"],
  },
  {
    slug: "deep-research",
    name: "Deep Research",
    description: "Multi-step web research with citation tracking. Like Perplexity but local + composable.",
    category: "research",
    source: "https://github.com/clawhub/deep-research",
    installCmd: "clawhub install deep-research",
    tags: ["web", "research", "citations"],
  },

  // — data —
  {
    slug: "csv-explorer",
    name: "CSV Explorer",
    description: "Drop a CSV in; ask questions. Auto-generates duckdb queries + viz.",
    category: "data",
    source: "https://github.com/clawhub/csv-explorer",
    installCmd: "clawhub install csv-explorer",
    tags: ["csv", "duckdb", "analytics"],
  },

  // — finance —
  {
    slug: "expense-categorizer",
    name: "Expense Categorizer",
    description: "Categorizes Mercury/Chase transactions into your chart of accounts.",
    category: "finance",
    source: "https://github.com/clawhub/expense-categorizer",
    installCmd: "clawhub install expense-categorizer",
    tags: ["accounting", "mercury", "chase"],
  },
  {
    slug: "burn-rate",
    name: "Burn Rate Calculator",
    description: "Reads your bank statements → monthly burn + 6/12/18mo runway projections.",
    category: "finance",
    source: "https://github.com/clawhub/burn-rate",
    installCmd: "clawhub install burn-rate",
    tags: ["fundraising", "runway", "founder"],
  },

  // — real estate —
  {
    slug: "property-stress-test",
    name: "Property Stress Test",
    description: "Underwrite a rental: NOI + 50yr HPI worst case + DSCR + cash-on-cash. Mirrors reip.",
    category: "real-estate",
    source: "https://github.com/clawhub/property-stress",
    installCmd: "clawhub install property-stress-test",
    tags: ["real-estate", "underwriting"],
  },
  {
    slug: "zip-scorer",
    name: "ZIP Scorer",
    description: "Score a ZIP on rental demand + price stability + crime + school. National coverage.",
    category: "real-estate",
    source: "https://github.com/clawhub/zip-scorer",
    installCmd: "clawhub install zip-scorer",
    tags: ["real-estate", "zip", "investment"],
  },

  // — communication —
  {
    slug: "slack-summary",
    name: "Slack Channel Summary",
    description: "Summarize a Slack channel since you were last online. Top decisions + threads needing you.",
    category: "communication",
    source: "https://github.com/clawhub/slack-summary",
    installCmd: "clawhub install slack-summary",
    tags: ["slack", "team"],
  },
  {
    slug: "email-thread-resolver",
    name: "Email Thread Resolver",
    description: "Given a tangled email thread, extract: who's blocking, what's decided, what's the next move.",
    category: "communication",
    source: "https://github.com/clawhub/email-thread",
    installCmd: "clawhub install email-thread-resolver",
    tags: ["email", "negotiation"],
  },

  // — meta —
  {
    slug: "skill-builder",
    name: "Skill Builder",
    description: "Generate a new claude/openclaw skill from a natural-language description. Includes scaffolding + manifest.",
    category: "meta",
    source: "https://github.com/clawhub/skill-builder",
    installCmd: "clawhub install skill-builder",
    tags: ["skill", "meta", "scaffold"],
  },
  {
    slug: "claude-mem",
    name: "Claude-Mem (Persistent Context)",
    description: "Persistent context across sessions for claude / openclaw / codex / gemini / hermes. 76k stars.",
    category: "meta",
    source: "https://github.com/thedotmack/claude-mem",
    installCmd: "npx claude-mem install",
    tags: ["memory", "context", "persistence"],
  },
];

export const CATEGORY_LABELS: Record<SkillCategory, string> = {
  productivity: "Productivity",
  dev: "Dev",
  writing: "Writing",
  research: "Research",
  data: "Data",
  finance: "Finance",
  "real-estate": "Real Estate",
  communication: "Communication",
  meta: "Meta",
};
