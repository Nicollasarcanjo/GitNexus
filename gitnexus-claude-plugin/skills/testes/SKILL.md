---
name: testes
description: 'Use to run or write tests guided by the GitNexus graph: with pending changes it runs only the tests the graph links to the changed files; without changes it runs the existing suite; "gerar" writes the missing tests area by area (backend and frontend). Examples: "/testes", "/testes gerar app/Services", "/testes tudo", "/testes status", "roda os testes do que eu mexi", "gera os testes que faltam", "run the affected tests".'
---

# testes — graph-guided tests

Run the tests a change actually needs, and write the ones that are missing,
using the GitNexus graph to decide which files matter instead of reading or
running everything.

```
/testes                 # auto: affected tests if there are changes, else the suite
/testes gerar [path]    # write missing tests, one area at a time (optionally under path)
/testes tudo            # run the full suite, no selection
/testes status          # coverage gaps and known failures, run nothing
```

Reply in the user's language. Never edit production code from this skill — a
test that exposes a real bug is reported, not "fixed" on either side.

Every command below is shown as `node .gitnexus/run.cjs <cmd>`; the MCP tools
`affected_tests`, `test_gaps` and `path_impact` take the same arguments. If
`.gitnexus/run.cjs` is missing, use `npx gitnexus <cmd>`.

## 1. Prepare (every mode)

1. **Index.** Run `node .gitnexus/run.cjs status`. No index, or the index is
   behind HEAD → `node .gitnexus/run.cjs analyze`. Files added since the last
   index are invisible to the graph, so re-analyze before selecting tests
   whenever new source files exist (`git status --short` shows `??` or `A`).
2. **Runners.** Read what the project really uses — do not guess from file
   extensions alone:
   - `composer.json` / `phpunit.xml` / `tests/Pest.php` → PHPUnit or Pest
     (`php artisan test` when `artisan` exists), Dusk when `laravel/dusk` is
     required.
   - `package.json` scripts and devDependencies → Vitest, Jest, Playwright,
     Cypress.
   - `pyproject.toml` / `pytest.ini`, `go.mod`, and so on for other stacks.
   - Project docs (`CLAUDE.md`, `AGENTS.md`, `README`, `Makefile`, CI workflow)
     for the exact command, required services, and environment (`.env.testing`,
     Docker/Sail). Prefer the project's own command over a generic one.
3. **State.** Read `.gitnexus/testes/relatorio.md` if it exists: it lists the
   known failures and bugs found by earlier runs.

## 2. Changes pending → run only what they affect

Default mode when `git status` shows changes, or the branch is ahead of its base.

```
node .gitnexus/run.cjs affected-tests --scope all            # working tree vs HEAD
node .gitnexus/run.cjs affected-tests --base-ref origin/main # whole branch
```

Read the result in this order:

1. `summary.fallback`
   - `none` → run each entry of `commands` (one per runner), adapting the
     command to the project's own (Sail, Docker, a `composer test` script).
   - `full_suite` → the selection cannot be trusted for this diff. Run the whole
     suite and show `fallback_reasons` to the user. Do not run the short list
     and call it done.
2. `changed[]` — how each changed file was covered:
   - `direct` / `test` → covered by the listed tests.
   - `related` → heuristic only; say so in the report.
   - `ignored` → docs, CI, container files.
   - `none` → **no test reaches this file.** If it is application code, write a
     test for it now (section 4, scoped to that file), run it, and include it.
     If it is global configuration or bootstrap code, the full suite is the
     right answer.
3. Untracked files are not in a git diff. Pass them explicitly:
   `affected-tests -p <file> <file>` and merge the two selections.

The graph links tests to code through calls, imports, inheritance, routes
(test → route → controller) and view references (controller → view → partial).
Events, queues, container bindings and config keys are still invisible: when a
change is of that kind (a listener, a job, a service provider, a middleware
alias), run the full suite even if the tool says `fallback: none`.

## Live view — every run is shown on the graph

Whenever this skill runs tests (sections 2, 3 and 4), the run is mirrored on the
GitNexus graph in the browser: each test file is a point that turns amber while
pending, green when it passes and red when it fails; clicking a point lists its
tests and, for a failure, why it failed. Do this for every run, without being
asked.

1. **Before running**, announce the run with the test files about to execute:

   ```
   node .gitnexus/run.cjs test-report --start --label <one-word-label> --files <test file> <test file> …
   ```

   Keep the label to one word (`afetados`, `suite`, `gerar`): the runner script
   does not preserve quoting on every shell. It starts the local GitNexus server if none is listening and opens the
   browser on the graph (it does not open a second tab when one is already
   watching). For a full-suite run, omit `--files`: files appear as they report.

