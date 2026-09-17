'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgent, validateStart } = require('../src/agent.cjs');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const hex = (c) => c.repeat(40);

const BASE = hex('a'); // dev head
const COMMIT = BASE;
const BASE_TREE = hex('c');
const NEW_TREE = hex('d');
const NEW_COMMIT = hex('e');
const BLOB_SHA = hex('f');
const BLOB2_SHA = hex('1');
const NEW_BLOB_SHA = hex('2');

const encode = (s) => Buffer.from(s, 'utf8').toString('base64');

// A realistic pinned repo tree. Root AGENTS.md + nested.
function pinnedTree() {
  return {
    sha: BASE_TREE,
    truncated: false,
    tree: [
      {
        path: 'AGENTS.md',
        mode: '100644',
        type: 'blob',
        size: 12,
        sha: BLOB_SHA,
      },
      {
        path: 'README.md',
        mode: '100644',
        type: 'blob',
        size: 10,
        sha: BLOB2_SHA,
      },
      { path: 'src', mode: '040000', type: 'tree', sha: hex('9') },
      {
        path: 'src/index.js',
        mode: '100644',
        type: 'blob',
        size: 30,
        sha: hex('8'),
      },
      {
        path: 'src/AGENTS.md',
        mode: '100644',
        type: 'blob',
        size: 8,
        sha: hex('7'),
      },
      {
        path: 'bin/tool',
        mode: '100755',
        type: 'blob',
        size: 6,
        sha: hex('6'),
      },
      {
        path: 'logo.png',
        mode: '100644',
        type: 'blob',
        size: 40,
        sha: hex('5'),
      },
      { path: 'link', mode: '120000', type: 'blob', size: 12, sha: hex('4') },
    ],
  };
}

const BLOBS = {
  [BLOB_SHA]: encode('root agents\n'),
  [BLOB2_SHA]: encode('read me\n'),
  [hex('8')]: encode('module.exports = 1;\n'),
  [hex('7')]: encode('nested\n'),
  [hex('6')]: encode('#!/bin\n'),
  [hex('5')]: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString(
    'base64',
  ),
  [hex('4')]: encode('src/index.js'),
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Fake GitHub the source of truth. Records every request as
// [service, endpoint, options] to prove signature & single-ref PATCH.
function makeGitHub(state = {}) {
  const s = {
    refSha: BASE,
    commitSha: COMMIT,
    baseTree: BASE_TREE,
    tree: pinnedTree(),
    blobs: { ...BLOBS },
    ...state,
  };
  const accepted = [];
  const request = async (service, endpoint, options = {}) => {
    if (service !== 'github') throw new Error(`unexpected service ${service}`);
    accepted.push({ service, endpoint, options });
    const m = (re) => endpoint.match(re);
    let r;
    if (m(/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/dev$/)) {
      return { object: { sha: s.refSha } };
    }
    if ((r = m(/^\/repos\/[^/]+\/[^/]+\/git\/commits\/([a-f0-9]{40})$/))) {
      assert.equal(r[1], s.commitSha);
      return { sha: s.commitSha, tree: { sha: s.baseTree } };
    }
    if (m(/^\/repos\/[^/]+\/[^/]+\/git\/trees\/([a-f0-9]{40})\?recursive=1$/)) {
      return s.tree;
    }
    if ((r = m(/^\/repos\/[^/]+\/[^/]+\/git\/blobs\/([a-f0-9]{40})$/))) {
      const content = s.blobs[r[1]];
      if (content === undefined) throw new Error(`no blob ${r[1]}`);
      return { encoding: 'base64', content };
    }
    if (endpoint.endsWith('/git/blobs') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      const sha = NEW_BLOB_SHA; // fixed; asserts count POSTs
      s.blobs[sha] = encode(body.content);
      return { sha };
    }
    if (endpoint.endsWith('/git/trees') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.base_tree, s.baseTree);
      return { sha: NEW_TREE };
    }
    if (endpoint.endsWith('/git/commits') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.parents, [s.commitSha]);
      return { sha: NEW_COMMIT };
    }
    if (endpoint.endsWith('/git/refs/heads/dev')) {
      assert.equal(options.method, 'PATCH');
      const body = JSON.parse(options.body);
      assert.equal(body.force, false);
      s.refSha = body.sha;
      return { object: { sha: s.refSha } };
    }
    throw new Error(`unexpected github endpoint: ${endpoint}`);
  };
  return { request, state: s, accepted };
}

// Fake DeepSeek: returns a scripted sequence of JSON action objects.
// Each entry = the assistant content string or {content, finish_reason}.
function makeDeepSeek(script) {
  const calls = [];
  let i = 0;
  const request = async (service, endpoint, options) => {
    assert.equal(service, 'deepseek');
    assert.equal(endpoint, '/chat/completions');
    calls.push(JSON.parse(options.body));
    if (i >= script.length) throw new Error('deepseek script exhausted');
    const entry = script[i++];
    const content = typeof entry === 'string' ? entry : entry.content;
    const finish_reason =
      typeof entry === 'string' ? 'stop' : (entry.finish_reason ?? 'stop');
    return {
      choices: [{ finish_reason, message: { content } }],
      usage: { total_tokens: 3, prompt_tokens: 2, completion_tokens: 1 },
    };
  };
  return { request, calls, remaining: () => script.length - i };
}

