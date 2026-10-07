/**
 * File-level impact and test selection.
 *
 * `impact` answers "what breaks if I change this symbol". The two questions
 * here are coarser and are asked about paths, not symbols:
 *
 *   - path_impact:    "I am about to change this folder / file — which other
 *                      folders, files and tests depend on it?"
 *   - affected_tests: "these files changed — which tests should run?"
 *
 * Both reduce to reverse reachability over a file → file dependency graph
 * derived from the symbol graph (a file depends on another when any symbol in
 * it calls, imports, extends or implements a symbol in the other).
 *
 * Everything in this module is pure: the backend supplies the indexed files
 * and the dependency edges, so the logic can be tested without a database.
 *
 * The graph is static. It does not see dispatch that only exists at runtime —
 * HTTP routes hit by URL, container/facade lookups, config keys, templates —
 * so every answer is a LOWER BOUND. `affected_tests` therefore reports how each
 * changed file was covered and asks for the full suite when it cannot vouch
 * for a change, instead of silently returning a short list.
 */
import { isTestFilePath } from '../../core/ingestion/utils/test-file-path.js';

/** `src` depends on `dst` (changing `dst` can affect `src`). */
export interface FileDependencyEdge {
  src: string;
  dst: string;
}

/** Relationship types that make one file depend on another. */
export const FILE_DEPENDENCY_EDGE_TYPES = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'] as const;

/**
 * Edges below this confidence are name-only guesses (a migration calling
 * `$table->references()` "resolving" to an unrelated method of that name).
 * They are fine as hints on a single symbol but wreck a transitive file walk,
 * where one bad edge drags a whole folder in.
 */
export const FILE_DEPENDENCY_MIN_CONFIDENCE = 0.8;

/** One row per distinct (dependent file, dependency file) pair. */
export function buildFileDependencyQuery(
  minConfidence: number = FILE_DEPENDENCY_MIN_CONFIDENCE,
): string {
  const threshold = Number.isFinite(minConfidence) ? Math.min(1, Math.max(0, minConfidence)) : 0;
  return `MATCH (a)-[r:CodeRelation]->(b)
WHERE r.type IN [${FILE_DEPENDENCY_EDGE_TYPES.map((t) => `'${t}'`).join(', ')}]
  AND a.filePath <> b.filePath
  AND (r.confidence IS NULL OR r.confidence >= ${threshold})
RETURN DISTINCT a.filePath AS src, b.filePath AS dst`;
}

export const INDEXED_FILES_QUERY = `MATCH (f:File) RETURN f.filePath AS filePath`;

export const PATH_IMPACT_DEFAULT_MAX_DEPTH = 3;
export const PATH_IMPACT_DEFAULT_LIMIT = 200;

/** Repo-relative, forward-slashed, no leading `./` and no trailing slash. */
export function normalizeRepoPath(input: string): string {
  let p = input.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return p;
}

const dirnameOf = (filePath: string): string => {
  const cut = filePath.lastIndexOf('/');
  return cut === -1 ? '.' : filePath.slice(0, cut);
};

/**
 * Resolve user-supplied paths to indexed files. A path selects the file with
 * that exact path, or — as a folder — every file below it.
 */
export function matchSeedFiles(
  indexedFiles: readonly string[],
  paths: readonly string[],
): { seeds: Set<string>; unmatched: string[] } {
  const seeds = new Set<string>();
  const unmatched: string[] = [];
  for (const raw of paths) {
    const target = normalizeRepoPath(raw);
    if (target === '') {
      unmatched.push(raw);
      continue;
    }
    const prefix = `${target}/`;
    let hit = false;
    for (const file of indexedFiles) {
      if (file === target || file.startsWith(prefix)) {
        seeds.add(file);
        hit = true;
      }
    }
    if (!hit) unmatched.push(raw);
  }
  return { seeds, unmatched };
}

/** dependency file → the files that depend on it. */
export function buildDependentsIndex(edges: readonly FileDependencyEdge[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const { src, dst } of edges) {
    if (!src || !dst || src === dst) continue;
    const list = dependents.get(dst);
    if (list) list.push(src);
    else dependents.set(dst, [src]);
  }
  return dependents;
}

