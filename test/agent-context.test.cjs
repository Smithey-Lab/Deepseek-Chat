const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compactContext,
  filePage,
  treePage,
  createReadTracker,
  CONTEXT_LIMIT,
} = require('../src/agent-context.cjs');
test('compaction keeps original tasks and staged metadata without changing edits', () => {
  const changes = [
    { path: 'large.js', before: 'original', after: 'x'.repeat(90000) },
  ];
  const before = JSON.stringify(changes);
  const messages = [
    { role: 'system', content: 'trusted policy' },
    {
      role: 'user',
      content: JSON.stringify({
        tasks: ['one', 'two'],
        files: [],
        documents: [],
      }),
    },
  ];
  for (let i = 0; i < 10; i++)
    messages.push(
      {
        role: 'assistant',
        content: JSON.stringify({
          action: 'write',
          path: 'large.js',
          content: 'x'.repeat(80000),
        }),
      },
      { role: 'user', content: JSON.stringify({ staged: 'large.js' }) },
    );
  assert.equal(
    compactContext(messages, {
      repo: 'a/b',
      tasks: ['one', 'two'],
      changes,
      readPaths: ['large.js'],
      log: [],
    }),
    true,
  );
  assert.ok(JSON.stringify(messages).length <= CONTEXT_LIMIT);
  assert.equal(messages[0].content, 'trusted policy');
  assert.deepEqual(JSON.parse(messages[1].content).tasks, ['one', 'two']);
  assert.equal(
    JSON.parse(messages[1].content).stagedChanges[0].path,
    'large.js',
  );
  assert.equal(JSON.stringify(changes), before);
});
test('paged reads and listings round-trip all data without silently truncating', () => {
  const content = 'line\\"\n😀'.repeat(9000);
  let offset = 0,
    actual = '';
  do {
    const page = filePage('file', content, offset);
    actual += page.content;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(actual, content);
  const tree = Array.from({ length: 1000 }, (_, i) => ({
    path: `${i}/` + 'x'.repeat(1000),
    type: 'blob',
  }));
  offset = 0;
  const files = [];
  do {
    const page = treePage(tree, offset);
    assert.ok(JSON.stringify(page.files).length <= 24000);
    files.push(...page.files);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(files, tree);
});
test('full rewrite requires coverage of every page of the same revision', () => {
  const tracker = createReadTracker(),
    content = 'x'.repeat(9500);
  tracker.page('file', content, 0);
  tracker.page('file', content, 8000);
  assert.equal(tracker.complete('file', content), false);
  tracker.page('file', content, 4000);
  assert.equal(tracker.complete('file', content), true);
  assert.equal(tracker.complete('file', content + 'changed'), false);
});
test('oversized initial metadata is reduced and latest read survives', () => {
  const tasks = ['preserve this task'];
  const last = {
    role: 'user',
    content: JSON.stringify([filePage('file', '\\"\n'.repeat(3000))]),
  };
  const messages = [
    { role: 'system', content: 'policy' },
    {
      role: 'user',
      content: JSON.stringify({
        tasks,
        files: Array(5000).fill('p'.repeat(100)),
        documents: [{ content: 'x'.repeat(100000) }],
      }),
    },
    last,
  ];
  compactContext(messages, {
    repo: 'a/b',
    tasks,
    changes: [],
    readPaths: ['file'],
    log: [],
  });
  assert.ok(JSON.stringify(messages).length <= CONTEXT_LIMIT);
  assert.deepEqual(messages.at(-1), last);
  assert.deepEqual(JSON.parse(messages[1].content).tasks, tasks);
});
