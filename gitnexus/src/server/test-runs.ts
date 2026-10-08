/**
 * Live test runs, shown on the graph by the web UI.
 *
 * A run is reported from outside the server (`gitnexus test-report`, driven by
 * the `testes` skill): it starts with the test files about to run, receives
 * results as each runner finishes, and is then marked finished. The server only
 * keeps the latest run per repository, in memory — this is a display channel,
 * not a history.
 */

export type TestStatus = 'pending' | 'passed' | 'failed' | 'skipped';

export interface TestCaseResult {
  /** Repo-relative path of the test file. */
  file: string;
  name: string;
  status: Exclude<TestStatus, 'pending'>;
  durationMs?: number;
  /** One-line reason for a failure or skip. */
  message?: string;
  /** Full failure output (assertion diff, stack). */
  details?: string;
}

export interface TestRunFile {
  filePath: string;
  status: TestStatus;
  tests: Array<Omit<TestCaseResult, 'file'>>;
}

export interface TestRun {
  id: string;
  repoPath: string;
  label: string | null;
  status: 'running' | 'finished';
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  totals: Record<TestStatus, number> & { files: number; tests: number };
  files: TestRunFile[];
}

const MAX_FILES = 5000;
const MAX_TESTS_PER_FILE = 2000;
const MAX_MESSAGE_CHARS = 500;
const MAX_DETAILS_CHARS = 8000;

const clip = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

const normalizeFile = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const p = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
  return p === '' || p.startsWith('/') || p.split('/').includes('..') ? null : p;
};

const isResultStatus = (value: unknown): value is TestCaseResult['status'] =>
  value === 'passed' || value === 'failed' || value === 'skipped';

/** A file is as bad as its worst test; untested-yet files stay pending. */
const fileStatus = (tests: TestRunFile['tests']): TestStatus => {
  if (tests.length === 0) return 'pending';
  if (tests.some((t) => t.status === 'failed')) return 'failed';
  if (tests.every((t) => t.status === 'skipped')) return 'skipped';
  return 'passed';
};

const computeTotals = (files: readonly TestRunFile[]): TestRun['totals'] => {
  const totals = { files: files.length, tests: 0, pending: 0, passed: 0, failed: 0, skipped: 0 };
  for (const file of files) {
    if (file.tests.length === 0) totals.pending += 1;
    for (const test of file.tests) {
      totals.tests += 1;
      totals[test.status] += 1;
    }
  }
  return totals;
};

export class TestRunStore {
  private readonly runs = new Map<string, TestRun>();
  private readonly lastViewedAt = new Map<string, number>();
  private sequence = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  get(repoPath: string): TestRun | null {
    return this.runs.get(repoPath) ?? null;
  }

  /** The web UI polls for the run; remember it so reporters need not open another tab. */
  markViewed(repoPath: string): void {
    this.lastViewedAt.set(repoPath, this.now().getTime());
  }

  hasActiveViewer(repoPath: string, withinMs = 10_000): boolean {
    const seen = this.lastViewedAt.get(repoPath);
    return seen !== undefined && this.now().getTime() - seen <= withinMs;
  }

  /** Begin a run; `files` are the test files about to execute (shown as pending). */
  start(repoPath: string, files: readonly unknown[], label?: unknown): TestRun {
    const stamp = this.now().toISOString();
    const seen = new Set<string>();
    const runFiles: TestRunFile[] = [];
    for (const raw of files.slice(0, MAX_FILES)) {
      const filePath = normalizeFile(raw);
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      runFiles.push({ filePath, status: 'pending', tests: [] });
    }
    const run: TestRun = {
      id: `${this.now().getTime()}-${++this.sequence}`,
      repoPath,
      label: clip(label, 200) ?? null,
      status: 'running',
      startedAt: stamp,
      updatedAt: stamp,
      finishedAt: null,
      totals: computeTotals(runFiles),
      files: runFiles,
    };
    this.runs.set(repoPath, run);
    return run;
  }

  /**
   * Merge results into the current run, starting one if none is open. A test
   * reported twice (a retry) keeps its latest result.
   */
  report(repoPath: string, results: readonly unknown[]): TestRun {
    const existing = this.runs.get(repoPath);
    const run = existing && existing.status === 'running' ? existing : this.start(repoPath, []);
    const byPath = new Map(run.files.map((file) => [file.filePath, file]));

    for (const raw of results) {
      const result = raw as Partial<TestCaseResult> | null;
      const filePath = normalizeFile(result?.file);
      const name = clip(result?.name, 300);
      if (!filePath || !name || !isResultStatus(result?.status)) continue;

      let file = byPath.get(filePath);
      if (!file) {
        if (run.files.length >= MAX_FILES) continue;
        file = { filePath, status: 'pending', tests: [] };
        byPath.set(filePath, file);
        run.files.push(file);
      }
      const test = {
        name,
        status: result.status,
        durationMs:
          typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)
            ? Math.max(0, Math.round(result.durationMs))
            : undefined,
        message: clip(result.message, MAX_MESSAGE_CHARS),
        details: clip(result.details, MAX_DETAILS_CHARS),
      };
      const index = file.tests.findIndex((t) => t.name === name);
      if (index !== -1) file.tests[index] = test;
      else if (file.tests.length < MAX_TESTS_PER_FILE) file.tests.push(test);
      file.status = fileStatus(file.tests);
    }

    run.totals = computeTotals(run.files);
    run.updatedAt = this.now().toISOString();
    return run;
  }

  /** Close the current run. Files that never reported stay pending — visibly not run. */
  finish(repoPath: string): TestRun | null {
    const run = this.runs.get(repoPath);
    if (!run) return null;
    const stamp = this.now().toISOString();
    run.status = 'finished';
    run.finishedAt = stamp;
    run.updatedAt = stamp;
    return run;
  }

  clear(repoPath: string): void {
    this.runs.delete(repoPath);
  }
}
