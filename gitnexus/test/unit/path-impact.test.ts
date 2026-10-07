import { describe, expect, it } from 'vitest';
import {
  buildFileDependencyQuery,
  buildTestCommand,
  computeAffectedTests,
  computePathImpact,
  detectTestRunner,
  isIgnorableChange,
  matchSeedFiles,
  normalizeRepoPath,
  parseNameStatus,
  reverseReach,
  buildDependentsIndex,
  type FileDependencyEdge,
} from '../../src/mcp/local/path-impact.js';

// A small Laravel-shaped repo.
//
//   SaleController ──▶ SaleService ──▶ Sale (model) ◀── SaleTest
//                          ▲                              │
//   routes/web.php ──▶ SaleController        SaleServiceTest ──▶ SaleService
//   ReportCommand ──▶ SaleService
//   TestCase ◀── every test
const FILES = [
  'artisan',
  'app/Models/Sale.php',
  'app/Services/SaleService.php',
  'app/Http/Controllers/SaleController.php',
  'app/Console/Commands/ReportCommand.php',
  'app/Support/Orphan.php',
  'routes/web.php',
  'tests/TestCase.php',
  'tests/Unit/SaleTest.php',
  'tests/Feature/SaleServiceTest.php',
];

const EDGES: FileDependencyEdge[] = [
  { src: 'app/Services/SaleService.php', dst: 'app/Models/Sale.php' },
  { src: 'app/Http/Controllers/SaleController.php', dst: 'app/Services/SaleService.php' },
  { src: 'app/Console/Commands/ReportCommand.php', dst: 'app/Services/SaleService.php' },
  { src: 'routes/web.php', dst: 'app/Http/Controllers/SaleController.php' },
  { src: 'tests/Unit/SaleTest.php', dst: 'app/Models/Sale.php' },
  { src: 'tests/Unit/SaleTest.php', dst: 'tests/TestCase.php' },
  { src: 'tests/Feature/SaleServiceTest.php', dst: 'app/Services/SaleService.php' },
  { src: 'tests/Feature/SaleServiceTest.php', dst: 'tests/TestCase.php' },
];

describe('buildFileDependencyQuery', () => {
  it('drops name-only guesses by default and clamps the threshold', () => {
    expect(buildFileDependencyQuery()).toContain('r.confidence >= 0.8');
    expect(buildFileDependencyQuery(0)).toContain('r.confidence >= 0)');
    expect(buildFileDependencyQuery(7)).toContain('r.confidence >= 1)');
    expect(buildFileDependencyQuery(Number.NaN)).toContain('r.confidence >= 0)');
  });
});

describe('normalizeRepoPath', () => {
  it('normalizes separators, leading ./ and trailing slashes', () => {
    expect(normalizeRepoPath('.\\app\\Console\\')).toBe('app/Console');
    expect(normalizeRepoPath('./app/Models/Sale.php')).toBe('app/Models/Sale.php');
    expect(normalizeRepoPath('/app/')).toBe('app');
  });
});

describe('matchSeedFiles', () => {
  it('selects a folder recursively and a file exactly', () => {
    const { seeds, unmatched } = matchSeedFiles(FILES, ['app/Console', 'app/Models/Sale.php']);
    expect([...seeds].sort()).toEqual([
      'app/Console/Commands/ReportCommand.php',
      'app/Models/Sale.php',
    ]);
    expect(unmatched).toEqual([]);
  });

  it('does not treat a path as a prefix of a sibling name', () => {
    // "app/Model" must not match "app/Models/…".
    const { seeds, unmatched } = matchSeedFiles(FILES, ['app/Model']);
    expect(seeds.size).toBe(0);
    expect(unmatched).toEqual(['app/Model']);
  });
});

describe('reverseReach', () => {
  it('walks dependents breadth-first and honours maxDepth', () => {
    const dependents = buildDependentsIndex(EDGES);
    const oneHop = reverseReach(dependents, ['app/Models/Sale.php'], 1);
    expect([...oneHop.keys()].sort()).toEqual([
      'app/Services/SaleService.php',
      'tests/Unit/SaleTest.php',
    ]);

    const all = reverseReach(dependents, ['app/Models/Sale.php'], null);
    expect(all.get('routes/web.php')).toEqual({ depth: 3, via: 'app/Models/Sale.php' });
    expect(all.has('app/Models/Sale.php')).toBe(false);
  });

  it('terminates on cycles', () => {
    const dependents = buildDependentsIndex([
      { src: 'a', dst: 'b' },
      { src: 'b', dst: 'a' },
    ]);
    expect([...reverseReach(dependents, ['a'], null).keys()]).toEqual(['b']);
  });
});