function makeRequest(gh, ds) {
  const calls = [];
  const request = async (service, endpoint, options) => {
    calls.push({ service, endpoint, options });
    if (service === 'github') return gh.request(service, endpoint, options);
    if (service === 'deepseek') return ds.request(service, endpoint, options);
    throw new Error(`unexpected service ${service}`);
  };
  return { request, calls };
}

// In-memory atomicWrite. Stores snapshots and records notifications.
function makeStore(initial = {}) {
  const files = { ...initial };
  const notifications = [];
  const atomicWrite = async (name, content) => {
    files[name] = content;
  };
  const readJson = async (name, fallback) =>
    name in files ? JSON.parse(files[name]) : fallback;
  const notify = (payload) => notifications.push(payload);
  return { files, notifications, atomicWrite, readJson, notify };
}

const finishAction = (tasks, status = 'done') =>
  JSON.stringify({
    action: 'finish',
    summary: 'done',
    taskResults: tasks.map((t) => ({ task: t, status, detail: 'x' })),
  });

function makeAgent({ script, ghState, store, ds }) {
  const gh = makeGitHub(ghState);
  const deepseek = ds || makeDeepSeek(script);
  const st = store || makeStore();
  const agent = createAgent({
    request: makeRequest(gh, deepseek).request,
    readJson: st.readJson,
    atomicWrite: st.atomicWrite,
    notify: st.notify,
  });
  return { agent, gh, deepseek, store: st };
}

