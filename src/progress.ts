/**
 * Human progress for long search init / online-backfill runs.
 * Always writes to stderr so stdout stays JSON for scripts.
 */

type ProgressTick = {
  phase: string;
  done: number;
  total: number;
  embedded?: number;
  skipped?: number;
  flushes?: number;
  detail?: string;
};

export type ProgressReporter = {
  /** Announce a phase (and optional known total). */
  startPhase: (phase: string, total?: number) => void;
  tick: (t: ProgressTick) => void;
  /** Finish current phase / whole run with a final newline. */
  finish: (summary?: string) => void;
};

export type ProgressOpts = {
  /** Suppress all progress (scripts / tests). */
  quiet?: boolean;
  /** Force plain lines even on a TTY. */
  plain?: boolean;
  /** Minimum ms between redraws (default 100). */
  minIntervalMs?: number;
};

function bar(done: number, total: number, width = 28): string {
  if (total <= 0) return `[${"?".repeat(width)}]`;
  const ratio = Math.min(1, Math.max(0, done / total));
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
}

function fmtEta(done: number, total: number, elapsedMs: number): string {
  if (done <= 0 || total <= done || elapsedMs < 500) return "ETA --";
  const rate = done / (elapsedMs / 1000);
  if (rate <= 0) return "ETA --";
  const rem = (total - done) / rate;
  if (rem < 60) return `ETA ${Math.ceil(rem)}s`;
  if (rem < 3600) return `ETA ${Math.ceil(rem / 60)}m`;
  return `ETA ${(rem / 3600).toFixed(1)}h`;
}

function fmtRate(done: number, elapsedMs: number): string {
  if (elapsedMs < 200 || done <= 0) return "--/s";
  const r = done / (elapsedMs / 1000);
  if (r >= 100) return `${Math.round(r)}/s`;
  return `${r.toFixed(1)}/s`;
}

/**
 * Create a progress reporter. Prefer TTY single-line bar; otherwise periodic lines.
 */
export function createProgressReporter(opts: ProgressOpts = {}): ProgressReporter {
  const quiet = opts.quiet === true || process.env.SEARCH_PROGRESS === "0";
  const useBar =
    !opts.plain &&
    process.env.SEARCH_PROGRESS !== "plain" &&
    Boolean(process.stderr.isTTY);
  const minInterval = opts.minIntervalMs ?? 100;
  let lastWrite = 0;
  let phaseStart = Date.now();
  let lastPhase = "";
  let dirty = false;

  const writeBar = (line: string, force = false) => {
    if (quiet) return;
    const now = Date.now();
    if (!force && now - lastWrite < minInterval) return;
    lastWrite = now;
    // Clear line + rewrite
    process.stderr.write(`\r\x1b[2K${line}`);
    dirty = true;
  };

  const writeLine = (line: string, force = false) => {
    if (quiet) return;
    const now = Date.now();
    if (!force && now - lastWrite < Math.max(minInterval, 1000)) return;
    lastWrite = now;
    process.stderr.write(`${line}\n`);
  };

  return {
    startPhase(phase: string, total?: number) {
      if (quiet) return;
      if (dirty && useBar) {
        process.stderr.write("\n");
        dirty = false;
      }
      phaseStart = Date.now();
      lastPhase = phase;
      lastWrite = 0;
      const totalStr = total != null && total > 0 ? String(total) : "?";
      writeLine(`search: ${phase} (total=${totalStr})…`, true);
    },

    tick(t: ProgressTick) {
      if (quiet) return;
      if (t.phase !== lastPhase) {
        this.startPhase(t.phase, t.total);
      }
      const elapsed = Date.now() - phaseStart;
      const pct =
        t.total > 0 ? `${Math.min(100, Math.floor((100 * t.done) / t.total))}%` : "";
      const emb = t.embedded != null ? ` emb=${t.embedded}` : "";
      const sk = t.skipped != null ? ` skip=${t.skipped}` : "";
      const fl = t.flushes != null ? ` flush=${t.flushes}` : "";
      const detail = t.detail ? ` ${t.detail}` : "";
      const body = `${t.phase} ${bar(t.done, t.total)} ${t.done}/${t.total || "?"} ${pct}${emb}${sk}${fl} ${fmtRate(t.done, elapsed)} ${fmtEta(t.done, t.total, elapsed)}${detail}`;
      // Always paint first/last tick of a phase so short runs aren't silent.
      const force = t.done === 0 || (t.total > 0 && t.done >= t.total);
      if (useBar) writeBar(body, force);
      else writeLine(`search: ${body}`, force);
    },

    finish(summary?: string) {
      if (quiet) return;
      if (useBar && dirty) {
        process.stderr.write("\n");
        dirty = false;
      }
      if (summary) writeLine(`search: ${summary}`, true);
    },
  };
}
