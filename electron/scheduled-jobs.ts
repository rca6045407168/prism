/**
 * v0.1.51 — Scheduled jobs surface.
 *
 * Reads ~/Library/LaunchAgents/ for any plist whose Label starts with
 * `com.prism.` or matches our convention, then parses program args +
 * schedule. This is READ-ONLY in v0.1.51: we surface what's already
 * scheduled so users have visibility. The writer + runner come in a
 * later release once we have a real daemon story.
 *
 * Why launchd and not a Prism-internal cron:
 *  - launchd is the right place for "fire this Mac process at 9am"
 *    on macOS. It survives reboots and respects power state.
 *  - We don't want to compete with Claude Code's own cron skill.
 *  - Detection-first is the cheap way to validate demand. If users
 *    rarely have scheduled prism jobs, we know the writer is low-pri.
 *
 * Out of scope:
 *  - Creating, editing, deleting LaunchAgents (user does this
 *    manually with launchctl + a plist).
 *  - System-wide LaunchDaemons (root-owned, different scope).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type ScheduledJob = {
  label: string;
  plistPath: string;
  program?: string;
  programArguments?: string[];
  scheduleSummary: string;
  loaded: boolean;
  enabled: boolean;
};

function summarizeSchedule(plistText: string): string {
  // Crude but sufficient: look for common scheduling keys.
  if (/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.test(plistText)) {
    const m = plistText.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    const secs = m ? parseInt(m[1], 10) : 0;
    if (secs >= 86400) return `every ${Math.round(secs / 86400)}d`;
    if (secs >= 3600) return `every ${Math.round(secs / 3600)}h`;
    if (secs >= 60) return `every ${Math.round(secs / 60)}m`;
    return `every ${secs}s`;
  }
  if (/<key>StartCalendarInterval<\/key>/.test(plistText)) {
    const hourM = plistText.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
    const minM = plistText.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
    const dowM = plistText.match(/<key>Weekday<\/key>\s*<integer>(\d+)<\/integer>/);
    const time =
      hourM && minM
        ? `${hourM[1].padStart(2, "0")}:${minM[1].padStart(2, "0")}`
        : "scheduled";
    if (dowM) {
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return `weekly ${days[parseInt(dowM[1], 10) % 7] ?? "?"} at ${time}`;
    }
    return `daily at ${time}`;
  }
  if (/<key>RunAtLoad<\/key>\s*<true\/>/.test(plistText)) return "run at load";
  return "—";
}

function extractStringArray(plistText: string, key: string): string[] | undefined {
  const re = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`);
  const m = plistText.match(re);
  if (!m) return undefined;
  const strings: string[] = [];
  const strRe = /<string>([\s\S]*?)<\/string>/g;
  let sm: RegExpExecArray | null;
  while ((sm = strRe.exec(m[1])) !== null) strings.push(sm[1]);
  return strings.length ? strings : undefined;
}

function extractString(plistText: string, key: string): string | undefined {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`);
  const m = plistText.match(re);
  return m ? m[1] : undefined;
}

function extractBool(plistText: string, key: string): boolean | undefined {
  const re = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`);
  const m = plistText.match(re);
  if (!m) return undefined;
  return m[1] === "true";
}

export async function listScheduledJobs(): Promise<{
  jobs: ScheduledJob[];
  dir: string;
}> {
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  if (!fs.existsSync(dir)) return { jobs: [], dir };

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".plist"));
  } catch {
    return { jobs: [], dir };
  }

  const jobs: ScheduledJob[] = [];
  for (const file of entries) {
    const full = path.join(dir, file);
    let text = "";
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const label = extractString(text, "Label");
    if (!label) continue;
    // Surface anything Prism-affiliated. We're permissive — show prism-,
    // claude-, openclaw- so users see all their agent-ish jobs.
    if (
      !label.startsWith("com.prism.") &&
      !label.startsWith("com.claude.") &&
      !label.startsWith("com.openclaw.") &&
      !label.startsWith("com.anthropic.")
    ) {
      continue;
    }
    const programArguments = extractStringArray(text, "ProgramArguments");
    const program = extractString(text, "Program") ?? programArguments?.[0];
    const disabled = extractBool(text, "Disabled") ?? false;
    jobs.push({
      label,
      plistPath: full,
      program,
      programArguments,
      scheduleSummary: summarizeSchedule(text),
      loaded: true, // we can't cheaply check without `launchctl list`; assume loaded
      enabled: !disabled,
    });
  }
  return { jobs, dir };
}