// Await completion without depending on internal timers.
async function settled(agent) {
  for (let i = 0; i < 5000; i++) {
    if (!agent.isRunning()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('agent did not settle');
}

// Poll a predicate on setImmediate, bounded.
async function until(pred, label = 'condition') {
  for (let i = 0; i < 5000; i++) {
    if (pred()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Read all `github`-service endpoints from recorded request calls.

// ---------------------------------------------------------------------------
// validateStart
// ---------------------------------------------------------------------------

test('validateStart rejects main branch, bad paths, bad tasks, bad steps', () => {
  assert.throws(
    () =>
      validateStart({ repo: 'a/b', branch: 'main', tasks: 'x', model: 'm' }),
    /dev/,
  );
  assert.throws(
    () => validateStart({ repo: 'a/b', tasks: '', model: 'm' }),
    /Task list/,
  );
  assert.throws(
    () =>
      validateStart({
        repo: 'a/b',
        tasks: Array.from({ length: 31 }, () => 't').join('\n'),
        model: 'm',
      }),
    /30 tasks/,
  );
  assert.throws(
    () =>
      validateStart({
        repo: 'a/b',
        tasks: 'a'.repeat(1001),
        model: 'm',
      }),
    /1000/,
  );
  assert.throws(
    () => validateStart({ repo: 'a/b', tasks: 'ok', model: 'm', maxSteps: 9 }),
    /10.80|10/,
  );
  assert.throws(
    () => validateStart({ repo: 'a/b', tasks: 'ok', model: 'm', maxSteps: 81 }),
    /10.80|10/,
  );
});

test('validateStart normalizes the task list', () => {
  const c = validateStart({
    repo: 'a/b',
    branch: 'dev',
    tasks: 'one\ntwo',
    model: 'm',
  });
  assert.equal(c.repo, 'a/b');
  assert.deepEqual(c.tasks, ['one', 'two']);
  assert.equal(c.maxSteps, 40);
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test('start resolves before finish; multi-file write/new/delete uses single ref PATCH force:false on dev', async () => {
  const { agent, gh, deepseek, store } = makeAgent({
    script: [
      // read the existing file + nested instructions
      JSON.stringify({
        action: 'read',
        paths: ['src/index.js', 'src/AGENTS.md', 'AGENTS.md', 'bin/tool'],
      }),
      // edit existing, add new, delete existing
      JSON.stringify({
        action: 'write',
        path: 'src/index.js',
        content: 'module.exports = 2;\n',
      }),
      JSON.stringify({ action: 'write', path: 'src/new.js', content: 'new\n' }),
      JSON.stringify({ action: 'delete', path: 'bin/tool' }),
      finishAction(['x']),
    ],
  });

  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });

  // start resolves with a clone while the run is still active.
  assert.equal(started.status, 'running');
  assert.equal(agent.isRunning(), true);
  // returned object must be a snapshot, not live state.
  const snap = JSON.stringify(started);
  await settled(agent);
  const done = agent.get({ id: started.id });

  // same-file rewrite preserves original? original is preserved before change
  // and mode preserved on the new tree entry.
  const endpoints = gh.accepted; // every request hit the fake
  assert.ok(endpoints.length > 0);
  const patches = endpoints.filter((r) => r.options?.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.ok(patches[0].endpoint.endsWith('/git/refs/heads/dev'));
  assert.equal(JSON.parse(patches[0].options.body).force, false);
  // ref update targeted the new commit on dev, not main.
  assert.ok(!patches.some((p) => p.endpoint.includes('/main')));

  assert.equal(done.status, 'completed');
  assert.equal(done.commitSha, NEW_COMMIT);
  assert.equal(deepseek.remaining(), 0);
  assert.deepEqual(
    JSON.parse(store.files['agents.json']).find((r) => r.id === started.id)
      .taskResults,
    [{ task: 'x', status: 'done', detail: 'x' }],
  );
  assert.equal(JSON.stringify(started), snap);
});

test('new-tree entries preserve the original mode for rewritten files', async () => {
  const { agent, gh } = makeAgent({
    script: [
      JSON.stringify({ action: 'read', paths: ['bin/tool'] }),
      JSON.stringify({
        action: 'write',
        path: 'bin/tool',
        content: '#!/bin\n2\n',
      }),
      finishAction(['x']),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  await until(() =>
    gh.accepted.some(
      (r) => r.endpoint.endsWith('/git/trees') && r.options.method === 'POST',
    ),
  );
  assert.equal(agent.get({ id: started.id }).status, 'completed');
  const treeReq = gh.accepted.find(
    (r) => r.endpoint.endsWith('/git/trees') && r.options.method === 'POST',
  );
  const body = JSON.parse(treeReq.options.body);
  const entry = body.tree.find((e) => e.path === 'bin/tool');
  assert.equal(entry.mode, '100755');
  assert.equal(entry.type, 'blob');
});

test('no-op write (before === after) performs no commit and no ref PATCH', async () => {
  const { agent, gh } = makeAgent({
    script: [
      JSON.stringify({ action: 'read', paths: ['README.md'] }),
      JSON.stringify({
        action: 'write',
        path: 'README.md',
        content: 'read me\n',
      }),
      finishAction(['x']),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'completed');
  assert.equal(done.commitSha, null);
  assert.equal(
    gh.accepted.some(
      (r) => r.endpoint.endsWith('/git/commits') && r.options.method === 'POST',
    ),
    false,
  );
  assert.equal(
    gh.accepted.some((r) => r.endpoint.endsWith('/git/refs/heads/dev')),
    false,
  );
});

// ---------------------------------------------------------------------------
// Read/instruction guards
// ---------------------------------------------------------------------------

test('editing an existing file requires a prior read of it', async () => {
  const { agent } = makeAgent({
    script: [
      // only reads instructions, never the target file
      JSON.stringify({ action: 'read', paths: ['AGENTS.md', 'src/AGENTS.md'] }),
      JSON.stringify({ action: 'write', path: 'src/index.js', content: 'x\n' }),
      finishAction(['x']),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /Read the existing regular file/);
});

test('must-read: applicable nested AGENTS.md blocks otherwise-valid writes', async () => {
  const { agent } = makeAgent({
    script: [
      JSON.stringify({ action: 'read', paths: ['src/index.js'] }), // misses src/AGENTS.md
      JSON.stringify({ action: 'write', path: 'src/index.js', content: 'z\n' }),
      finishAction(['x']),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /AGENTS\.md/);
});

test('blocked task prevents any publication', async () => {
  const { agent, gh } = makeAgent({
    script: [
      JSON.stringify({ action: 'read', paths: ['README.md'] }),
      JSON.stringify({
        action: 'write',
        path: 'README.md',
        content: 'changed\n',
      }),
      finishAction(['x'], 'blocked'),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'blocked');
  assert.equal(
    gh.accepted.some((r) => r.endpoint.endsWith('/git/refs/heads/dev')),
    false,
  );
  assert.equal(
    gh.accepted.some(
      (r) => r.endpoint.endsWith('/git/trees') && r.options.method === 'POST',
    ),
    false,
  );
});

test('concurrent dev change prevents writes; no commit, no ref update', async () => {
  const { gh } = makeAgent({
    script: [
      JSON.stringify({ action: 'read', paths: ['README.md'] }),
      JSON.stringify({
        action: 'write',
        path: 'README.md',
        content: 'changed\n',
      }),
      finishAction(['x']),
    ],
  });
  // simulate an outside push landing between the read and the publish check
  const original = gh.request;
  let moved = false;
  const wrapped = async (s, e, o) => {
    const out = await original(s, e, o);
    if (!moved && /\/git\/ref\/heads\/dev$/.test(e)) {
      moved = true;
      gh.state.refSha = hex('9');
    }
    return out;
  };
  // rebind through a new agent harness wrapper
  const gh2 = { ...gh, request: wrapped };
  const ds = makeDeepSeek([
    JSON.stringify({ action: 'read', paths: ['README.md'] }),
    JSON.stringify({
      action: 'write',
      path: 'README.md',
      content: 'changed\n',
    }),
    finishAction(['x']),
  ]);
  const store = makeStore();
  const agent2 = createAgent({
    request: makeRequest(gh2, ds).request,
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  const started = await agent2.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent2);
  const done = agent2.get({ id: started.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /Dev changed during this run/);
  assert.equal(
    gh.accepted.some((r) => r.endpoint.endsWith('/git/refs/heads/dev')),
    false,
  );
});

// ---------------------------------------------------------------------------
// Model/protocol failures
// ---------------------------------------------------------------------------

test('repeated model truncation fails and does not publish', async () => {
  const { agent, gh } = makeAgent({
    script: Array.from({ length: 3 }, () => ({
      content: '{"action":"read","paths":["README.md"]}',
      finish_reason: 'length',
    })),
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /incomplete/i);
  assert.equal(
    gh.accepted.some((r) => r.endpoint.endsWith('/git/refs/heads/dev')),
    false,
  );
});

test('invalid JSON from model fails without publishing', async () => {
  const { agent, gh, deepseek } = makeAgent({
    script: Array(3).fill('not json'),
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /invalid JSON/i);
  assert.equal(deepseek.calls.length, 3);
  assert.equal(done.responseRetries, 3);
  assert.equal(
    gh.accepted.some((r) => r.endpoint.endsWith('/git/refs/heads/dev')),
    false,
  );
});

test('unknown action fails without publishing', async () => {
  const { agent } = makeAgent({
    script: Array(3).fill(JSON.stringify({ action: 'explode' })),
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  assert.equal(agent.get({ id: started.id }).status, 'failed');
});

// ---------------------------------------------------------------------------
// Cancellation / concurrency
// ---------------------------------------------------------------------------

test('cancel in-flight aborts the request signal and marks run cancelled', async () => {
  let captured;
  const gh = makeGitHub();
  const ds = {
    request: (service, endpoint, options) => {
      assert.equal(service, 'deepseek');
      captured = options.signal;
      // never resolve; wait for abort
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('Run cancelled.')),
          { once: true },
        );
      });
    },
  };
  const store = makeStore();
  const agent = createAgent({
    request: makeRequest(gh, ds).request,
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await until(() => captured, 'deepseek call');
  assert.ok(captured instanceof AbortSignal);
  agent.cancel();
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'cancelled');
});

test('cancel during publishing is rejected', async () => {
  const gh = makeGitHub();
  let held;
  const origCommit = gh.request;
  const wrapped = async (s, e, o) => {
    if (e.endsWith('/git/refs/heads/dev') && o?.method === 'PATCH') {
      return new Promise((resolve) => {
        held = () => resolve(origCommit(s, e, o));
      });
    }
    return origCommit(s, e, o);
  };
  const ds = makeDeepSeek([
    JSON.stringify({ action: 'read', paths: ['README.md'] }),
    JSON.stringify({ action: 'write', path: 'README.md', content: 'new\n' }),
    finishAction(['x']),
  ]);
  const store = makeStore();
  const agent = createAgent({
    request: makeRequest({ ...gh, request: wrapped }, ds).request,
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await until(() => held, 'commit in flight');
  // still running -> we are before publishing.status update; hold until publishing
  await until(
    () => agent.get({ id: started.id }).status === 'publishing',
    'publishing status',
  );
  assert.throws(() => agent.cancel(), /Publication is in progress/);
  held();
  await settled(agent);
  assert.equal(agent.get({ id: started.id }).status, 'completed');
});

test('no simultaneous starts', async () => {
  const { agent } = makeAgent({
    script: [
      JSON.stringify({ action: 'read', paths: ['README.md'] }),
      finishAction(['x']),
    ],
  });
  const first = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await assert.rejects(
    () => agent.start({ repo: 'a/b', tasks: 'x', model: 'm' }),
    /already active/,
  );
  await settled(agent);
  assert.equal(agent.get({ id: first.id }).status, 'completed');
});

// ---------------------------------------------------------------------------
// init / interruption
// ---------------------------------------------------------------------------

test('init marks orphaned running and publishing runs as interrupted without a matching dev ref', async () => {
  const gh = makeGitHub({ refSha: hex('0') });
  const store = makeStore({
    'agents.json': JSON.stringify([
      { id: 'r1', status: 'running', repo: 'a/b', log: [], changes: [] },
      {
        id: 'r2',
        status: 'publishing',
        repo: 'a/b',
        log: [],
        changes: [],
        commitSha: hex('a'),
      },
      { id: 'r3', status: 'completed', repo: 'a/b', log: [], changes: [] },
    ]),
  });
  const agent = createAgent({
    request: gh.request,
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  await agent.init();
  const list = agent.list();
  const byId = Object.fromEntries(list.map((r) => [r.id, r]));
  assert.equal(byId.r1.status, 'interrupted');
  assert.match(byId.r1.error, /exited/);
  assert.equal(byId.r2.status, 'interrupted');
  assert.match(byId.r2.error, /Publication was interrupted/);
  assert.equal(byId.r3.status, 'completed');
  // publishing follow-up call hit dev ref only
  assert.ok(
    gh.accepted.every(
      (r) =>
        r.service === 'github' && r.endpoint.includes('/git/ref/heads/dev'),
    ),
  );
});

test('init completes a publishing run when the dev ref already equals the saved commit', async () => {
  const savedCommit = hex('a');
  const gh = makeGitHub({ refSha: savedCommit });
  const store = makeStore({
    'agents.json': JSON.stringify([
      {
        id: 'r2',
        status: 'publishing',
        repo: 'a/b',
        log: [],
        changes: [],
        commitSha: savedCommit,
      },
    ]),
  });
  const agent = createAgent({
    request: gh.request,
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  await agent.init();
  const r = agent.get({ id: 'r2' });
  assert.equal(r.status, 'completed');
  assert.equal(r.error, null);
});

test('init rejects invalid history and preserves the stored file', async () => {
  const store = makeStore({ 'agents.json': JSON.stringify({ nope: true }) });
  const agent = createAgent({
    request: async () => {
      throw new Error('should not request');
    },
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  await assert.rejects(() => agent.init(), /history is invalid/);
  assert.equal(store.files['agents.json'], JSON.stringify({ nope: true }));
});

// ---------------------------------------------------------------------------
// Invalid task / path inputs
// ---------------------------------------------------------------------------

test('invalid tasks/main paths are rejected before any request', async () => {
  const store = makeStore();
  let hit = 0;
  const agent = createAgent({
    request: async () => {
      hit++;
      throw new Error('unexpected');
    },
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  await assert.rejects(
    () => agent.start({ repo: 'a/b', branch: 'main', tasks: 'x', model: 'm' }),
    /dev/,
  );
  await assert.rejects(
    () => agent.start({ repo: 'a/b', tasks: '   ', model: 'm' }),
    /Task list/,
  );
  assert.equal(hit, 0);
  assert.equal(agent.isRunning(), false);
});

test('restricted credential paths are rejected at read and write', async () => {
  const { agent } = makeAgent({
    script: [
      JSON.stringify({ action: 'read', paths: ['.env'] }),
      finishAction(['x']),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /Restricted credential path/);
});

// ---------------------------------------------------------------------------
// Path collisions / binary / symlink
// ---------------------------------------------------------------------------

test('write over a directory (path collision) is rejected without publishing', async () => {
  const { gh } = makeAgent({
    script: [
      JSON.stringify({ action: 'write', path: 'src', content: 'x' }),
      finishAction(['x']),
    ],
  });
  // create dir collision: model writes a new file under an existing file path
  const ds = makeDeepSeek([
    JSON.stringify({ action: 'write', path: 'src', content: 'x' }),
    finishAction(['x']),
  ]);
  const store = makeStore();
  const agent2 = createAgent({
    request: makeRequest(gh, ds).request,
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  const started = await agent2.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent2);
  const done = agent2.get({ id: started.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /regular file|collision|Read the existing/);
  assert.equal(
    gh.accepted.some((r) => r.endpoint.endsWith('/git/refs/heads/dev')),
    false,
  );
});

test('creating a file beneath an existing blob path is a collision', async () => {
  const gh = makeGitHub({
    tree: {
      sha: BASE_TREE,
      truncated: false,
      tree: [
        { path: 'a', mode: '100644', type: 'blob', size: 1, sha: BLOB_SHA },
      ],
    },
    blobs: { [BLOB_SHA]: encode('x') },
  });
  const ds = makeDeepSeek([
    JSON.stringify({ action: 'write', path: 'a/b', content: 'x' }),
    finishAction(['x']),
  ]);
  const store = makeStore();
  const agent = createAgent({
    request: makeRequest(gh, ds).request,
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /collision/i);
});

test('binary blob and symlink cannot be read as text', async () => {
  const gh = makeGitHub();
  const ds = makeDeepSeek([
    JSON.stringify({ action: 'read', paths: ['logo.png'] }),
    finishAction(['x']),
  ]);
  const store = makeStore();
  const agent = createAgent({
    request: makeRequest(gh, ds).request,
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /regular text|Binary|blob|UTF-8/);

  // symlink entry has mode 120000 and is not in the allowed regular modes
  const gh2 = makeGitHub();
  const ds2 = makeDeepSeek([
    JSON.stringify({ action: 'read', paths: ['link'] }),
    finishAction(['x']),
  ]);
  const agent2 = createAgent({
    request: makeRequest(gh2, ds2).request,
    readJson: store.readJson,
    atomicWrite: store.atomicWrite,
    notify: store.notify,
  });
  const s2 = await agent2.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent2);
  const d2 = agent2.get({ id: s2.id });
  assert.equal(d2.status, 'failed');
  assert.match(d2.error, /regular text/);
});

// ---------------------------------------------------------------------------
// Signature / notification invariants
// ---------------------------------------------------------------------------

test('every request call through the injected signature is (service, endpoint, options)', async () => {
  const { agent, gh } = makeAgent({
    script: [
      JSON.stringify({ action: 'read', paths: ['README.md'] }),
      finishAction(['x']),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  assert.ok(gh.accepted.length >= 3);
  for (const r of gh.accepted) {
    assert.deepEqual(Object.keys(r).sort(), ['endpoint', 'options', 'service']);
    assert.equal(typeof r.endpoint, 'string');
    assert.ok(r.options && typeof r.options === 'object');
    if (r.options.method) assert.match(r.options.method, /^(GET|POST|PATCH)$/);
    if (r.service === 'github' && r.options.method !== undefined) {
      assert.ok(r.options.signal instanceof AbortSignal);
    }
  }
  assert.equal(agent.get({ id: started.id }).status, 'completed');
});

test('atomicWrite is used and notifications record the run id', async () => {
  const { agent, store } = makeAgent({
    script: [
      JSON.stringify({ action: 'read', paths: ['README.md'] }),
      JSON.stringify({
        action: 'write',
        path: 'README.md',
        content: 'changed\n',
      }),
      finishAction(['x']),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  assert.ok(store.files['agents.json']);
  const persisted = JSON.parse(store.files['agents.json']);
  assert.equal(persisted.at(-1).id, started.id);
  assert.ok(store.notifications.length > 0);
  assert.ok(store.notifications.every((n) => n.id === started.id));
});

test('list reverses newest first and reports changed count without changes payload', async () => {
  const { agent } = makeAgent({
    script: [
      JSON.stringify({ action: 'read', paths: ['README.md'] }),
      JSON.stringify({
        action: 'write',
        path: 'README.md',
        content: 'changed\n',
      }),
      finishAction(['x']),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const list = agent.list();
  assert.equal(list[0].id, started.id);
  assert.equal(list[0].changed, 1);
  assert.equal('changes' in list[0], false);
});

test('get throws for unknown run ids', async () => {
  const { agent } = makeAgent({ script: [] });
  assert.throws(() => agent.get({ id: 'nope' }), /Run not found/);
});

test('long investigation compacts context and publishes preserved staged bytes once', async () => {
  const content = 'staged output\n'.repeat(5000);
  const { agent, gh, deepseek } = makeAgent({
    ghState: {
      blobs: {
        ...BLOBS,
        [BLOB2_SHA]: encode('read data "quoted"\n'.repeat(4000)),
      },
    },
    script: [
      JSON.stringify({ action: 'write', path: 'new.txt', content }),
      ...Array(15).fill(
        JSON.stringify({ action: 'read', paths: Array(5).fill('README.md') }),
      ),
      finishAction(['x']),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'completed', done.error);
  assert.ok(done.contextCompactions > 0);
  assert.equal(done.changes[0].after, content);
  assert.ok(
    deepseek.calls.every((c) => JSON.stringify(c.messages).length <= 220000),
  );
  const blobs = gh.accepted.filter(
    (c) => c.endpoint.endsWith('/git/blobs') && c.options.method === 'POST',
  );
  assert.equal(JSON.parse(blobs[0].options.body).content, content);
  assert.equal(
    gh.accepted.filter((c) => c.options.method === 'PATCH').length,
    1,
  );
});

test('paged read and exact replacement preserve unseen file contents', async () => {
  const original = 'x'.repeat(7000) + 'unique target' + 'y'.repeat(9000);
  const { agent, deepseek } = makeAgent({
    ghState: { blobs: { ...BLOBS, [BLOB2_SHA]: encode(original) } },
    script: [
      JSON.stringify({ action: 'read', paths: ['README.md'], offset: 4000 }),
      JSON.stringify({
        action: 'replace',
        path: 'README.md',
        oldText: 'unique target',
        newText: 'changed',
      }),
      finishAction(['x']),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'completed', done.error);
  assert.equal(
    done.changes[0].after,
    original.replace('unique target', 'changed'),
  );
  const page = JSON.parse(deepseek.calls[1].messages.at(-1).content)[0];
  assert.equal(page.offset, 4000);
  assert.equal(page.nextOffset, 8000);
});

test('full write after a partial read is rejected without losing the file', async () => {
  const { agent } = makeAgent({
    ghState: { blobs: { ...BLOBS, [BLOB2_SHA]: encode('x'.repeat(9000)) } },
    script: [
      JSON.stringify({
        action: 'write',
        path: 'README.md',
        content: 'missing the unread part',
      }),
      finishAction(['x'], 'blocked'),
    ],
  });
  const started = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: started.id });
  assert.equal(done.status, 'blocked');
  assert.equal(done.changes.length, 0);
});

test('rewriting, reading staged content, and reverting preserve the true original', async () => {
  const { agent, deepseek } = makeAgent({
    script: [
      JSON.stringify({ action: 'write', path: 'README.md', content: 'first' }),
      JSON.stringify({ action: 'read', paths: ['README.md'] }),
      JSON.stringify({ action: 'write', path: 'README.md', content: 'second' }),
      finishAction(['x']),
    ],
  });
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'completed');
  assert.equal(done.changes[0].before, 'read me\n');
  assert.equal(done.changes[0].after, 'second');
  const readResult = JSON.parse(deepseek.calls[2].messages.at(-1).content);
  assert.equal(readResult[0].content, 'first');
});

test('step limit preserves staged files without writing remote objects', async () => {
  const { agent, gh } = makeAgent({
    script: Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({
        action: 'write',
        path: 'README.md',
        content: String(i),
      }),
    ),
  });
  const run = await agent.start({
    repo: 'a/b',
    tasks: 'x',
    model: 'm',
    maxSteps: 10,
  });
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /Step limit/);
  assert.equal(done.changes[0].after, '9');
  assert.equal(
    gh.accepted.some((r) => r.options.method),
    false,
  );
});

test('incomplete task accounting prevents publication', async () => {
  const { agent, gh } = makeAgent({ script: [finishAction(['x'])] });
  const run = await agent.start({ repo: 'a/b', tasks: 'x\ny', model: 'm' });
  await settled(agent);
  assert.match(agent.get({ id: run.id }).error, /every task/);
  assert.equal(
    gh.accepted.some((r) => r.options.method),
    false,
  );
});

test('an ambiguous ref failure preserves the generated commit for later review', async () => {
  const gh = makeGitHub(),
    store = makeStore();
  const ds = makeDeepSeek([
    JSON.stringify({ action: 'write', path: 'README.md', content: 'new' }),
    finishAction(['x']),
  ]);
  const request = makeRequest(gh, ds).request;
  const agent = createAgent({
    ...store,
    request: (service, endpoint, options) => {
      if (options?.method === 'PATCH') throw new Error('Connection lost');
      return request(service, endpoint, options);
    },
  });
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'interrupted');
  assert.equal(done.commitSha, NEW_COMMIT);
  assert.match(done.error, /may have completed/);
});

test('a report save failure after publication does not claim the commit failed', async () => {
  const gh = makeGitHub(),
    store = makeStore();
  const ds = makeDeepSeek([
    JSON.stringify({ action: 'write', path: 'README.md', content: 'new' }),
    finishAction(['x']),
  ]);
  const agent = createAgent({
    ...store,
    request: makeRequest(gh, ds).request,
    atomicWrite: async (name, value) => {
      if (JSON.parse(value).at(-1).status === 'completed')
        throw new Error('Disk full');
      return store.atomicWrite(name, value);
    },
  });
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  assert.equal(agent.get({ id: run.id }).status, 'completed');
  assert.match(agent.get({ id: run.id }).error, /were published/);
  assert.equal(
    JSON.parse(store.files['agents.json']).at(-1).status,
    'publishing',
  );
});
// ---------------------------------------------------------------------------
// JSON-response recovery
// ---------------------------------------------------------------------------

test('recovery: malformed JSON then valid write then finish publishes one commit', async () => {
  const { agent, gh, deepseek } = makeAgent({
    script: [
      'not json',
      JSON.stringify({ action: 'write', path: 'README.md', content: 'new\n' }),
      finishAction(['x']),
    ],
  });
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'completed');
  assert.equal(done.commitSha, NEW_COMMIT);
  assert.equal(deepseek.calls.length, 3);
  const patches = gh.accepted.filter((r) => r.options?.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.ok(!patches.some((p) => p.endpoint.includes('/main')));
});

test('recovery: repeated invalid JSON stops after 3 bad responses', async () => {
  const { agent, deepseek } = makeAgent({
    script: ['bad', 'bad', 'bad', 'bad'],
  });
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /invalid JSON/i);
  assert.equal(deepseek.calls.length, 3);
  assert.equal(deepseek.remaining(), 1);
});

test('recovery: correction prompt states no action applied and no action was staged', async () => {
  const { agent, deepseek } = makeAgent({
    script: [
      'not json',
      JSON.stringify({ action: 'write', path: 'README.md', content: 'new\n' }),
      finishAction(['x']),
    ],
  });
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  assert.equal(agent.get({ id: run.id }).status, 'completed');

  const correction = deepseek.calls[1].messages;
  const last = correction.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.content, /No action was applied/);
  // rejected response must not have been appended as assistant history
  assert.equal(
    correction.some((m) => m.role === 'assistant' && m.content === 'not json'),
    false,
  );
  // only the one applied write is in the assistant history
  const applied = correction.filter(
    (m) => m.role === 'assistant' && /"action":"write"/.test(m.content),
  );
  assert.equal(applied.length, 0);
});

test('recovery: staged files are retained through a retry', async () => {
  const { agent, deepseek } = makeAgent({
    script: [
      JSON.stringify({
        action: 'write',
        path: 'README.md',
        content: 'staged\n',
      }),
      'oops',
      finishAction(['x']),
    ],
  });
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'completed');
  assert.equal(done.changes.length, 1);
  assert.equal(done.changes[0].after, 'staged\n');
  // the staged write survives and is committed
  assert.equal(done.commitSha, NEW_COMMIT);
  assert.equal(deepseek.remaining(), 0);
});

test('recovery: maxSteps caps recovery attempts', async () => {
  const { agent, deepseek } = makeAgent({
    script: [
      ...Array(9).fill(
        JSON.stringify({ action: 'read', paths: ['README.md'] }),
      ),
      'bad',
      finishAction(['x']),
    ],
  });
  const run = await agent.start({
    repo: 'a/b',
    tasks: 'x',
    model: 'm',
    maxSteps: 10,
  });
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'failed');
  // The invalid response at the final step must not trigger an eleventh request.
  assert.equal(deepseek.calls.length, 10);
  assert.match(done.error, /recover|invalid JSON/i);
});

test('recovery: partially fenced / trailing-prose responses are not parses the model can slip through', async () => {
  const { agent, deepseek } = makeAgent({
    script: [
      '```json\n{"action":"read","paths":["README.md"]}\n```\ntrailing',
      JSON.stringify({ action: 'read', paths: ['README.md'] }),
      finishAction(['x']),
    ],
  });
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'completed');
  // first response rejected as not-a-whole-fence
  assert.equal(deepseek.calls.length, 3);
});

test('recovery: wholly fenced object preserves code strings verbatim', async () => {
  const content = '```js\nconst x = "quote";\n```\nC:\\file';
  const action = { action: 'write', path: 'new.js', content };
  const { agent, gh } = makeAgent({
    script: [
      '```json\n' + JSON.stringify(action) + '\n```',
      finishAction(['x']),
    ],
  });
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'completed');
  assert.equal(done.changes[0].after, content);
  const blobReq = gh.accepted.find(
    (r) => r.endpoint.endsWith('/git/blobs') && r.options.method === 'POST',
  );
  assert.equal(JSON.parse(blobReq.options.body).content, content);
});

test('recovery: cancellation during a retry stops the run', async () => {
  let calls = 0;
  const gh = makeGitHub();
  const ds = {
    request: (service, endpoint, options) => {
      assert.equal(service, 'deepseek');
      calls++;
      if (calls === 1)
        return Promise.resolve({
          choices: [{ finish_reason: 'stop', message: { content: 'bad' } }],
          usage: {},
        });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('Run cancelled.')),
          { once: true },
        );
      });
    },
  };
  const store = makeStore();
  const { request } = makeRequest(gh, ds);
  const agent = createAgent({ request, ...store });
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await until(() => calls === 2, 'second deepseek call');
  agent.cancel();
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'cancelled');
  assert.equal(done.commitSha, null);
  assert.equal(
    gh.accepted.some((r) => r.options?.method === 'PATCH'),
    false,
  );
});

for (const bad of [
  { action: 'read' },
  { action: 'read', path: 'src/index.js' },
  { action: 'read', paths: 'src/index.js' },
  { action: 'read', paths: [] },
  { action: 'read', paths: Array(6).fill('src/index.js') },
  { action: 'read', paths: ['src/index.js', null] },
  { action: 'read', paths: ['src/index.js'], offset: -1 },
  { action: 'read', paths: ['src/index.js'], offset: '0' },
  { action: 'list', offset: 0.5 },
  { action: 'write', path: 'new.txt', content: null },
  { action: 'replace', path: 'README.md', oldText: '', newText: 'x' },
]) {
  test(`action recovery preserves staged work: ${JSON.stringify(bad)}`, async () => {
    const content = 'exact staged bytes\n';
    const { agent, gh, deepseek } = makeAgent({
      script: [
        JSON.stringify({ action: 'write', path: 'new.txt', content }),
        JSON.stringify(bad),
        JSON.stringify({ action: 'read', paths: ['README.md'] }),
        finishAction(['x']),
      ],
    });
    await agent.init();
    const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
    await settled(agent);
    const done = agent.get({ id: run.id });
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.responseRetries, 1);
    assert.equal(done.changes[0].after, content);
    assert.equal(deepseek.calls.length, 4);
    assert.match(
      deepseek.calls[2].messages.at(-1).content,
      /No action was applied/,
    );
    assert.equal(
      gh.accepted.filter((c) => c.endpoint.endsWith('/git/blobs/' + hex('8')))
        .length,
      0,
    );
    assert.equal(
      gh.accepted.filter((c) => c.options.method === 'PATCH').length,
      1,
    );
  });
}

test('repeated malformed reads stop within recovery limit without publishing', async () => {
  const { agent, gh, deepseek } = makeAgent({
    script: Array(3).fill(JSON.stringify({ action: 'read', paths: [] })),
  });
  await agent.init();
  const run = await agent.start({ repo: 'a/b', tasks: 'x', model: 'm' });
  await settled(agent);
  const done = agent.get({ id: run.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /Read requires/);
  assert.equal(deepseek.calls.length, 3);
  assert.equal(
    gh.accepted.filter((c) => c.options.method === 'PATCH').length,
    0,
  );
});
