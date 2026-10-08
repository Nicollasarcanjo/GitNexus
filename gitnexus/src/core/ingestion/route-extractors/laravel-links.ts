/**
 * Laravel links the parser cannot see because they are strings resolved at
 * runtime: a feature test hitting a route, a controller rendering a view, a
 * view including another view.
 *
 * Without them the graph stops at the HTTP boundary — a controller looks
 * untested, and a changed Blade file reaches no test at all — so file-level
 * impact and test selection fall back to "run everything" for the most common
 * kind of change in a Laravel app.
 *
 * Everything here is pure string matching over file contents.
 */

export interface TestRouteCall {
  filePath: string;
  fetchURL: string;
  lineNumber: number;
}

/** `route('name'` — parameters after the name are irrelevant to which route it is. */
const NAMED_ROUTE_PATTERN = /\broute\(\s*['"]([^'"]+)['"]/g;

/**
 * HTTP test helpers called with a literal absolute path: `$this->get('/x')`,
 * `->postJson('/x', ...)`, `->json('POST', '/x')`, Dusk's `->visit('/x')`.
 */
const TEST_URL_PATTERNS: readonly RegExp[] = [
  /->(?:get|post|put|patch|delete|options|head)(?:Json)?\(\s*['"](\/[^'"]*)['"]/g,
  /->(?:json|call)\(\s*['"][A-Za-z]+['"]\s*,\s*['"](\/[^'"]*)['"]/g,
  /->(?:visit|from)\(\s*['"](\/[^'"]*)['"]/g,
];

/**
 * Routes a PHP test file exercises. A named route resolves to the URL exactly
 * as registered (placeholders included), so it matches its own Route node and
 * no sibling; a literal path is matched like any other consumer URL.
 */
export function extractTestRouteCalls(
  filePath: string,
  content: string,
  namedRouteUrls: ReadonlyMap<string, string>,
): TestRouteCall[] {
  const calls: TestRouteCall[] = [];
  const seen = new Set<string>();
  const add = (url: string | undefined): void => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    calls.push({ filePath, fetchURL: url, lineNumber: 0 });
  };

  NAMED_ROUTE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAMED_ROUTE_PATTERN.exec(content)) !== null) {
    add(namedRouteUrls.get(match[1]));
  }
  for (const pattern of TEST_URL_PATTERNS) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(content)) !== null) {
      // An interpolated path ("/sales/{$sale->id}") names no route statically.
      if (!match[1].includes('$')) add(match[1].split('?')[0]);
    }
  }
  return calls;
}

/** `view('a.b')`, `View::make('a.b')`, `->view('a.b')`, `Route::view('/x', 'a.b')`. */
const PHP_VIEW_PATTERNS: readonly RegExp[] = [
  /(?<![\w$>:])view\(\s*['"]([\w.\-/:]+)['"]/g,
  /\bView::(?:make|first|exists)\(\s*['"]([\w.\-/:]+)['"]/g,
  /->(?:view|markdown)\(\s*['"]([\w.\-/:]+)['"]/g,
  /\bRoute::view\(\s*['"][^'"]*['"]\s*,\s*['"]([\w.\-/:]+)['"]/g,
];

/** `@extends('a.b')`, `@include('a.b')` and friends. */
const BLADE_DIRECTIVE_PATTERN =
  /@(?:extends|include|includeIf|includeWhen|includeUnless|includeFirst|component|each)\(\s*(?:[^'"()]*,\s*)?['"]([\w.\-/:]+)['"]/g;

/** `<x-layout.app>` → the anonymous component view `components.layout.app`. */
const BLADE_COMPONENT_TAG_PATTERN = /<x-([a-z0-9][\w.\-]*(?:::[\w.\-]+)?)/gi;

/** `<livewire:orders.table>` / `@livewire('orders.table')` → `livewire.orders.table`. */
const BLADE_LIVEWIRE_PATTERNS: readonly RegExp[] = [
  /<livewire:([a-z0-9][\w.\-]*)/gi,
  /@livewire\(\s*['"]([\w.\-]+)['"]/g,
];

/** Dotted view names referenced by a PHP or Blade file, de-duplicated. */
export function extractViewReferences(filePath: string, content: string): string[] {
  const names = new Set<string>();
  const collect = (pattern: RegExp, prefix = ''): void => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) names.add(prefix + match[1]);
  };

  for (const pattern of PHP_VIEW_PATTERNS) collect(pattern);
  if (filePath.endsWith('.blade.php')) {
    collect(BLADE_DIRECTIVE_PATTERN);
    collect(BLADE_COMPONENT_TAG_PATTERN, 'components.');
    for (const pattern of BLADE_LIVEWIRE_PATTERNS) collect(pattern, 'livewire.');
  }
  return [...names];
}

/**
 * Index of the repo's Blade views by dotted name. Namespaced/package views
 * (`pkg::a.b`) are not resolved — the hint path lives in a service provider.
 */
export function buildViewIndex(allPaths: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const raw of allPaths) {
    const p = raw.replace(/\\/g, '/');
    if (!p.endsWith('.blade.php')) continue;
    const marker = p.lastIndexOf('resources/views/');
    if (marker === -1) continue;
    const relative = p.slice(marker + 'resources/views/'.length, -'.blade.php'.length);
    const name = relative.split('/').join('.');
    if (!index.has(name)) index.set(name, raw);
  }
  return index;
}

/** Resolve a dotted view name; a component may also be a folder's `index` view. */
export function resolveViewPath(
  name: string,
  viewIndex: ReadonlyMap<string, string>,
): string | undefined {
  if (name.includes('::')) return undefined;
  const dotted = name.replace(/\//g, '.');
  return viewIndex.get(dotted) ?? viewIndex.get(`${dotted}.index`);
}
