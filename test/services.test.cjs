'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { registerServices } = require('../src/services.cjs');

function makeHarness(overrides) {
  const calls = { handle: {}, request: [] };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const state = {};
  const deps = {
    handle: (ch, fn) => {
      calls.handle[ch] = fn;
    },
    request: async (service, endpoint, opts) => {
      calls.request.push({ service, endpoint, opts });
      return {};
    },
    readJson: async (name, fallback) => {
      const p = path.join(userData, name);
      if (!fs.existsSync(p)) return fallback;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    },
    atomicWrite: async (name, data) => {
      calls.lastWrite = { name, data };
      fs.writeFileSync(path.join(userData, name), data, 'utf8');
    },
    getWindow: () => ({}),
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true }),
    },
    shell: { openPath: async () => '', openExternal: async () => {} },
    app: {
      getPath: () => userData,
      getVersion: () => '1.2.3',
      isPackaged: false,
    },
  };
  Object.assign(deps, overrides || {});
  registerServices(deps);
  const names = {
    repos: 'github:repos',
    branches: 'github:branches',
    createDev: 'github:createDev',
    commits: 'github:commits',
    compare: 'github:compare',
    pulls: 'github:pulls',
    openGithub: 'github:open',
    test: 'connection:test',
    loadWorkspace: 'workspace:load',
    saveWorkspace: 'workspace:save',
    exportChat: 'chat:export',
    importChat: 'chat:import',
    diagnostics: 'app:diagnostics',
    openDataFolder: 'app:openDataFolder',
  };
  const api = Object.fromEntries(
    Object.entries(names).map(([name, channel]) => [
      name,
      calls.handle[channel],
    ]),
  );
  return { calls, api, deps, userData, state };
}

test('repos request uses relative endpoint', async () => {
  const h = makeHarness({
    request: async (service, endpoint, opts) => {
      h.calls.request.push({ service, endpoint, opts });
      return [];
    },
  });
  await h.api.repos({ page: 2 });
  const last = h.calls.request[h.calls.request.length - 1];
  assert.equal(last.service, 'github');
  assert.equal(last.endpoint.startsWith('/user/repos'), true);
  assert.equal(last.endpoint.includes('page=2'), true);
  assert.equal(last.endpoint.includes('http'), false);
});

test('createDev posts JSON string body and returns cancelled on cancel', async () => {
  const h = makeHarness({
    request: async (service, endpoint, opts) => {
      h.calls.request.push({ service, endpoint, opts });
      if (endpoint.includes('git/ref/heads'))
        return { object: { sha: 'a'.repeat(40) } };
      return {};
    },
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true }),
    },
  });
  const r = await h.api.createDev({ repo: 'a/b', source: 'main' });
  assert.deepEqual(r, { created: true });
  const post = h.calls.request.find((c) => c.opts && c.opts.method === 'POST');
  assert.ok(post, 'post made');
  assert.equal(post.endpoint, '/repos/a/b/git/refs');
  assert.equal(typeof post.opts.body, 'string');
  assert.deepEqual(JSON.parse(post.opts.body), {
    ref: 'refs/heads/dev',
    sha: 'a'.repeat(40),
  });
  const c = makeHarness({
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true }),
    },
  });
  const r2 = await c.api.createDev({ repo: 'a/b', source: 'main' });
  assert.deepEqual(r2, { cancelled: true });
  assert.equal(c.calls.request.length, 0);
});

test('extended createDev uses POST not PATCH', async () => {
  const h = makeHarness({
    request: async (service, endpoint, opts) => {
      h.calls.request.push({ service, endpoint, opts });
      if (endpoint.includes('git/ref/heads'))
        return { object: { sha: 'b'.repeat(40) } };
      return {};
    },
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true }),
    },
  });
  await h.api.createDev({ repo: 'a/b', source: 'main' });
  for (const c of h.calls.request)
    assert.notEqual(c.opts && c.opts.method, 'PATCH');
});

