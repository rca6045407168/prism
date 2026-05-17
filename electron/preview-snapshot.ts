/**
 * v0.1.44 — Preview mode snapshot primitives.
 *
 * macOS APFS local-snapshot is the safety net for Preview mode: take a
 * snapshot of `/` BEFORE the turn runs, let claude execute against the
 * real filesystem in bypass-permissions, then surface the snapshot ID
 * to the user so they can review-and-revert if anything went wrong.
 *
 * Why APFS snapshots instead of git-stash:
 *   - covers ANY path on the disk, not just git-tracked dirs
 *   - taken at the kernel level — instant once initiated
 *   - already supported on every Mac (Time Machine uses them)
 *   - free, no third-party deps
 *
 * Tradeoff: snapshots are purgeable by `deleted(8)` under memory
 * pressure. They are NOT a long-term backup. They're a "I want to
 * undo this turn within the next ~30min" affordance. That's exactly
 * the use case Preview mode needs. See MST-061 + the v0.1.44 design
 * note in the vault.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execFileAsync = promisify(execFile);

/** Directory where Prism records per-snapshot marker files. The marker
 *  exists so `find -newer <marker>` can list files modified after the
 *  snapshot was taken — no sudo, no APFS mounting required. */
const MARKER_DIR = path.join(os.homedir(), ".prism", "preview-markers");

/** Paths excluded from changed-file listing — these churn constantly and
 *  drowning the UI in them would be useless. */
const EXCLUDED_PREFIXES = [
  path.join(os.homedir(), "Library", "Caches"),
  path.join(os.homedir(), "Library", "Logs"),
  path.join(os.homedir(), "Library", "Containers"),
  path.join(os.homedir(), "Library", "Cookies"),
  path.join(os.homedir(), "Library", "Saved Application State"),
  path.join(os.homedir(), "Library", "Application Support", "com.anthropic.claude"),
  path.join(os.homedir(), ".Trash"),
  path.join(os.homedir(), ".npm"),
  path.join(os.homedir(), ".cache"),
  path.join(os.homedir(), "Library", "WebKit"),
  path.join(os.homedir(), ".prism", "preview-markers"),
];

export type SnapshotResult = {
  /** ISO-ish timestamp ID from tmutil, e.g. "2026-05-16-143620". */
  id: string;
  /** Full name as macOS records it, e.g. "com.apple.TimeMachine.2026-05-16-143620.local". */
  fullName: string;
  /** Unix epoch milliseconds when the snapshot was taken. */
  createdAt: number;
};

/**
 * Create an APFS local snapshot of /. Returns the snapshot ID + full
 * Time Machine name + creation timestamp. Throws if `tmutil` isn't
 * available or the user lacks permission (rare on a personal Mac).
 *
 * Typical cold-call latency: ~1-2s.
 *
 * v0.1.45: also writes a zero-byte marker file at MARKER_DIR/<id>.marker
 * stamped with the snapshot's creation timestamp. We use `find -newer
 * <marker>` later to list files modified after this snapshot — that
 * approach avoids requiring sudo or APFS mount-snapshot calls.
 */
export async function createSnapshot(): Promise<SnapshotResult> {
  const { stdout } = await execFileAsync("tmutil", ["localsnapshot"], {
    timeout: 15_000,
  });
  // tmutil prints: "Created local snapshot with date: 2026-05-16-143620"
  const match = stdout.match(/Created local snapshot with date:\s*([\d\-]+)/);
  if (!match) {
    throw new Error(`tmutil output unrecognized: ${stdout.slice(0, 200)}`);
  }
  const id = match[1];
  const createdAt = Date.now();

  // v0.1.45: write a marker file so we can later `find -newer <marker>`
  // to list everything modified after this snapshot. The marker's mtime
  // is the source of truth — content is irrelevant. Touch + set mtime.
  try {
    fs.mkdirSync(MARKER_DIR, { recursive: true, mode: 0o700 });
    const markerPath = path.join(MARKER_DIR, `${id}.marker`);
    fs.writeFileSync(markerPath, `snapshot=${id}\ncreatedAt=${createdAt}\n`, {
      mode: 0o600,
    });
    // Force the marker's mtime exactly to createdAt — using fs.utimesSync
    // so `find -newer` boundaries are deterministic.
    const t = createdAt / 1000;
    fs.utimesSync(markerPath, t, t);
  } catch (e: any) {
    // Marker failure is non-fatal — diff/revert UI won't work for THIS
    // snapshot, but the snapshot itself is fine and `tmutil restore`
    // still rolls back manually. Log and continue.
    try {
      require("electron-log").warn("[preview-marker] write failed", e?.message);
    } catch {
      /* ignore */
    }
  }

  return {
    id,
    fullName: `com.apple.TimeMachine.${id}.local`,
    createdAt,
  };
}

