/* global window, document */
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-smoke-'));
  const env = { ...process.env, DEEPSEEK_TEST_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop, page;
  const errors = [];
  const launch = async () => {
    desktop = await electron.launch({ args: ['.'], env });
    page = await desktop.firstWindow();
    page.setDefaultTimeout(12000);
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
    page.on('pageerror', (e) => errors.push(e.message));
    await page
      .waitForFunction(
        () => document.querySelectorAll('#chat-list button').length > 0,
      )
      .catch(async (error) => {
        console.error(
          'Boot status:',
          await page.locator('#status').textContent(),
          errors,
        );
        throw error;
      });
  };
  const idle = () =>
    page.waitForFunction(() => !document.getElementById('code-view').inert);
  const click = async (id) => {
    await page.locator('#' + id).click();
    await idle();
  };
  try {
    await launch();
    assert.equal(
      await desktop.evaluate(({ app }) => app.getPath('userData')),
      directory,
    );
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    await desktop.evaluate(({ dialog, shell, app }) => {
      globalThis.smoke = {
        devCreated: false,
        requests: [],
        urls: [],
        confirmations: 0,
      };
      dialog.showMessageBox = async () => {
        globalThis.smoke.confirmations++;
        return { response: 1 };
      };
      dialog.showSaveDialog = async (_win, o) => ({
        canceled: false,
        filePath:
          app.getPath('userData') + '/export.' + o.filters[0].extensions[0],
      });
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [app.getPath('userData') + '/export.json'],
      });
      shell.openExternal = async (url) => {
        globalThis.smoke.urls.push(url);
      };
      globalThis.fetch = async (url, o = {}) => {
        const u = new URL(url),
          p = u.pathname;
        globalThis.smoke.requests.push({
          path: p,
          method: o.method || 'GET',
          body: o.body,
        });
        let body;
        const repo = (name, extra = {}) => ({
          full_name: name,
          owner: { login: name.split('/')[0] },
          description: 'Workspace ' + name,
          default_branch: 'main',
          permissions: { push: true },
          language: 'JavaScript',
          updated_at: '2026-09-01',
          ...extra,
        });
        if (p === '/models')
          body = { data: [{ id: 'deepseek-chat' }, { id: 'test-model' }] };
        else if (p === '/user') body = { login: 'Smithey-Lab' };
        else if (p === '/chat/completions')
          body = {
            choices: [
              {
                message: {
                  content:
                    'Safe text <script>unsafe()</script>\n```js\nconst answer = 42;\n```',
                },
              },
            ],
          };
        else if (p === '/user/repos')
          body =
            u.searchParams.get('page') === '2'
              ? [repo('Other/Extra')]
              : [
                  repo('Smithey-Lab/Deepseek-Chat'),
                  repo('Smithey-Lab/Private', { private: true }),
                  repo('Smithey-Lab/Archived', { archived: true }),
                  repo('Smithey-Lab/NoDev'),
                  ...Array.from({ length: 96 }, (_, i) =>
                    repo('Other/Repo' + i),
                  ),
                ];
        else if (p.endsWith('/branches'))
          body =
            p.includes('/NoDev/') && !globalThis.smoke.devCreated
              ? [{ name: 'main' }]
              : [{ name: 'main', protected: true }, { name: 'dev' }];
        else if (p.includes('/git/ref/heads/'))
          body = { object: { sha: 'a'.repeat(40) } };
        else if (p.endsWith('/git/refs')) {
          globalThis.smoke.devCreated = true;
          body = { ref: 'refs/heads/dev' };
        } else if (p.endsWith('/commits'))
          body = [
            {
              sha: 'a'.repeat(40),
              commit: {
                message: 'Initial fixture',
                author: { name: 'Test', date: '2026-09-01' },
              },
            },
          ];
        else if (p.includes('/compare/'))
          body = {
            ahead_by: 2,
            behind_by: 1,
            total_commits: 2,
            files: [
              {
                filename: 'hello.txt',
                status: 'modified',
                additions: 1,
                deletions: 1,
              },
            ],
          };
        else if (p.endsWith('/pulls'))
          body = [
            {
              number: 7,
              title: 'Review fixture',
              state: 'open',
              draft: true,
              url: 'https://github.com/ignored',
            },
          ];
        else if (p.includes('/contents')) {
          if (o.method === 'PUT')
            body = {
              content: { sha: 'b'.repeat(40) },
              commit: {
                html_url:
                  'https://github.com/Smithey-Lab/Deepseek-Chat/commit/test',
              },
            };
          else if (p.endsWith('/hello.txt')) {
            await globalThis.readGate;
            body = {
              type: 'file',
              path: 'hello.txt',
              encoding: 'base64',
              size: 6,
              sha: 'a'.repeat(40),
              content: Buffer.from('Hello\n').toString('base64'),
            };
          } else
            body = [
              { type: 'dir', name: 'src', path: 'src', size: 0 },
              { type: 'file', name: 'hello.txt', path: 'hello.txt', size: 6 },
            ];
        } else throw Error('Unexpected fixture endpoint ' + url);
        return { ok: true, status: 200, json: async () => body };
      };
    });
    await page.locator('[data-view="settings"]').click();
    await page.locator('#deepseek-key').fill('smoke-deepseek-key');
    await page.locator('#github-token').fill('smoke-github-key');
    await page
      .getByRole('button', { name: 'Save connections', exact: true })
      .click();
    await expect(page.locator('#connection-status')).toHaveText(
      'DeepSeek: saved · GitHub: saved',
    );
    assert.ok(
      !(
        await fs.readFile(path.join(directory, 'credentials.json'), 'utf8')
      ).includes('smoke-'),
    );
    await click('test-github');
    await expect(page.locator('#status')).toContainText('GitHub connection OK');
    await click('test-deepseek');
    await expect(page.locator('#setup-3')).toBeChecked();
    await expect(page.locator('#download-update')).toBeDisabled();
    await expect(page.locator('#install-update')).toBeDisabled();
    await click('diagnostics');
    await expect(page.locator('#diagnostics-out')).toContainText('packaged');
    await page.locator('[data-view="code"]').click();
    await click('load-repos');
    await expect(page.locator('#repo option')).toHaveCount(100);
    await click('load-more-repos');
    await expect(page.locator('#repo option')).toHaveCount(101);
    await page.locator('#repo-filter').fill('Private');
    await expect(page.locator('#repo option')).toHaveCount(2);
    await page.locator('#repo-filter').fill('');
    await page.locator('#visibility-filter').selectOption('private');
    await expect(page.locator('#repo option')).toHaveCount(2);
    await page.locator('#visibility-filter').selectOption('');
    await page.locator('#owner-filter').selectOption('Smithey-Lab');
    await expect(page.locator('#repo option')).toHaveCount(4);
    await page.locator('#hide-archived').uncheck();
    await expect(page.locator('#repo option')).toHaveCount(5);
    await page.locator('#hide-archived').check();
    await page.locator('#repo').selectOption('Smithey-Lab/Deepseek-Chat');
    await idle();
    await expect(page.locator('#branch')).toHaveValue('dev');
    await click('favorite-repo');
    await expect(page.locator('#favorite-list')).toContainText('Deepseek-Chat');
    await click('browse');
    await expect(page.locator('#files')).toContainText('6 B');
    await desktop.evaluate(() => {
      globalThis.readGate = new Promise((resolve) => {
        globalThis.releaseRead = resolve;
      });
    });
    await page
      .locator('#files button')
      .filter({ hasText: 'hello.txt' })
      .click();
    await page.waitForFunction(
      () => document.getElementById('code-view').inert,
    );
    await desktop.evaluate(() => globalThis.releaseRead());
    await idle();
    await expect(page.locator('#editor')).toHaveValue('Hello\n');
    await page.locator('#editor').fill('Hello revised\n');
    await expect(page.locator('#dirty-indicator')).toHaveText('Dirty');
    await click('commit');
    await expect(page.locator('#status')).toContainText('Review changes');
    await click('review');
    await expect(page.locator('#after')).toContainText('Hello revised');
    await page.locator('#commit-message').fill('test: fixture edit');
    await click('commit');
    await expect(page.locator('#status')).toContainText(
      'Committed to Smithey-Lab/Deepseek-Chat:dev',
    );
    const writes = await desktop.evaluate(() =>
      globalThis.smoke.requests.filter((r) => r.method === 'PUT'),
    );
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].body).branch, 'dev');
    assert.match(
      await page.evaluate(async () => {
        try {
          await window.workspace.commit({ branch: 'main' });
        } catch (e) {
          return e.message;
        }
      }),
      /restricted to the dev branch/,
    );
    await click('load-commits');
    await expect(page.locator('#commit-list')).toContainText('Initial fixture');
    await click('load-compare');
    await expect(page.locator('#compare-box')).toContainText(
      'ahead 2, behind 1',
    );
    await click('load-pulls');
    await page.locator('#pulls-box button').click();
    assert.ok(
      (await desktop.evaluate(() => globalThis.smoke.urls)).includes(
        'https://github.com/Smithey-Lab/Deepseek-Chat/pull/7',
      ),
    );
    await page.locator('#branch').selectOption('main');
    await idle();
    await click('browse');
    await page
      .locator('#files button')
      .filter({ hasText: 'hello.txt' })
      .click();
    await idle();
    assert.equal(
      await page.locator('#editor').evaluate((e) => e.readOnly),
      true,
    );
    await expect(page.locator('#commit')).toBeDisabled();
    await page.locator('#repo').selectOption('Smithey-Lab/NoDev');
    await idle();
    await expect(page.locator('#branch')).toHaveValue('main');
    await click('create-dev');
    await expect(page.locator('#branch')).toHaveValue('dev');
    assert.equal(
      (
        await desktop.evaluate(() =>
          globalThis.smoke.requests.filter((r) => r.path.endsWith('/git/refs')),
        )
      ).length,
      1,
    );
    await page.locator('#repo').selectOption('Smithey-Lab/Deepseek-Chat');
    await idle();
    await click('browse');
    await page
      .locator('#files button')
      .filter({ hasText: 'hello.txt' })
      .click();
    await idle();
    await page.locator('#editor').fill('Persistent editor draft\n');
    await page.locator('#editor').press('Control+s');
    await expect(page.locator('#draft-status')).toContainText(
      'Draft saved locally',
    );
    await page.locator('[data-view="chat"]').click();
    await click('refresh-models');
    await page.locator('#model').selectOption('test-model');
    await page.locator('#prompt').fill('Hello test');
    await click('send');
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.assistant script')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Copy code', exact: true }),
    ).toHaveCount(1);
    await click('retry');
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.user')).toHaveCount(1);
    await click('rename-chat');
    await page.locator('#rename-input').fill('Pinned conversation');
    await page.locator('#rename-form button[type="submit"]').click();
    await click('pin-chat');
    await expect(page.locator('#chat-list')).toContainText(
      '★ Pinned conversation',
    );
    await click('archive-chat');
    await expect(page.locator('#chat-list button')).toHaveCount(0);
    await page.locator('#show-archived').check();
    await expect(page.locator('#chat-list button')).toHaveCount(1);
    await click('archive-chat');
    await page.locator('#show-archived').uncheck();
    await page.locator('#chat-search').fill('no-match');
    await expect(page.locator('#chat-list button')).toHaveCount(0);
    await page.locator('#chat-search').fill('');
    await click('export-json');
    await expect(page.locator('#status')).toContainText('Exported');
    await click('export-md');
    await expect(page.locator('#status')).toContainText('export.md');
    const exported = JSON.parse(
      await fs.readFile(path.join(directory, 'export.json'), 'utf8'),
    );
    assert.equal(exported.schemaVersion, 1);
    assert.equal(exported.chat.messages.length, 2);
    assert.match(
      await fs.readFile(path.join(directory, 'export.md'), 'utf8'),
      /Pinned conversation/,
    );
    await click('import-chat');
    await expect(page.locator('#chat-list button')).toHaveCount(2);
    await page.locator('#prompt').fill('Keep this conversation draft');
    await click('new-chat');
    await page.locator('#prompt').fill('Separate draft');
    await page
      .locator('#chat-list button')
      .filter({ hasText: 'Pinned conversation' })
      .first()
      .click();
    await expect(page.locator('#prompt')).toHaveValue(
      'Keep this conversation draft',
    );
    await click('toggle-theme');
    await click('toggle-density');
    await page.locator('[data-view="code"]').click();
    await fs.mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/desktop-v02.png' });
    const closed = desktop.waitForEvent('close', { timeout: 15000 });
    await page.evaluate(() => window.close());
    await closed;
    desktop = null;
    await launch();
    await expect(page.locator('#editor')).toHaveValue(
      'Persistent editor draft\n',
    );
    await expect(page.locator('body')).toHaveClass(/light/);
    await expect(page.locator('body')).toHaveClass(/compact/);
    await expect(page.locator('#favorite-list')).toContainText('Deepseek-Chat');
    await page.locator('[data-view="chat"]').click();
    await expect(page.locator('#prompt')).toHaveValue(
      'Keep this conversation draft',
    );
    assert.deepEqual(errors, []);
    console.log(
      'Desktop integration passed: repository discovery/filters/pagination, branch reads and dev creation, review/commit, history/PRs, safe chat/retry, organization, exports/import, draft/preferences persistence.',
    );
  } catch (error) {
    console.error(
      'Failure status:',
      await page
        .locator('#status')
        .textContent()
        .catch(() => ''),
      errors,
    );
    throw error;
  } finally {
    if (desktop) {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await desktop.close().catch(() => {});
    }
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('deepseek-smoke-'));
    await fs.rm(target, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