test('workspace save uses basename workspace.json and readJson', async () => {
  const h = makeHarness();
  await h.api.saveWorkspace({
    preferences: { theme: 'dark' },
    drafts: {},
    activity: [],
  });
  assert.equal(h.calls.lastWrite.name, 'workspace.json');
  const loaded = await h.api.loadWorkspace();
  assert.deepEqual(loaded.preferences.theme, 'dark');
});

test('workspace 2 MB limit enforced', async () => {
  const h = makeHarness();
  await assert.rejects(() =>
    h.api.saveWorkspace({
      preferences: { big: 'x'.repeat(2 * 1024 * 1024 + 10) },
      drafts: {},
      activity: [],
    }),
  );
});

test('workspace preserves preferences and validates drafts strictly, no prototype pollution', async () => {
  const h = makeHarness();
  await assert.rejects(() =>
    h.api.saveWorkspace({
      preferences: { ['__proto__']: 'bad' },
      drafts: {},
      activity: [],
    }),
  );
  const payload = {
    preferences: { theme: 'light', nested: { a: 1, b: [1, 2, 3] } },
    drafts: {
      k1: {
        repo: 'a/b',
        path: 'src/x.js',
        ref: 'dev',
        sha: 'c'.repeat(40),
        content: 'hello',
        original: 'old',
      },
    },
    activity: [{ time: 1234, message: 'ok' }],
  };
  await h.api.saveWorkspace(payload);
  const loaded = await h.api.loadWorkspace();
  assert.equal(loaded.drafts.k1.repo, 'a/b');
  assert.equal(loaded.drafts.k1.path, 'src/x.js');
  assert.equal(loaded.drafts.k1.ref, 'dev');
  assert.equal(loaded.drafts.k1.sha, 'c'.repeat(40));
  assert.equal(loaded.drafts.k1.content, 'hello');
  assert.equal(loaded.drafts.k1.original, 'old');
  assert.equal(loaded.preferences.nested.b[1], 2);
  assert.equal(loaded.activity[0].time, 1234);
});

test('draft invalid sha rejected', async () => {
  const h = makeHarness();
  await assert.rejects(() =>
    h.api.saveWorkspace({
      preferences: {},
      drafts: {
        k: { repo: 'a/b', path: 'src/x.js', sha: 'not a sha', content: 'x' },
      },
      activity: [],
    }),
  );
});

test('loadWorkspace preserves corruption errors', async () => {
  const h = makeHarness({
    readJson: async () => {
      throw new Error('Corrupt file');
    },
  });
  await assert.rejects(() => h.api.loadWorkspace(), /Corrupt file/);
});

test('compare truncates at 300 files', async () => {
  const files = Array.from({ length: 300 }, (_, i) => ({
    filename: `f${i}`,
    status: 'modified',
    additions: 1,
    deletions: 1,
  }));
  const h = makeHarness({
    request: async (service, endpoint, opts) => {
      h.calls.request.push({ service, endpoint, opts });
      return { files, ahead_by: 2, behind_by: 1, total_commits: 1 };
    },
  });
  const out = await h.api.compare({ repo: 'a/b', base: 'main' });
  assert.equal(out.truncated, true);
  assert.equal(out.files.length, 300);
  assert.equal(h.calls.request[0].endpoint, '/repos/a/b/compare/main...dev');
});

test('openGithub builds pull URL and rejects invalid number', async () => {
  const opened = [];
  const h = makeHarness({
    shell: {
      openExternal: async (u) => opened.push(u),
      openPath: async () => '',
    },
  });
  await h.api.openGithub({ repo: 'a/b', kind: 'pulls', number: 42 });
  assert.equal(opened[0], 'https://github.com/a/b/pull/42');
  await assert.rejects(() =>
    h.api.openGithub({ repo: 'a/b', kind: 'pulls', number: -1 }),
  );
  await h.api.openGithub({ repo: 'a/b', kind: 'compare', base: 'release/v1' });
  assert.equal(
    opened[opened.length - 1],
    'https://github.com/a/b/compare/release%2Fv1...dev',
  );
  await assert.rejects(() =>
    h.api.openGithub({ repo: 'a/b', kind: 'file', path: '../etc/passwd' }),
  );
});

