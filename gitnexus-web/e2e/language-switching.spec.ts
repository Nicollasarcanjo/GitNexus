import { test, expect, type Page } from '@playwright/test';

const BACKEND_URL = 'http://localhost:4747';
const REPO_NAME = 'mock-repo';

async function mockBackend(page: Page) {
  const repo = {
    name: REPO_NAME,
    path: '/tmp/mock-repo',
    repoPath: '/tmp/mock-repo',
    indexedAt: new Date().toISOString(),
    stats: { files: 1, nodes: 0, edges: 0, processes: 0 },
  };

  await page.route(
    (url) => url.origin === BACKEND_URL && url.pathname === '/api/repos',
    (route) => route.fulfill({ json: [repo] }),
  );
  await page.route(
    (url) => url.origin === BACKEND_URL && url.pathname === '/api/repo',
    (route) => route.fulfill({ json: repo }),
  );
  await page.route(
    (url) => url.origin === BACKEND_URL && url.pathname === '/api/graph',
    (route) => route.fulfill({ json: { nodes: [], relationships: [] } }),
  );
  await page.route(
    (url) => url.origin === BACKEND_URL && url.pathname === '/api/heartbeat',
    (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: ':ok\n\n',
      }),
  );
}

async function enterExploringView(page: Page) {
  await page.goto('/');
  await page.locator('[data-testid="landing-repo-card"]').first().click();
  await expect(page.getByTestId('language-switcher')).toBeVisible({ timeout: 20_000 });
}

test.describe('language switching', () => {
  test('switches Header language, updates document metadata, and persists after reload', async ({
    page,
  }) => {
    await mockBackend(page);
    await page.goto('/');
    await page.evaluate(() => window.localStorage.setItem('gitnexus.lng', 'en'));

    await enterExploringView(page);

    await page.getByTestId('language-switcher').selectOption('pt-BR');

    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(page.getByPlaceholder('Buscar nós...')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('gitnexus.lng')))
      .toBe('pt-BR');

    await page.reload();

    await expect(page.getByTestId('language-switcher')).toHaveValue('pt-BR', { timeout: 20_000 });
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(page.getByPlaceholder('Buscar nós...')).toBeVisible();

    await page.getByTestId('language-switcher').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