/**
 * v0.1.45: list files modified or created since the snapshot was taken.
 *
 * Implementation: `find $HOME -newer <marker-file> -type f`, then filter
 * out paths under EXCLUDED_PREFIXES (caches, logs, browser state, etc.)
 * because those churn constantly and would drown the UI.
 *
 * Returns `{ path, mtime, size }` per file. Capped at 200 results so a
 * `rm -rf` that touched a million files doesn't lock the renderer.
 */
export type ChangedFile = {
  /** Absolute path on disk. */
  path: string;
  /** mtime in unix ms. */
  mtime: number;
  /** File size in bytes (post-change). 0 if stat failed. */
  size: number;
  /** True if the file did NOT exist at snapshot time. Inferred via the
   *  `find -newer ...` query — we treat that as "modified or created".
   *  True new-file detection would need to diff against the snapshot
   *  itself; for v1 we conservatively show all changed paths and let
   *  the user decide. */
  likelyNew: boolean;
};

export async function listChangedFiles(
  snapshotId: string,
  scope: string = os.homedir(),
): Promise<ChangedFile[]> {
  // v0.1.48: caller may pass a tighter scope (e.g. ~/code/prism) to
  // bound diff work + reduce noise. Validate it exists + is under $HOME
  // for safety; fall back to $HOME on invalid scope.
  const home = os.homedir();
  let resolvedScope = scope;
  try {
    if (!fs.existsSync(scope) || !fs.statSync(scope).isDirectory()) {
      resolvedScope = home;
    } else {
      const r = path.resolve(scope);
      if (!r.startsWith(home)) resolvedScope = home;
      else resolvedScope = r;
    }
  } catch {
    resolvedScope = home;
  }
  scope = resolvedScope;
  const markerPath = path.join(MARKER_DIR, `${snapshotId}.marker`);
  if (!fs.existsSync(markerPath)) {
    throw new Error(
      `No marker for snapshot ${snapshotId} — diff unavailable. The snapshot itself may still exist (check tmutil listlocalsnapshots /).`,
    );
  }

  // `find -newer` returns files with mtime strictly newer than the
  // reference file's mtime. Cap depth to keep this fast.
  const maxDepth = 10;
  let stdout = "";
  try {
    const result = await execFileAsync(
      "find",
      [
        scope,
        "-maxdepth",
        String(maxDepth),
        "-type",
        "f",
        "-newer",
        markerPath,
        "-not",
        "-path",
        "*/.git/*",
      ],
      { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (e: any) {
    // `find` sometimes returns non-zero (permission denied on some paths)
    // even when stdout has useful content. Salvage what we got.
    if (e?.stdout) stdout = e.stdout;
    else throw e;
  }

  const paths = stdout
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .filter((p) => !EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix)));

  const results: ChangedFile[] = [];
  for (const p of paths.slice(0, 200)) {
    try {
      const st = fs.statSync(p);
      results.push({
        path: p,
        mtime: st.mtimeMs,
        size: st.size,
        likelyNew: true, // see comment above — v1 conservative
      });
    } catch {
      // file may have been removed between find and stat; skip
    }
  }
  return results;
}

/**
 * v0.1.45: revert (delete) a file that was created or modified after
 * the snapshot. For "new files" this is a clean rm. For "modified files"
 * we currently also rm — the file would need to be restored from the
 * APFS snapshot to recover its pre-change contents, which requires
 * mount_apfs + sudo and is deferred to v0.1.46+.
 *
 * Safety: scoped to $HOME — any path outside $HOME is rejected.
 */
export async function revertFile(filePath: string): Promise<void> {
  const home = os.homedir();
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(home + path.sep)) {
    throw new Error(`Refusing to revert outside $HOME: ${resolved}`);
  }
  await fs.promises.unlink(resolved);
}

/**
 * List all extant local snapshots from tmutil. Useful for surfacing
 * "you have N preview snapshots on disk" in Settings later, or for
 * deciding when to opportunistically clean up old ones.
 */
export async function listSnapshots(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("tmutil", ["listlocalsnapshots", "/"], {
      timeout: 5_000,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("com.apple.TimeMachine."));
  } catch {
    return [];
  }
}

/**
 * Delete a specific local snapshot. The user-facing "Discard preview"
 * action eventually calls this once changes have been confirmed-kept.
 *
 * Pass the snapshot ID (the YYYY-MM-DD-HHMMSS part), NOT the fullName.
 */
export async function deleteSnapshot(id: string): Promise<void> {
  await execFileAsync("tmutil", ["deletelocalsnapshots", id], {
    timeout: 10_000,
  });
}