/** dependent file → the files it depends on. */
export function buildDependenciesIndex(
  edges: readonly FileDependencyEdge[],
): Map<string, string[]> {
  const dependencies = new Map<string, string[]>();
  for (const { src, dst } of edges) {
    if (!src || !dst || src === dst) continue;
    const list = dependencies.get(src);
    if (list) list.push(dst);
    else dependencies.set(src, [dst]);
  }
  return dependencies;
}

export interface ReachedFile {
  /** Hops from the nearest seed (1 = depends on a seed directly). */
  depth: number;
  /** The seed this file was first reached from. */
  via: string;
}

/**
 * Breadth-first walk from `seeds` along "is depended on by". Seeds themselves
 * are not part of the result. `maxDepth` of `null` walks to the end.
 */
export function reverseReach(
  dependents: ReadonlyMap<string, readonly string[]>,
  seeds: Iterable<string>,
  maxDepth: number | null,
): Map<string, ReachedFile> {
  const seedSet = new Set(seeds);
  const reached = new Map<string, ReachedFile>();
  let frontier: Array<{ file: string; via: string }> = [...seedSet].map((file) => ({
    file,
    via: file,
  }));
  for (let depth = 1; frontier.length > 0 && (maxDepth === null || depth <= maxDepth); depth++) {
    const next: Array<{ file: string; via: string }> = [];
    for (const { file, via } of frontier) {
      for (const dependent of dependents.get(file) ?? []) {
        if (seedSet.has(dependent) || reached.has(dependent)) continue;
        reached.set(dependent, { depth, via });
        next.push({ file: dependent, via });
      }
    }
    frontier = next;
  }
  return reached;
}

const byDepthThenPath = (
  a: { depth: number; filePath: string },
  b: { depth: number; filePath: string },
): number => a.depth - b.depth || (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0);

// ---------------------------------------------------------------------------
// path_impact
// ---------------------------------------------------------------------------

export interface PathImpactInput {
  indexedFiles: readonly string[];
  edges: readonly FileDependencyEdge[];
  paths: readonly string[];
  maxDepth?: number | null;
  /** Cap on the `files` listing (folders, tests and counts are never capped). */
  limit?: number;
  /** Leave test files out of `files` / `folders` (they stay in `tests`). */
  includeTests?: boolean;
}

export interface PathImpactResult {
  paths: string[];
  unmatched_paths: string[];
  summary: {
    seed_files: number;
    impacted_files: number;
    impacted_folders: number;
    impacted_tests: number;
    by_depth: Record<string, number>;
    max_depth: number | null;
  };
  /** Impacted folders, nearest first, each with how many of its files are hit. */
  folders: Array<{ folder: string; files: number; min_depth: number; tests: number }>;
  files: Array<{ filePath: string; depth: number; folder: string; is_test: boolean }>;
  tests: Array<{ filePath: string; depth: number }>;
  /**
   * The other direction: what the given paths themselves use, one hop out.
   * Entry-point code (commands, controllers, jobs) usually has no dependents
   * at all, and this is the context an agent needs before editing it.
   */
  depends_on: {
    files: number;
    folders: Array<{ folder: string; files: number }>;
    sample: string[];
  };
  truncated: boolean;
  note: string;
}

export const STATIC_GRAPH_NOTE =
  'Static dependency graph: calls, imports and inheritance only. Runtime dispatch (HTTP routes by URL, ' +
  'container/facade lookups, config keys, templates) is invisible, so treat this as a lower bound.';

