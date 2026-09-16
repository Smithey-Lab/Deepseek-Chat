/* global window, document */
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'deepseek-agent-smoke-'),
  );
  const env = { ...process.env, DEEPSEEK_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop, page;
  const errors = [];
  const launch = async () => {
    desktop = await electron.launch({ args: ['.'], env });
    page = await desktop.firstWindow();
    page.setDefaultTimeout(12000);
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.waitForFunction(
      () => document.querySelectorAll('#chat-list button').length > 0,
    );
  };
  try {
    await launch();
    await desktop.evaluate(({ dialog, shell }) => {
      const sha = (c) => c.repeat(40);
      globalThis.agentSmoke = {
        allow: false,
        requests: [],
        patches: 0,
        modelStep: 0,
        urls: [],
        confirm: '',
      };
      dialog.showMessageBox = async (_window, options) => {
        globalThis.agentSmoke.confirm = options.detail;
        return { response: globalThis.agentSmoke.allow ? 1 : 0 };
      };
      shell.openExternal = async (url) => {
        globalThis.agentSmoke.urls.push(url);
      };
      globalThis.fetch = async (url, options = {}) => {
        const state = globalThis.agentSmoke;
        const p = new URL(url).pathname;
        state.requests.push({
          path: p,
          method: options.method,
          body: options.body,
        });
        let body;
        if (p === '/user/repos')
          body = [
            {
              full_name: 'Example/Project',
              owner: { login: 'Example' },
              default_branch: 'main',
            },
          ];
        else if (p === '/models') body = { data: [{ id: 'deepseek-chat' }] };
        else if (p.endsWith('/git/ref/heads/dev'))
          body = { object: { sha: sha('a') } };
        else if (p.endsWith('/git/commits/' + sha('a')))
          body = { tree: { sha: sha('b') } };
        else if (p.endsWith('/git/trees/' + sha('b')))
          body = {
            tree: [
              {
                path: 'README.md',
                type: 'blob',
                mode: '100644',
                sha: sha('c'),
                size: 3,
              },
            ],
          };
        else if (p.endsWith('/git/blobs/' + sha('c')))
          body = {
            encoding: 'base64',
            content: Buffer.from('old').toString('base64'),
          };
        else if (p === '/chat/completions') {
          if (state.hold) {
            state.waiting = true;
            await new Promise((_resolve, reject) =>
              options.signal.addEventListener(
                'abort',
                () => reject(new Error('Cancelled')),
                { once: true },
              ),
            );
          }
          const actions = [
            {
              action: 'write',
              path: 'README.md',
              content: 'Updated documentation',
            },
            {
              action: 'write',
              path: 'src/new.js',
              content: 'export const answer = 42;',
            },
            {
              action: 'finish',
              summary: 'Updated docs and added the new module.',
              taskResults: [
                {
                  task: 'Update docs',
                  status: 'done',
                  detail: 'README updated',
                },
                {
                  task: 'Add module',
                  status: 'done',
                  detail: 'src/new.js added',
                },
              ],
            },
          ];
          body = {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify(actions[state.modelStep++]),
                },
              },
            ],
            usage: { total_tokens: 10 },
          };
        } else if (p.endsWith('/git/blobs') && options.method === 'POST')
          body = { sha: sha('d') };
        else if (p.endsWith('/git/trees') && options.method === 'POST')
          body = { sha: sha('e') };
        else if (p.endsWith('/git/commits') && options.method === 'POST')
          body = { sha: sha('f') };
        else if (
          p.endsWith('/git/refs/heads/dev') &&
          options.method === 'PATCH'
        ) {
          state.patches++;
          body = { object: { sha: sha('f') } };
        } else throw new Error('Unexpected smoke request ' + p);
        return { ok: true, json: async () => body };
      };
    });
    await page.evaluate(() =>
      window.workspace.saveSettings({
        github: 'fixture-only',
        deepseek: 'fixture-only',
      }),
    );
    await page.locator('[data-view="agent"]').click();
    await page.locator('#agent-load-repos').click();
    await expect(page.locator('#agent-repo')).toHaveValue('Example/Project');
    await page.locator('#agent-tasks').fill('Update docs\nAdd module');
    await page.locator('#agent-start').click();
    await expect(page.locator('#agent-feedback')).toContainText('cancelled');
    assert.equal(
      await desktop.evaluate(() => globalThis.agentSmoke.modelStep),
      0,
    );
    assert.match(
      await desktop.evaluate(() => globalThis.agentSmoke.confirm),
      /Update docs\nAdd module/,
    );
    await desktop.evaluate(() => {
      globalThis.agentSmoke.allow = true;
    });
    await page.locator('#agent-start').click();
    await expect(
      page.locator('#agent-detail .agent-status').first(),
    ).toHaveText('completed');
    await expect(page.locator('#agent-detail')).toContainText(
      'Updated docs and added the new module.',
    );
    await expect(page.locator('#agent-detail .agent-change')).toHaveCount(2);
    await expect(page.locator('#agent-start')).toBeEnabled();
    await expect(page.locator('#agent-cancel')).toBeDisabled();
    const state = await desktop.evaluate(() => globalThis.agentSmoke);
    assert.equal(state.patches, 1);
    assert.equal(
      state.requests.some((r) => r.path.includes('/heads/main')),
      false,
    );
    const patch = state.requests.find((r) => r.method === 'PATCH');
    assert.equal(JSON.parse(patch.body).force, false);
    await page
      .locator('#agent-detail .agent-changes-section > summary')
      .click();
    await page.locator('#agent-detail .agent-change > summary').first().click();
    await fs.mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/agent-v03.png', fullPage: true });
    await desktop.evaluate(() => {
      globalThis.agentSmoke.hold = true;
    });
    await page.locator('#agent-start').click();
    await expect
      .poll(() => desktop.evaluate(() => !!globalThis.agentSmoke.waiting))
      .toBe(true);
    const minimized = await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.close();
      return !win.isDestroyed();
    });
    assert.equal(minimized, true);
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].restore(),
    );
    await page.locator('#agent-cancel').click();
    await expect(
      page.locator('#agent-detail .agent-status').first(),
    ).toHaveText('cancelled');
    assert.equal(
      await desktop.evaluate(() => globalThis.agentSmoke.patches),
      1,
    );
    await page
      .locator('#agent-history button')
      .filter({ hasText: 'completed' })
      .click();
    const closed = desktop.waitForEvent('close');
    await page.evaluate(() => window.close());
    await closed;
    desktop = null;
    await launch();
    await page.locator('[data-view="agent"]').click();
    await expect(page.locator('#agent-history')).toContainText(
      'Example/Project',
    );
    await page
      .locator('#agent-history button')
      .filter({ hasText: 'completed' })
      .click();
    await expect(page.locator('#agent-detail')).toContainText(
      'Updated docs and added the new module.',
    );
    await expect(page.locator('#agent-tasks')).toHaveValue(
      'Update docs\nAdd module',
    );
    assert.deepEqual(errors, []);
    console.log(
      'Agent desktop flow passed: authorization/cancel, task list, multi-file dev commit, report, restart persistence. Provider calls use fixtures.',
    );
  } finally {
    if (desktop) {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await desktop.close().catch(() => {});
    }
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith('deepseek-agent-smoke-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
