import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

test('path-only scope, inapplicable content and unavailable processing remain visible', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Consumer adapter').selectOption('custom');
  const argv = [
    process.execPath,
    fileURLToPath(new URL('../fixtures/adapter.mjs', import.meta.url)),
  ];
  await page
    .getByLabel('Adapter command · JSON argv')
    .fill(JSON.stringify([...argv, 'paths-frozen']));
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('burst');
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.getByRole('status')).toHaveText('UNSUPPORTED');
  await expect(page.locator('.scope-note')).toContainText(
    'paths and types only; file content is not checked',
  );
  await expect(page.locator('.scope-note')).toContainText('NOT APPLICABLE: 20 overwrites');
  const href = await page.getByRole('link', { name: 'Result JSON' }).getAttribute('href');
  if (!href) throw new Error('Missing export');
  const result = await (await page.request.get(href)).json();
  expect(result.projection.hash).toBe('none');
  expect(result.assertions[0].checked).toBe(false);
  await page
    .getByLabel('Adapter command · JSON argv')
    .fill(JSON.stringify([...argv, 'unavailable']));
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('delete');
  await page.getByLabel('Observation window in milliseconds').fill('100');
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.getByRole('status')).toHaveText('INCONCLUSIVE');
  await expect(page.getByText(/MS · REVISION UNAVAILABLE · PROCESSING UNAVAILABLE/)).toBeVisible();
  await expect(page.locator('.scope-note')).toContainText(
    'cannot establish idle convergence or PASS',
  );
});

test('configure, run, inspect notifications, export and open offline report', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Does your index/ })).toBeVisible();
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.getByRole('status')).toHaveText('PASS', { timeout: 15000 });
  await expect(page.getByText('The checked states match.')).toBeVisible();
  await expect(page.locator('.run-meta')).toContainText('Tree cleaned up');
  await page.getByLabel('Timeline filter').selectOption('event');
  await expect(page.locator('.timeline li').first()).toContainText('notification');
  const resultHref = await page.getByRole('link', { name: 'Result JSON' }).getAttribute('href');
  if (!resultHref) throw new Error('Missing result export link');
  const exported = await page.request.get(resultHref);
  const result = await exported.json();
  expect(result.status).toBe('pass');
  expect(result.cleaned).toBe(true);
  const scenario = await (
    await page.request.get(`/api/export/scenario.json?runId=${result.id}`)
  ).json();
  expect(scenario.id).toBe('atomic-save');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'HTML report' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('watchconverge-report.html');
  const directory = await mkdtemp(join(tmpdir(), 'watchconverge-report-test-'));
  const report = await context.newPage();
  const remote: string[] = [];
  try {
    const path = join(directory, download.suggestedFilename());
    await download.saveAs(path);
    report.on('request', (req) => {
      if (/^https?:/.test(req.url())) remote.push(req.url());
    });
    await report.goto(pathToFileURL(path).href);
    await expect(report.getByRole('heading', { level: 1 })).toContainText('PASS');
    await expect(report.getByText('Complete result JSON')).toBeVisible();
    expect(remote).toEqual([]);
  } finally {
    await report.close();
    await rm(directory, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});
test('invalid scenario imports show an error and preserve the previous valid scenario', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const valid = {
    version: 1,
    id: 'imported',
    name: 'Imported scenario',
    description: 'Проверка импорта',
    initial: [{ path: 'файл.txt', content: 'Я' }],
    steps: [{ name: 'Existing state', operations: [] }],
  };
  await page.getByLabel('Import scenario', { exact: true }).setInputFiles({
    name: 'scenario.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(valid)),
  });
  await expect(page.getByRole('combobox', { name: 'Scenario', exact: true })).toHaveValue(
    'imported',
  );
  for (const invalid of [
    { version: 1, name: 'broken', steps: [null] },
    { ...valid, steps: [null] },
    { ...valid, initial: [{ path: '../outside', content: 'x' }] },
  ]) {
    await page.getByLabel('Import scenario', { exact: true }).setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(invalid)),
    });
    await expect(page.getByRole('alert')).toContainText('Import failed');
    await expect(page.getByRole('heading', { name: /Does your index/ })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Scenario', exact: true })).toHaveValue(
      'imported',
    );
  }
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.getByRole('status')).toHaveText('PASS', { timeout: 10000 });
  expect(errors).toEqual([]);
});
test('a stale tab keeps its export bound to the displayed result', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.getByRole('status')).toHaveText('PASS', { timeout: 10000 });
  const first = await (await page.request.get('/api/run')).json();
  await page.route('**/api/run', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: first }) : route.continue(),
  );
  const second = await context.request.post('/api/run', {
    headers: { 'X-WatchConverge': '1' },
    data: { scenario: 'delete', adapter: 'fixed' },
  });
  expect(second.status()).toBe(202);
  await expect
    .poll(async () => {
      const state = await (await context.request.get('/api/run')).json();
      return Boolean(state.result && state.result.id !== first.result.id);
    })
    .toBe(true);
  await expect(page.locator('.run-meta')).toContainText('Atomic save, then write');
  for (const label of ['Scenario JSON', 'Result JSON', 'HTML report']) {
    const href = await page.getByRole('link', { name: label }).getAttribute('href');
    if (!href) throw new Error('Missing export link');
    expect(new URL(href, 'http://127.0.0.1:4318').searchParams.get('runId')).toBe(first.result.id);
    expect((await context.request.get(href)).status()).toBe(409);
  }
});
test('broken adapter shows actual disk/index mismatch, never a synthetic event loss claim', async ({
  page,
}) => {
  test.skip(process.platform === 'win32', 'UNSUPPORTED inode demonstration on Windows, not PASS');
  await page.goto('/');
  await page.getByLabel('Consumer adapter').selectOption('broken');
  await page.getByLabel('Observation window in milliseconds').fill('300');
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.getByRole('status')).toHaveText('DIVERGED', { timeout: 15000 });
  await expect(page.getByText('content mismatch', { exact: true })).toBeVisible();
  await expect(page.getByTestId('disk-app.txt').locator('code')).not.toHaveText(
    (await page.getByTestId('index-app.txt').locator('code').textContent()) ?? '',
  );
});
test('custom trusted command error, stop, origin guard and responsive themes', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Consumer adapter').selectOption('custom');
  await page.getByLabel('Adapter command · JSON argv').fill('["watchconverge-no-such-command"]');
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.getByRole('status')).toHaveText('ERROR', { timeout: 10000 });
  await expect(page.getByText('Convergence is unconfirmed.')).toBeVisible();
  const denied = await page.request.post('/api/run', {
    headers: { Origin: 'http://evil.example' },
    data: { scenario: 'atomic-save' },
  });
  expect(denied.status()).toBe(403);
  await page
    .getByLabel('Adapter command · JSON argv')
    .fill(JSON.stringify([process.execPath, '-e', 'setInterval(()=>{},1000)']));
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('STOPPED', { timeout: 10000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Theme', { exact: true }).selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