export function computePathImpact(input: PathImpactInput): PathImpactResult {
  const maxDepth = input.maxDepth === undefined ? PATH_IMPACT_DEFAULT_MAX_DEPTH : input.maxDepth;
  const limit = input.limit ?? PATH_IMPACT_DEFAULT_LIMIT;
  const includeTests = input.includeTests ?? true;

  const { seeds, unmatched } = matchSeedFiles(input.indexedFiles, input.paths);
  const reached = reverseReach(buildDependentsIndex(input.edges), seeds, maxDepth);

  const all = [...reached].map(([filePath, { depth }]) => ({
    filePath,
    depth,
    folder: dirnameOf(filePath),
    is_test: isTestFilePath(filePath),
  }));
  all.sort(byDepthThenPath);

  const tests = all.filter((f) => f.is_test).map(({ filePath, depth }) => ({ filePath, depth }));
  const listed = includeTests ? all : all.filter((f) => !f.is_test);

  const byDepth: Record<string, number> = {};
  const folders = new Map<string, { files: number; min_depth: number; tests: number }>();
  for (const file of listed) {
    byDepth[file.depth] = (byDepth[file.depth] ?? 0) + 1;
    const entry = folders.get(file.folder);
    if (entry) {
      entry.files += 1;
      entry.min_depth = Math.min(entry.min_depth, file.depth);
      if (file.is_test) entry.tests += 1;
    } else {
      folders.set(file.folder, { files: 1, min_depth: file.depth, tests: file.is_test ? 1 : 0 });
    }
  }
  const folderRows = [...folders]
    .map(([folder, entry]) => ({ folder, ...entry }))
    .sort(
      (a, b) =>
        a.min_depth - b.min_depth ||
        b.files - a.files ||
        (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0),
    );

  const dependencies = buildDependenciesIndex(input.edges);
  const used = new Set<string>();
  for (const seed of seeds) {
    for (const dependency of dependencies.get(seed) ?? []) {
      if (!seeds.has(dependency)) used.add(dependency);
    }
  }
  const usedFolders = new Map<string, number>();
  for (const file of used) {
    const folder = dirnameOf(file);
    usedFolders.set(folder, (usedFolders.get(folder) ?? 0) + 1);
  }
  const usedFolderRows = [...usedFolders]
    .map(([folder, files]) => ({ folder, files }))
    .sort((a, b) => b.files - a.files || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));

  return {
    paths: input.paths.map(normalizeRepoPath),
    unmatched_paths: unmatched,
    summary: {
      seed_files: seeds.size,
      impacted_files: listed.length,
      impacted_folders: folderRows.length,
      impacted_tests: tests.length,
      by_depth: byDepth,
      max_depth: maxDepth,
    },
    folders: folderRows,
    files: listed.slice(0, limit),
    tests,
    depends_on: {
      files: used.size,
      folders: usedFolderRows,
      sample: [...used].sort().slice(0, Math.min(limit, 50)),
    },
    truncated: listed.length > limit,
    note: STATIC_GRAPH_NOTE,
  };
}

// ---------------------------------------------------------------------------
// affected_tests
// ---------------------------------------------------------------------------

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  filePath: string;
  status: ChangeStatus;
}

/**
 * Parse `git diff --name-status --no-renames` output. With `--no-renames` a
 * rename arrives as a delete plus an add, which is what test selection wants:
 * the old path's dependents and the new path are both in play.
 */
export function parseNameStatus(output: string): ChangedFile[] {
  const changed: ChangedFile[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const [code, ...rest] = line.split('\t');
    const filePath = rest[rest.length - 1];
    if (!code || !filePath) continue;
    const status: ChangeStatus =
      code[0] === 'A'
        ? 'added'
        : code[0] === 'D'
          ? 'deleted'
          : code[0] === 'R'
            ? 'renamed'
            : 'modified';
    changed.push({ filePath: normalizeRepoPath(filePath), status });
  }
  return changed;
}

/** Changes that cannot alter test outcomes and are safe to ignore. */
const IGNORABLE_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.pdf',
]);
const IGNORABLE_BASENAMES = new Set([
  'license',
  'licence',
  'changelog',
  '.gitignore',
  '.gitattributes',
]);

