import { describe, expect, it } from 'vitest';
import { parseJUnitXml, toRepoRelativePath } from '../../src/cli/junit-report.js';
import { TestRunStore } from '../../src/server/test-runs.js';

describe('parseJUnitXml', () => {
  it('reads PHPUnit output: file on the case, failure text, skipped', () => {
    const cases = parseJUnitXml(`<?xml version="1.0"?>
<testsuites><testsuite name="Feature">
  <testsuite name="Tests\\Feature\\SaleTest" file="/var/www/html/tests/Feature/SaleTest.php">
    <testcase name="test_lists_sales" file="/var/www/html/tests/Feature/SaleTest.php" time="0.25"/>
    <testcase name="test_blocks_guests" file="/var/www/html/tests/Feature/SaleTest.php" time="0.1">
      <failure type="ExpectationFailedException">Tests\\Feature\\SaleTest::test_blocks_guests
Expected status 302 but received 200.
Failed asserting that 200 is identical to 302.</failure>
    </testcase>
    <testcase name="test_later" file="/var/www/html/tests/Feature/SaleTest.php" time="0"><skipped/></testcase>
  </testsuite>
</testsuite></testsuites>`);

    expect(cases.map((c) => [c.name, c.status])).toEqual([
      ['test_lists_sales', 'passed'],
      ['test_blocks_guests', 'failed'],
      ['test_later', 'skipped'],
    ]);
    expect(cases[0]).toMatchObject({
      file: '/var/www/html/tests/Feature/SaleTest.php',
      durationMs: 250,
    });
    // The test's own id on the first line says nothing; the reason follows it.
    expect(cases[1].message).toBe('Expected status 302 but received 200.');
    expect(cases[1].details).toContain('Failed asserting that 200 is identical to 302.');
  });

  it('takes the file from the enclosing suite (Vitest, Playwright)', () => {
    const cases = parseJUnitXml(`<testsuites>
  <testsuite name="src/cart.test.ts" tests="2">
    <testcase classname="src/cart.test.ts" name="cart &gt; adds an item" time="0.004"></testcase>
    <testcase classname="src/cart.test.ts" name="cart &gt; rejects &quot;zero&quot;" time="0.002">
      <failure message="expected 1 to be 0" type="AssertionError"><![CDATA[AssertionError: expected 1 to be 0
 at src/cart.test.ts:12:5 <anonymous>]]></failure>
    </testcase>
  </testsuite>
</testsuites>`);

    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({ file: 'src/cart.test.ts', name: 'cart > adds an item' });
    expect(cases[1]).toMatchObject({
      name: 'cart > rejects "zero"',
      status: 'failed',
      message: 'expected 1 to be 0',
    });
    expect(cases[1].details).toContain('at src/cart.test.ts:12:5 <anonymous>');
  });

  it('falls back to the class name when no file is given (pytest)', () => {
    const [testCase] = parseJUnitXml(
      `<testsuite name="pytest"><testcase classname="tests.unit.test_sale" name="test_total" time="0.01"><error message="boom"/></testcase></testsuite>`,
    );
    expect(testCase).toMatchObject({
      file: 'tests.unit.test_sale',
      status: 'failed',
      message: 'boom',
    });
  });
});

describe('toRepoRelativePath', () => {
  const files = new Set(['tests/Feature/SaleTest.php', 'tests/unit/test_sale.py']);
  const exists = (p: string) => files.has(p);

  it('strips the host repo root', () => {
    expect(
      toRepoRelativePath('C:\\work\\shop\\tests\\Feature\\SaleTest.php', 'C:\\work\\shop', exists),
    ).toBe('tests/Feature/SaleTest.php');
  });

  it('maps a container path by its longest known tail', () => {
    expect(
      toRepoRelativePath('/var/www/html/tests/Feature/SaleTest.php', '/home/me/shop', exists),
    ).toBe('tests/Feature/SaleTest.php');
  });

  it('resolves a dotted class name and rejects unknown files', () => {
    expect(toRepoRelativePath('tests.unit.test_sale', '/repo', exists)).toBe(
      'tests/unit/test_sale.py',
    );
    expect(toRepoRelativePath('/elsewhere/OtherTest.php', '/repo', exists)).toBeNull();
  });
});

describe('TestRunStore', () => {
  const store = () => {
    let tick = 0;
    return new TestRunStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
  };
  const REPO = '/repo';

  it('starts with every file pending', () => {
    const run = store().start(
      REPO,
      ['tests/A.php', '.\\tests\\B.php', 'tests/A.php'],
      'artisan test',
    );
    expect(run.status).toBe('running');
    expect(run.label).toBe('artisan test');
    expect(run.files.map((f) => [f.filePath, f.status])).toEqual([
      ['tests/A.php', 'pending'],
      ['tests/B.php', 'pending'],
    ]);
    expect(run.totals).toMatchObject({ files: 2, pending: 2, tests: 0 });
  });

  it('colours a file by its worst test and keeps unreported files pending', () => {
    const s = store();
    s.start(REPO, ['tests/A.php', 'tests/B.php', 'tests/C.php']);
    const run = s.report(REPO, [
      { file: 'tests/A.php', name: 'one', status: 'passed', durationMs: 12.6 },
      { file: 'tests/A.php', name: 'two', status: 'failed', message: 'nope' },
      { file: 'tests/B.php', name: 'one', status: 'skipped' },
      { file: 'tests/New.php', name: 'one', status: 'passed' },
    ]);
    expect(Object.fromEntries(run.files.map((f) => [f.filePath, f.status]))).toEqual({
      'tests/A.php': 'failed',
      'tests/B.php': 'skipped',
      'tests/C.php': 'pending',
      'tests/New.php': 'passed',
    });
    expect(run.totals).toEqual({
      files: 4,
      tests: 4,
      pending: 1,
      passed: 2,
      failed: 1,
      skipped: 1,
    });
    expect(run.files[0].tests[0].durationMs).toBe(13);
  });

  it('keeps the latest result of a retried test and drops malformed entries', () => {
    const s = store();
    s.start(REPO, []);
    s.report(REPO, [{ file: 'tests/A.php', name: 'flaky', status: 'failed', message: 'first' }]);
    const run = s.report(REPO, [
      { file: 'tests/A.php', name: 'flaky', status: 'passed' },
      { file: '../outside.php', name: 'x', status: 'passed' },
      { file: 'tests/A.php', name: 'x', status: 'exploded' },
      null,
    ]);
    expect(run.files).toHaveLength(1);
    expect(run.files[0]).toMatchObject({ status: 'passed', tests: [{ name: 'flaky' }] });
  });

  it('finishes a run, and a later report opens a new one', () => {
    const s = store();
    const first = s.start(REPO, ['tests/A.php']);
    expect(s.finish(REPO)).toMatchObject({ status: 'finished', id: first.id });
    expect(s.get(REPO)?.finishedAt).not.toBeNull();

    const second = s.report(REPO, [{ file: 'tests/B.php', name: 'one', status: 'passed' }]);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('running');
    expect(s.finish('/other')).toBeNull();
  });

  it('remembers a recent viewer per repository', () => {
    let nowMs = Date.UTC(2026, 0, 1);
    const s = new TestRunStore(() => new Date(nowMs));
    expect(s.hasActiveViewer(REPO)).toBe(false);
    s.markViewed(REPO);
    nowMs += 5_000;
    expect(s.hasActiveViewer(REPO)).toBe(true);
    expect(s.hasActiveViewer('/other')).toBe(false);
    nowMs += 10_000;
    expect(s.hasActiveViewer(REPO)).toBe(false);
  });
});
