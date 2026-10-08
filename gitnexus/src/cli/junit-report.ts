/**
 * JUnit XML → per-test results.
 *
 * JUnit XML is the one report format every runner the `testes` skill drives can
 * write (PHPUnit `--log-junit`, Vitest/Jest/Playwright junit reporters, pytest
 * `--junitxml`, gotestsum). The dialects differ mainly in where the test file is
 * named, so that is resolved here; everything else is the common core.
 *
 * Deliberately a small scanner, not an XML library: the input is machine-written
 * and flat, and this runs in the CLI's cold path.
 */

export interface JUnitCase {
  /** As written by the runner: absolute, repo-relative, or a dotted class name. */
  file: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs?: number;
  message?: string;
  details?: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });

const parseAttributes = (source: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    attributes[match[1]] = decode(match[2] ?? match[3] ?? '');
  }
  return attributes;
};

const innerText = (body: string): string =>
  decode(
    body
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, cdata: string) =>
        cdata.replace(/&/g, '&amp;').replace(/</g, '&lt;'),
      )
      .replace(/<[^>]+>/g, ''),
  ).trim();

const looksLikePath = (value: string | undefined): value is string =>
  !!value && /[\\/]/.test(value) && /\.[A-Za-z0-9]+$/.test(value.split('::')[0]);

/**
 * The line that says what went wrong. PHPUnit opens a failure body with the
 * test's own id (`Tests\Feature\SaleTest::test_x`), which says nothing.
 */
const firstLine = (text: string, testName = ''): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !(testName && line.endsWith(`::${testName}`))) ?? '';

export function parseJUnitXml(xml: string): JUnitCase[] {
  const cases: JUnitCase[] = [];
  // Enclosing <testsuite> attributes, innermost last: Vitest and Playwright name
  // the file on the suite, PHPUnit on both, pytest on neither.
  const suites: Array<Record<string, string>> = [];
  const tag = /<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tag.exec(xml)) !== null) {
    const [, closing, element, rawAttributes, selfClosing] = match;
    if (element === 'testsuite') {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(parseAttributes(rawAttributes));
      continue;
    }
    if (closing) continue;

    const attributes = parseAttributes(rawAttributes);
    let body = '';
    if (!selfClosing) {
      const end = xml.indexOf('</testcase>', tag.lastIndex);
      body = end === -1 ? '' : xml.slice(tag.lastIndex, end);
      if (end !== -1) tag.lastIndex = end;
    }

    const suiteFile = [...suites]
      .reverse()
      .map((suite) => suite.file ?? (looksLikePath(suite.name) ? suite.name : undefined))
      .find(Boolean);
    const file =
      attributes.file ??
      suiteFile ??
      (looksLikePath(attributes.classname) ? attributes.classname : undefined) ??
      attributes.classname ??
      attributes.class ??
      '';
    const name = attributes.name ?? '';
    if (!file || !name) continue;

    const problem = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skipped = /<skipped\b([^>]*?)(?:\/>|>([\s\S]*?)<\/skipped>)/.exec(body);
    const seconds = Number(attributes.time);
    const result: JUnitCase = {
      file: file.split('::')[0],
      name,
      status: problem ? 'failed' : skipped ? 'skipped' : 'passed',
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
    };
    if (problem) {
      const text = innerText(problem[3] ?? '');
      const attrs = parseAttributes(problem[2]);
      result.message = attrs.message || firstLine(text, name) || attrs.type || 'Test failed';
      if (text) result.details = text;
    } else if (skipped) {
      const text = innerText(skipped[2] ?? '');
      result.message = parseAttributes(skipped[1]).message || firstLine(text) || undefined;
    }
    cases.push(result);
  }
  return cases;
}

/**
 * Map a runner-reported file to a repo-relative path.
 *
 * Reports written inside a container carry the container's absolute path
 * (`/var/www/html/tests/…`), so a prefix strip against the host repo root is not
 * enough: the longest trailing part of the path that names a known repo file
 * wins. `exists` answers "is this repo-relative path a file?".
 */
export function toRepoRelativePath(
  reported: string,
  repoRoot: string,
  exists: (relativePath: string) => boolean,
): string | null {
  const slashed = reported.replace(/\\/g, '/');
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (slashed.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return slashed.slice(root.length + 1);
  }
  const parts = slashed
    .replace(/^[A-Za-z]:/, '')
    .split('/')
    .filter(Boolean);
  for (let start = 0; start < parts.length; start++) {
    const candidate = parts.slice(start).join('/');
    if (exists(candidate)) return candidate;
  }
  // A dotted class name (pytest `tests.unit.test_sale`) has no slashes at all.
  if (!slashed.includes('/') && slashed.includes('.')) {
    const asPath = slashed.split('.').join('/');
    for (const extension of ['.py', '.php', '.java', '.kt', '.cs']) {
      if (exists(asPath + extension)) return asPath + extension;
    }
  }
  return null;
}