export function isIgnorableChange(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  if (IGNORABLE_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  return dot !== -1 && IGNORABLE_EXTENSIONS.has(base.slice(dot));
}

export type TestReason =
  /** The test file itself changed. */
  | 'changed'
  /** The test depends (transitively) on a changed file. */
  | 'depends'
  /** Heuristic: the test exercises the same files a changed file works with. */
  | 'related';

export type Coverage = 'direct' | 'related' | 'none' | 'ignored' | 'test';

export interface AffectedTestsInput {
  indexedFiles: readonly string[];
  edges: readonly FileDependencyEdge[];
  changedFiles: readonly ChangedFile[];
  /** Depth of the dependency walk; `null` (default) walks to the end. */
  maxDepth?: number | null;
  /** Treat heuristic-only coverage as not covered (asks for the full suite). */
  strict?: boolean;
}

export interface AffectedTestsResult {
  summary: {
    changed_files: number;
    tests: number;
    fallback: 'none' | 'full_suite';
    message: string;
  };
  /** Why the selection cannot be trusted on its own; empty when it can. */
  fallback_reasons: string[];
  tests: Array<{ filePath: string; reason: TestReason; depth: number; via: string }>;
  /** How each changed file was accounted for. */
  changed: Array<{ filePath: string; status: ChangeStatus; coverage: Coverage; tests: number }>;
  runner: TestRunner | null;
  command_hint: string | null;
  note: string;
}

/** How far the "related" heuristic looks back from a changed file's dependencies. */
const RELATED_TEST_DEPTH = 2;

export function computeAffectedTests(input: AffectedTestsInput): AffectedTestsResult {
  const maxDepth = input.maxDepth === undefined ? null : input.maxDepth;
  const indexed = new Set(input.indexedFiles);
  const dependents = buildDependentsIndex(input.edges);
  const dependencies = buildDependenciesIndex(input.edges);

  const tests = new Map<string, { reason: TestReason; depth: number; via: string }>();
  const rank: Record<TestReason, number> = { changed: 0, depends: 1, related: 2 };
  const addTest = (filePath: string, reason: TestReason, depth: number, via: string): void => {
    const current = tests.get(filePath);
    if (
      !current ||
      rank[reason] < rank[current.reason] ||
      (reason === current.reason && depth < current.depth)
    ) {
      tests.set(filePath, { reason, depth, via });
    }
  };

  const fallbackReasons: string[] = [];
  const changed: AffectedTestsResult['changed'] = [];

  for (const change of input.changedFiles) {
    const { filePath, status } = change;

    if (isTestFilePath(filePath)) {
      // A deleted test has nothing to run; an added or edited one runs itself.
      // Shared test support (a base TestCase, fixtures) also reaches its users.
      if (status !== 'deleted') addTest(filePath, 'changed', 0, filePath);
      let reachedTests = 0;
      for (const [file, hit] of reverseReach(dependents, [filePath], maxDepth)) {
        if (!isTestFilePath(file)) continue;
        addTest(file, 'depends', hit.depth, filePath);
        reachedTests += 1;
      }
      changed.push({
        filePath,
        status,
        coverage: 'test',
        tests: reachedTests + (status !== 'deleted' ? 1 : 0),
      });
      continue;
    }

    if (isIgnorableChange(filePath)) {
      changed.push({ filePath, status, coverage: 'ignored', tests: 0 });
      continue;
    }

    if (!indexed.has(filePath)) {
      // Not a file the graph knows: configuration, a migration, a template, a
      // lockfile — or source deleted since the index was built. None of those
      // can be mapped to tests, and any of them can change behaviour.
      changed.push({ filePath, status, coverage: 'none', tests: 0 });
      fallbackReasons.push(
        status === 'deleted'
          ? `${filePath} was deleted and is not in the index, so its dependents cannot be traced.`
          : `${filePath} is not an indexed source file (config, migration, template, lockfile…).`,
      );
      continue;
    }

    let direct = 0;
    for (const [file, hit] of reverseReach(dependents, [filePath], maxDepth)) {
      if (!isTestFilePath(file)) continue;
      addTest(file, 'depends', hit.depth, filePath);
      direct += 1;
    }
    if (direct > 0) {
      changed.push({ filePath, status, coverage: 'direct', tests: direct });
      continue;
    }

    // No test reaches this file through the graph. Typical for code entered at
    // runtime only (a controller behind a route). Fall back to the tests that
    // exercise what this file works with.
    let related = 0;
    const neighbours = dependencies.get(filePath) ?? [];
    for (const [file, hit] of reverseReach(dependents, neighbours, RELATED_TEST_DEPTH)) {
      if (!isTestFilePath(file)) continue;
      addTest(file, 'related', hit.depth + 1, filePath);
      related += 1;
    }
    if (related > 0 && !input.strict) {
      changed.push({ filePath, status, coverage: 'related', tests: related });
      continue;
    }
    changed.push({ filePath, status, coverage: related > 0 ? 'related' : 'none', tests: related });
    fallbackReasons.push(
      related > 0
        ? `${filePath} is only covered heuristically (strict mode).`
        : `No test depends on ${filePath}, directly or through the files it uses.`,
    );
  }

  const testRows = [...tests]
    .map(([filePath, hit]) => ({ filePath, ...hit }))
    .sort((a, b) => rank[a.reason] - rank[b.reason] || byDepthThenPath(a, b));

  const fallback = fallbackReasons.length > 0 ? 'full_suite' : 'none';
  const runner = detectTestRunner(
    testRows.map((t) => t.filePath),
    input.indexedFiles,
  );
  const message =
    input.changedFiles.length === 0
      ? 'No changed files.'
      : fallback === 'full_suite'
        ? `Run the full suite: ${fallbackReasons.length} change(s) could not be mapped to tests.`
        : testRows.length === 0
          ? 'No tests are affected by these changes.'
          : `${testRows.length} test file(s) cover the ${input.changedFiles.length} changed file(s).`;

  return {
    summary: {
      changed_files: input.changedFiles.length,
      tests: testRows.length,
      fallback,
      message,
    },
    fallback_reasons: fallbackReasons,
    tests: testRows,
    changed,
    runner,
    command_hint:
      runner && testRows.length > 0
        ? buildTestCommand(
            runner,
            testRows.map((t) => t.filePath),
          )
        : null,
    note: STATIC_GRAPH_NOTE,
  };
}

// ---------------------------------------------------------------------------
// test runner hint
// ---------------------------------------------------------------------------

export type TestRunner = 'artisan' | 'phpunit' | 'vitest' | 'jest' | 'pytest' | 'go';

/** Best-effort guess from the selected tests and what sits at the repo root. */
export function detectTestRunner(
  testFiles: readonly string[],
  indexedFiles: readonly string[],
): TestRunner | null {
  if (testFiles.length === 0) return null;
  const has = (ext: string): boolean => testFiles.some((f) => f.toLowerCase().endsWith(ext));
  const rootHas = (name: string): boolean => indexedFiles.includes(name);

  if (has('.php')) return rootHas('artisan') ? 'artisan' : 'phpunit';
  if (has('.py')) return 'pytest';
  if (has('_test.go')) return 'go';
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].some(has)) {
    const jest = indexedFiles.some((f) => /^jest\.config\.[cm]?[jt]s$/.test(f));
    return jest ? 'jest' : 'vitest';
  }
  return null;
}

