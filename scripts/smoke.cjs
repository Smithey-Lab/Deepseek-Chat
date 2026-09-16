/* global window, document */
const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-smoke-'));
  const env = { ...process.env, DEEPSEEK_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({ args: ['.'], env });
  let desktop;
  try {
    desktop = await launch();
    let page = await desktop.firstWindow();
    await page.getByText('A little curiosity. A lot of possibility.').waitFor();
    assert.equal(
      await desktop.evaluate(({ app }) => app.getPath('userData')),
      directory,
    );
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    await page.locator('[data-view="settings"]').click();
    await page.locator('#deepseek-key').fill('smoke-deepseek-key');
    await page.locator('#github-token').fill('smoke-github-key');
    await page.getByRole('button', { name: 'Save connections' }).click();
    await page
      .getByText('DeepSeek: saved · GitHub: saved', { exact: true })
      .waitFor();
    const stored = await fs.readFile(
      path.join(directory, 'credentials.json'),
      'utf8',
    );
    assert.ok(
      !stored.includes('smoke-deepseek-key') &&
        !stored.includes('smoke-github-key'),
    );
    const initialSettings = await page.evaluate(() =>
      window.workspace.settings(),
    );
    assert.ok(initialSettings.deepseek && initialSettings.github);
    await desktop.evaluate(() => {
      globalThis.fetch = async (url, options) => {
        let body;
        if (url.endsWith('/models')) body = { data: [{ id: 'test-model' }] };
        else if (url.endsWith('/chat/completions'))
          body = {
            choices: [
              {
                message: {
                  content: 'Test response: <script>unsafe()</script>',
                },
              },
            ],
          };
        else if (options.method === 'PUT')
          body = {
            content: { sha: 'b'.repeat(40) },
            commit: { html_url: 'https://github.com/example/repo/commit/test' },
          };
        else if (url.includes('/contents/hello.txt'))
          body = {
            type: 'file',
            path: 'hello.txt',
            encoding: 'base64',
            size: 5,
            sha: 'a'.repeat(40),
            content: Buffer.from('Hello').toString('base64'),
          };
        else
          body = [
            { name: 'hello.txt', path: 'hello.txt', type: 'file', size: 5 },
          ];
        return { ok: true, json: async () => body };
      };
    });
    await page.locator('[data-view="chat"]').click();
    await page.getByRole('button', { name: 'Refresh models' }).click();
    await page
      .locator('#model option[value="test-model"]')
      .waitFor({ state: 'attached' });
    await page.locator('#prompt').fill('Hello smoke test');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.locator('.message.assistant').waitFor();
    assert.equal(await page.locator('.message.assistant script').count(), 0);
    await page.locator('[data-view="code"]').click();
    await page.getByRole('button', { name: 'Open repository' }).click();
    await page
      .getByRole('button', { name: '· hello.txt', exact: true })
      .click();
    await page.waitForFunction(
      () => document.getElementById('editor').value === 'Hello',
    );
    await page.locator('#editor').fill('Hello updated');
    await page.locator('#commit-message').fill('test: update hello');
    await page
      .getByRole('button', { name: 'Commit reviewed changes to dev' })
      .click();
    await page
      .getByText('Click Review changes after your latest edits.', {
        exact: true,
      })
      .waitFor();
    await page
      .getByRole('button', { name: 'Review changes', exact: true })
      .click();
    assert.equal(await page.locator('#before').textContent(), 'Hello');
    assert.equal(await page.locator('#after').textContent(), 'Hello updated');
    await desktop.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    await page
      .getByRole('button', { name: 'Commit reviewed changes to dev' })
      .click();
    await page
      .getByText(
        'Committed to Smithey-Lab/Deepseek-Chat:dev. Open a dev → main pull request for Codex review.',
        { exact: true },
      )
      .waitFor();
    const rejection = await page.evaluate(async () => {
      try {
        await window.workspace.commit({ branch: 'main' });
        return '';
      } catch (error) {
        return error.message;
      }
    });
    assert.match(rejection, /restricted to the dev branch/);
    await page.locator('[data-view="chat"]').click();
    await fs.mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/desktop-smoke.png' });
    await desktop.close();
    desktop = await launch();
    page = await desktop.firstWindow();
    await page.locator('.message.assistant').waitFor();
    assert.match(
      await page.locator('.message.assistant').textContent(),
      /Test response/,
    );
    const settings = await page.evaluate(() => window.workspace.settings());
    assert.ok(settings.deepseek && settings.github);
    console.log(
      'Desktop smoke passed: sandbox, encrypted credentials, models, chat, history persistence, repository editing, review gate, dev-only commit.',
    );
  } finally {
    if (desktop) await desktop.close();
    const target = path.resolve(directory);
    assert.equal(
      path.dirname(target),
      path.resolve(os.tmpdir()),
      'Invalid test cleanup parent.',
    );
    assert.ok(
      path.basename(target).startsWith('deepseek-smoke-'),
      'Invalid test cleanup path.',
    );
    await fs.rm(target, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