2. **Run each command with a JUnit report**, written inside the repository so a
   containerized runner and the host see the same file:

   | Runner              | Add to the command                                                             |
   | ------------------- | ------------------------------------------------------------------------------ |
   | PHPUnit / `artisan` | `--log-junit storage/logs/gitnexus-junit.xml`                                  |
   | Pest                | `--log-junit storage/logs/gitnexus-junit.xml`                                  |
   | Vitest              | `--reporter=default --reporter=junit --outputFile.junit=gitnexus-junit.xml`    |
   | Jest (`jest-junit`) | `--reporters=default --reporters=jest-junit`                                   |
   | Playwright          | `--reporter=list,junit` with `PLAYWRIGHT_JUNIT_OUTPUT_NAME=gitnexus-junit.xml` |
   | pytest              | `--junitxml=gitnexus-junit.xml`                                                |

   Any writable, git-ignored path works; delete the file afterwards.

3. **After each command**, send its results — pass or fail, the report exists:

   ```
   node .gitnexus/run.cjs test-report --junit <report.xml>
   ```

   For a long selection, run it in a few batches (per folder or per runner) and
   report after each, so the graph fills in as the run advances instead of all
   at once at the end.

4. **When everything has run**: `node .gitnexus/run.cjs test-report --finish`.
   Files still amber after that did not run — say so in the report.

If the command exits non-zero before writing a report (a fatal error, a missing
service), there is nothing to send: finish the run and report the error text.
The live view never replaces the written report in section 5.

## 3. No changes → run what exists

Run the full suite with the project's command, then `test-gaps` for a one-line
coverage summary. If the project has no tests at all, say so and offer
`/testes gerar`.

## 4. Gerar — write the missing tests, area by area

```
node .gitnexus/run.cjs test-gaps [path...]
```

`areas` is ordered by risk (how much depends on the uncovered files). Work one
area per batch; the graph is the checkpoint, so a stopped run resumes by simply
running `test-gaps` again.

For each area:

1. **Context from the graph, not from reading everything.**
   `node .gitnexus/run.cjs path-impact <area>` gives the files that depend on it
   and what it uses (`depends_on`). Read the uncovered files and only the
   neighbours the graph names.
2. **Follow the project's conventions.** Read two or three existing tests of the
   same kind (same folder first) and copy their base class, factories, auth
   helpers, database traits and naming. Never introduce a second style.
3. **Pick the test type per file**, using what the project already has:
   - domain/service/model/helper code → unit test;
   - controller, route, form request, middleware, API endpoint → HTTP feature
     test hitting the route (use `route('name')` so the graph links it);
   - Livewire/Inertia/Blade screen → component or feature test asserting the
     rendered state and the actions;
   - `resources/js` and other frontend code → the project's JS unit runner;
   - full user journeys (screen → API → result) → browser E2E, **only** when
     Playwright/Dusk/Cypress is already set up.
     A missing runner (no JS unit runner, no E2E tool) is a setup decision: ask
     the user once before installing anything, and skip those files if declined.
4. **Assert behaviour, not implementation.** Cover the happy path, validation
   and authorization failures, and edge cases visible in the code. No
   assertion-free tests, no tests that only check a mock was called, no
   snapshot of whatever the code returns today.
5. **Run the batch** and classify each failure:
   - the test is wrong (bad setup, wrong expectation about a fixture) → fix the
     test;
   - the code is wrong (the test states the documented or obviously intended
     behaviour and the code violates it) → keep the test, mark it with the
     runner's "known failure / incomplete" mechanism with a one-line reason so
     the suite stays green, and record it in the report. Do not touch the
     production code and do not weaken the assertion to make it pass.
6. **Checkpoint.** `node .gitnexus/run.cjs analyze`, then `test-gaps` again:
   the area's `uncovered` count must have dropped. Files still listed with
   `linked: false` have no static links at all (config, pure templates, assets);
   leave them unless a real behaviour is worth testing.
7. Append to `.gitnexus/testes/relatorio.md`: date, area, tests added, coverage
   before → after, bugs found (file, test name, what is wrong).

Stop after a batch when the user asked for one area, when a batch needed a
setup decision, or when context is running low — report where it stopped and
that `/testes gerar` continues from there.

## 5. Report (every mode)

- Mode and repository (name, branch, index commit).
- What ran: command(s), tests selected vs. total, passed / failed / skipped.
- Why this selection: changed files and their coverage; `fallback_reasons` when
  the full suite ran.
- Tests written: files, what they cover.
- Bugs found in production code (not fixed).
- Remaining gap: `test-gaps` summary and the next area.

State failures with the runner's output. Never report a suite as passing when
part of it was skipped or could not start.