const quoteArg = (arg: string): string => (/[^\w@%+=:,./-]/.test(arg) ? `"${arg}"` : arg);

const phpClassFilter = (testFiles: readonly string[]): string =>
  [...new Set(testFiles.map((f) => f.slice(f.lastIndexOf('/') + 1).replace(/\.php$/i, '')))].join(
    '|',
  );

export function buildTestCommand(runner: TestRunner, testFiles: readonly string[]): string {
  const files = testFiles.map(quoteArg).join(' ');
  switch (runner) {
    // PHPUnit takes one path argument, so select by test class name instead.
    // `--filter` is a regex over "Namespace\Class::method"; a class whose name
    // merely contains one of these also runs, which errs on the safe side.
    case 'artisan':
      return `php artisan test --filter "${phpClassFilter(testFiles)}"`;
    case 'phpunit':
      return `vendor/bin/phpunit --filter "${phpClassFilter(testFiles)}"`;
    case 'vitest':
      return `npx vitest run ${files}`;
    case 'jest':
      return `npx jest ${files}`;
    case 'pytest':
      return `pytest ${files}`;
    case 'go': {
      const packages = [...new Set(testFiles.map((f) => `./${dirnameOf(f)}`))];
      return `go test ${packages.map(quoteArg).join(' ')}`;
    }
  }
}
