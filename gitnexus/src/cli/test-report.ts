/**
 * `gitnexus test-report` — show a test run on the graph in the web UI.
 *
 *   gitnexus test-report --start --files tests/A.php tests/B.php --open
 *   gitnexus test-report --junit storage/junit.xml
 *   gitnexus test-report --finish
 *
 * Flags combine (`--junit report.xml --finish`). The run lives in the local
 * `gitnexus serve` process; `--start` launches one when none is listening.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseJUnitXml, toRepoRelativePath } from './junit-report.js';

export interface TestReportOptions {
  start?: boolean;
  files?: string[];
  junit?: string[];
  finish?: boolean;
  clear?: boolean;
  label?: string;
  repo?: string;
  port?: string;
  open?: boolean;
}

const SERVER_START_TIMEOUT_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isServerUp = async (origin: string): Promise<boolean> => {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
};

/** Start `gitnexus serve` detached, so it outlives this command, and wait for it. */
const startServer = async (origin: string, port: number): Promise<boolean> => {
  const child = spawn(process.execPath, [process.argv[1], 'serve', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isServerUp(origin)) return true;
    await sleep(500);
  }
  return false;
};

const openInBrowser = (url: string): void => {
  const [command, args] =
    process.platform === 'win32'
      ? // `start` treats its first quoted argument as the window title.
        ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args as string[], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32',
    }).unref();
  } catch {
    /* no browser to open (headless host): the URL is printed either way */
  }
};

const post = async (origin: string, body: Record<string, unknown>): Promise<any> => {
  const response = await fetch(`${origin}/api/test-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Server answered ${response.status}`);
  return payload;
};

export async function testReportCommand(options: TestReportOptions = {}): Promise<void> {
  const repoPath = path.resolve(options.repo ?? process.cwd());
  const port = Number(options.port ?? 4747);
  const origin = `http://localhost:${port}`;
  const fail = (message: string): void => {
    process.stderr.write(`test-report: ${message}\n`);
    process.exitCode = 1;
  };

  if (!options.start && !options.junit?.length && !options.finish && !options.clear) {
    fail('nothing to do — pass --start, --junit <file>, --finish or --clear.');
    return;
  }

  let up = await isServerUp(origin);
  if (!up && options.start) {
    process.stderr.write(`test-report: starting gitnexus serve on port ${port}…\n`);
    up = await startServer(origin, port);
  }
  if (!up) {
    fail(`no gitnexus server on ${origin}. Run \`gitnexus serve\` or use --start.`);
    return;
  }

  const toRelative = (file: string): string | null =>
    toRepoRelativePath(file, repoPath, (candidate) => {
      try {
        return fs.statSync(path.join(repoPath, candidate)).isFile();
      } catch {
        return false;
      }
    });

  try {
    let run: any = null;

    if (options.clear) {
      await post(origin, { repo: repoPath, action: 'clear' });
    }

    if (options.start) {
      const files = (options.files ?? []).map((f) => toRelative(f) ?? f.replace(/\\/g, '/'));
      const started = await post(origin, {
        repo: repoPath,
        action: 'start',
        files,
        label: options.label,
      });
      run = started.run;
      const url =
        `${origin}/?repo=${encodeURIComponent(repoPath)}` +
        `&server=${encodeURIComponent(origin)}&tests=1`;
      if (started.webUi === false) {
        process.stderr.write(
          'test-report: this server has no web UI bundled. Build it (`npm run build` in ' +
            'gitnexus-web) or open your own web UI with ?tests=1.\n',
        );
      } else if (options.open !== false && !started.viewerActive) {
        openInBrowser(url);
      }
      process.stderr.write(`test-report: live view at ${url}\n`);
    }

    for (const reportPath of options.junit ?? []) {
      let xml: string;
      try {
        xml = fs.readFileSync(path.resolve(reportPath), 'utf-8');
      } catch (err: any) {
        fail(`cannot read ${reportPath}: ${err.message}`);
        continue;
      }
      const cases = parseJUnitXml(xml);
      const unmapped = new Set<string>();
      const results = [];
      for (const testCase of cases) {
        const file = toRelative(testCase.file);
        if (!file) {
          unmapped.add(testCase.file);
          continue;
        }
        results.push({ ...testCase, file });
      }
      if (unmapped.size > 0) {
        process.stderr.write(
          `test-report: ${unmapped.size} reported file(s) are not in this repository and were ` +
            `skipped (e.g. ${[...unmapped][0]}).\n`,
        );
      }
      // Posted in slices: a full-suite report can exceed the request body limit.
      for (let offset = 0; offset < results.length || offset === 0; offset += 500) {
        const slice = results.slice(offset, offset + 500);
        run = (await post(origin, { repo: repoPath, action: 'report', results: slice })).run;
        if (results.length === 0) break;
      }
    }

    if (options.finish) {
      run = (await post(origin, { repo: repoPath, action: 'finish' })).run ?? run;
    }

    process.stdout.write(
      `${JSON.stringify({ status: run?.status ?? null, totals: run?.totals ?? null }, null, 2)}\n`,
    );
  } catch (err: any) {
    fail(err.message || String(err));
  }
}