test('openDataFolder surfaces shell errors', async () => {
  const h = makeHarness({
    shell: { openPath: async () => 'denied', openExternal: async () => {} },
  });
  await assert.rejects(() => h.api.openDataFolder(), /denied/);
  const ok = makeHarness({
    shell: { openPath: async () => '', openExternal: async () => {} },
  });
  assert.deepEqual(await ok.api.openDataFolder(), { opened: true });
});

test('exportChat json schema writes file and rejects system role', async () => {
  const filePath = path.join(os.tmpdir(), 'out-' + Date.now() + '.json');
  const h = makeHarness({
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath }),
      showMessageBox: async () => ({ response: 0 }),
      showOpenDialog: async () => ({ canceled: true }),
    },
  });
  const r = await h.api.exportChat({
    format: 'json',
    chat: {
      id: 'c1',
      title: 'Hello',
      created: 1,
      updated: 2,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      pinned: true,
      archived: false,
    },
  });
  assert.equal(r.path, filePath);
  const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(written.schemaVersion, 1);
  assert.equal(written.chat.pinned, true);
  assert.equal(written.chat.archived, false);
  assert.equal(written.chat.created, 1);
  assert.equal(written.chat.updated, 2);
  await assert.rejects(() =>
    h.api.exportChat({
      format: 'json',
      chat: {
        title: 'x',
        model: 'm',
        messages: [{ role: 'system', content: 'x' }],
      },
    }),
  );
});

test('importChat rejects system role and schemaVersion != 1, regenerates ids', async () => {
  const good = JSON.stringify({
    schemaVersion: 1,
    chat: {
      title: 'ok',
      model: 'm',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    },
  });
  const bad = JSON.stringify({
    schemaVersion: 2,
    chat: {
      title: 'ok',
      model: 'm',
      messages: [{ role: 'user', content: 'a' }],
    },
  });
  const sys = JSON.stringify({
    schemaVersion: 1,
    chat: {
      title: 'ok',
      model: 'm',
      messages: [{ role: 'system', content: 'a' }],
    },
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const goodP = path.join(tmp, 'good.json');
  fs.writeFileSync(goodP, good);
  const badP = path.join(tmp, 'bad.json');
  fs.writeFileSync(badP, bad);
  const sysP = path.join(tmp, 'sys.json');
  fs.writeFileSync(sysP, sys);
  const goodH = makeHarness({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [goodP] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
  });
  const r = await goodH.api.importChat();
  assert.notEqual(r.chat.id, undefined);
  assert.ok(/^[0-9a-f-]{36}$/.test(r.chat.id));
  for (const m of r.chat.messages) assert.ok(/^[0-9a-f-]{36}$/.test(m.id));
  const badH = makeHarness({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [badP] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
  });
  await assert.rejects(() => badH.api.importChat());
  const sysH = makeHarness({
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [sysP] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
  });
  await assert.rejects(() => sysH.api.importChat());
});

test('connection test uses relative endpoints', async () => {
  const h = makeHarness();
  await h.api.test({ service: 'github' });
  assert.equal(h.calls.request[0].endpoint, '/user');
  assert.equal(h.calls.request[0].service, 'github');
  await h.api.test({ service: 'deepseek' });
  assert.equal(h.calls.request[1].endpoint, '/models');
  assert.equal(h.calls.request[1].service, 'deepseek');
});

test('registry contains expected channels and no send/chatInput dependency', () => {
  const h = makeHarness();
  const channels = Object.keys(h.calls.handle);
  for (const c of [
    'github:repos',
    'github:branches',
    'github:createDev',
    'github:commits',
    'github:compare',
    'github:pulls',
    'github:open',
    'connection:test',
    'workspace:load',
    'workspace:save',
    'chat:export',
    'chat:import',
    'app:diagnostics',
    'app:openDataFolder',
  ]) {
    assert.ok(channels.includes(c), c);
  }
  assert.equal(channels.includes('chat:send'), false);
});