describe('computePathImpact', () => {
  it('groups what depends on a folder by folder, nearest first', () => {
    const result = computePathImpact({
      indexedFiles: FILES,
      edges: EDGES,
      paths: ['app/Models'],
    });

    expect(result.summary.seed_files).toBe(1);
    expect(result.summary.impacted_files).toBe(6);
    expect(result.summary.by_depth).toEqual({ 1: 2, 2: 3, 3: 1 });
    expect(result.folders[0]).toEqual({
      folder: 'app/Services',
      files: 1,
      min_depth: 1,
      tests: 0,
    });
    expect(result.tests).toEqual([
      { filePath: 'tests/Unit/SaleTest.php', depth: 1 },
      { filePath: 'tests/Feature/SaleServiceTest.php', depth: 2 },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('also reports what an entry-point folder uses when nothing depends on it', () => {
    const result = computePathImpact({
      indexedFiles: FILES,
      edges: EDGES,
      paths: ['app/Console'],
    });
    expect(result.summary.impacted_files).toBe(0);
    expect(result.depends_on).toEqual({
      files: 1,
      folders: [{ folder: 'app/Services', files: 1 }],
      sample: ['app/Services/SaleService.php'],
    });
  });

  it('reports unmatched paths and caps only the file listing', () => {
    const result = computePathImpact({
      indexedFiles: FILES,
      edges: EDGES,
      paths: ['app/Models', 'nope'],
      limit: 2,
    });
    expect(result.unmatched_paths).toEqual(['nope']);
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
    // Counts and folders still describe the whole impact.
    expect(result.summary.impacted_files).toBe(6);
    expect(result.folders.reduce((n, f) => n + f.files, 0)).toBe(6);
  });

  it('can leave tests out of the file and folder listings', () => {
    const result = computePathImpact({
      indexedFiles: FILES,
      edges: EDGES,
      paths: ['app/Models'],
      includeTests: false,
    });
    expect(result.files.some((f) => f.is_test)).toBe(false);
    expect(result.summary.impacted_files).toBe(4);
    expect(result.summary.impacted_tests).toBe(2);
  });
});

describe('parseNameStatus', () => {
  it('reads git --name-status rows', () => {
    expect(
      parseNameStatus('M\tapp/Models/Sale.php\nA\ttests/Unit/NewTest.php\nD\told.php\n'),
    ).toEqual([
      { filePath: 'app/Models/Sale.php', status: 'modified' },
      { filePath: 'tests/Unit/NewTest.php', status: 'added' },
      { filePath: 'old.php', status: 'deleted' },
    ]);
  });

  it('takes the new path of a rename row', () => {
    expect(parseNameStatus('R100\ta.php\tb.php')).toEqual([
      { filePath: 'b.php', status: 'renamed' },
    ]);
  });
});

describe('isIgnorableChange', () => {
  it('ignores docs and images but not code or config', () => {
    expect(isIgnorableChange('docs/guide.md')).toBe(true);
    expect(isIgnorableChange('public/logo.PNG')).toBe(true);
    expect(isIgnorableChange('LICENSE')).toBe(true);
    expect(isIgnorableChange('config/app.php')).toBe(false);
    expect(isIgnorableChange('composer.json')).toBe(false);
  });
});

describe('computeAffectedTests', () => {
  const run = (changed: Array<[string, 'added' | 'modified' | 'deleted']>, strict = false) =>
    computeAffectedTests({
      indexedFiles: FILES,
      edges: EDGES,
      changedFiles: changed.map(([filePath, status]) => ({ filePath, status })),
      strict,
    });

  it('selects the tests that depend on a changed file, transitively', () => {
    const result = run([['app/Models/Sale.php', 'modified']]);
    expect(result.summary.fallback).toBe('none');
    expect(result.tests.map((t) => [t.filePath, t.reason, t.depth])).toEqual([
      ['tests/Unit/SaleTest.php', 'depends', 1],
      ['tests/Feature/SaleServiceTest.php', 'depends', 2],
    ]);
    expect(result.changed).toEqual([
      { filePath: 'app/Models/Sale.php', status: 'modified', coverage: 'direct', tests: 2 },
    ]);
  });

  it('runs a changed test and everything that shares changed test support', () => {
    const edited = run([['tests/Unit/SaleTest.php', 'modified']]);
    expect(edited.tests).toEqual([
      {
        filePath: 'tests/Unit/SaleTest.php',
        reason: 'changed',
        depth: 0,
        via: 'tests/Unit/SaleTest.php',
      },
    ]);

    const base = run([['tests/TestCase.php', 'modified']]);
    expect(base.tests.map((t) => t.filePath).sort()).toEqual([
      'tests/Feature/SaleServiceTest.php',
      'tests/TestCase.php',
      'tests/Unit/SaleTest.php',
    ]);
    expect(base.summary.fallback).toBe('none');
  });

  it('does not schedule a deleted test', () => {
    const result = run([['tests/Unit/SaleTest.php', 'deleted']]);
    expect(result.tests).toEqual([]);
    expect(result.summary.fallback).toBe('none');
  });

  it('falls back to related tests for code no test reaches directly', () => {
    // Nothing imports the controller from a test; the service it uses is tested.
    const result = run([['app/Http/Controllers/SaleController.php', 'modified']]);
    expect(result.changed[0]).toMatchObject({ coverage: 'related' });
    expect(result.tests.map((t) => [t.filePath, t.reason])).toEqual([
      ['tests/Feature/SaleServiceTest.php', 'related'],
    ]);
    expect(result.summary.fallback).toBe('none');
  });

  it('asks for the full suite in strict mode when coverage is only heuristic', () => {
    const result = run([['app/Http/Controllers/SaleController.php', 'modified']], true);
    expect(result.summary.fallback).toBe('full_suite');
    expect(result.fallback_reasons[0]).toContain('heuristically');
  });

  it('asks for the full suite when a change cannot be mapped at all', () => {
    const orphan = run([['app/Support/Orphan.php', 'modified']]);
    expect(orphan.summary.fallback).toBe('full_suite');
    expect(orphan.changed[0]).toMatchObject({ coverage: 'none' });

    const config = run([['config/app.php', 'modified']]);
    expect(config.summary.fallback).toBe('full_suite');
    expect(config.fallback_reasons[0]).toContain('not an indexed source file');

    const deleted = run([['app/Models/Gone.php', 'deleted']]);
    expect(deleted.summary.fallback).toBe('full_suite');
    expect(deleted.fallback_reasons[0]).toContain('was deleted');
  });

  it('ignores documentation-only changes', () => {
    const result = run([['README.md', 'modified']]);
    expect(result.summary).toMatchObject({ tests: 0, fallback: 'none' });
    expect(result.changed[0]).toMatchObject({ coverage: 'ignored' });
  });

  it('prefers the strongest reason when several changes reach one test', () => {
    const result = run([
      ['app/Http/Controllers/SaleController.php', 'modified'],
      ['app/Services/SaleService.php', 'modified'],
    ]);
    const serviceTest = result.tests.find(
      (t) => t.filePath === 'tests/Feature/SaleServiceTest.php',
    );
    expect(serviceTest).toMatchObject({ reason: 'depends', depth: 1 });
  });

  it('suggests an artisan command filtered by test class', () => {
    const result = run([['app/Models/Sale.php', 'modified']]);
    expect(result.runner).toBe('artisan');
    expect(result.command_hint).toBe('php artisan test --filter "SaleTest|SaleServiceTest"');
  });

  it('reports an empty diff plainly', () => {
    const result = run([]);
    expect(result.summary).toMatchObject({ changed_files: 0, tests: 0, fallback: 'none' });
    expect(result.command_hint).toBeNull();
  });
});

describe('test runner hint', () => {
  it('detects the runner from the selected tests and repo root', () => {
    expect(detectTestRunner(['tests/A.php'], ['composer.json'])).toBe('phpunit');
    expect(detectTestRunner(['src/a.test.ts'], [])).toBe('vitest');
    expect(detectTestRunner(['src/a.test.ts'], ['jest.config.js'])).toBe('jest');
    expect(detectTestRunner(['tests/test_a.py'], [])).toBe('pytest');
    expect(detectTestRunner([], FILES)).toBeNull();
  });

  it('builds runner-specific commands', () => {
    expect(buildTestCommand('vitest', ['src/a.test.ts', 'src/b c.test.ts'])).toBe(
      'npx vitest run src/a.test.ts "src/b c.test.ts"',
    );
    expect(buildTestCommand('go', ['pkg/a/x_test.go', 'pkg/a/y_test.go', 'pkg/b/z_test.go'])).toBe(
      'go test ./pkg/a ./pkg/b',
    );
  });
});
