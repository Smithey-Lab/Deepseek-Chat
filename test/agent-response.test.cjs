const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAgentResponse } = require('../src/agent-response.cjs');
const reply = (content, finish_reason = 'stop') => ({
  finish_reason,
  message: { content },
});
test('accepts plain or wholly fenced JSON without changing file contents', () => {
  const action = {
    action: 'write',
    path: 'file.js',
    content: '```js\nconst x = "quote";\n```\nC:\\file',
  };
  for (const source of [
    JSON.stringify(action),
    '\uFEFF  ' + JSON.stringify(action),
    '```json\n' + JSON.stringify(action) + '\n```',
    '```\r\n' + JSON.stringify(action) + '\r\n```',
  ])
    assert.deepEqual(parseAgentResponse(reply(source)), action);
});
test('rejects prose, multiple objects, broken strings and executable expressions', () => {
  for (const source of [
    'Here is JSON: {"action":"read"}',
    '{"action":"read"}{"action":"delete"}',
    '{"action":"write","content":"unescaped\nline"}',
    '({action:"read"})',
    '```json\n{"action":"read"}\n```\nextra',
    '[]',
    'null',
    '"string"',
  ])
    assert.throws(() => parseAgentResponse(reply(source)));
});
test('rejects truncated output even if its prefix is parseable, empty output and unknown actions', () => {
  assert.throws(
    () => parseAgentResponse(reply('{"action":"read"}', 'length')),
    /incomplete/,
  );
  assert.throws(() => parseAgentResponse(reply('  ')), /empty/);
  assert.throws(
    () => parseAgentResponse(reply('{"action":"shell"}')),
    /unknown action/,
  );
});
