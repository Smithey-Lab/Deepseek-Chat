const CONTEXT_LIMIT = 220000;
const size = (messages) => JSON.stringify(messages).length;
function treePage(tree, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('List offset must be a non-negative integer.');
  const files = [];
  let cursor = offset;
  while (cursor < tree.length && files.length < 200) {
    const { path, type } = tree[cursor];
    if (
      files.length &&
      JSON.stringify([...files, { path, type }]).length > 24000
    )
      break;
    files.push({ path, type });
    cursor++;
  }
  return {
    files,
    nextOffset: cursor < tree.length ? cursor : null,
    totalPaths: tree.length,
  };
}
function createReadTracker() {
  const seen = new Map();
  return {
    known(path, content) {
      seen.set(path, { content, ranges: [[0, content.length]] });
    },
    page(path, content, offset = 0) {
      const page = filePage(path, content, offset);
      if (typeof content !== 'string') return page;
      const previous = seen.get(path);
      const ranges = previous?.content === content ? previous.ranges : [];
      ranges.push([
        Math.min(offset, content.length),
        Math.min(offset + 4000, content.length),
      ]);
      ranges.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last && last[1] >= range[0]) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
      }
      seen.set(path, { content, ranges: merged });
      return page;
    },
    complete(path, content) {
      const state = seen.get(path);
      return (
        !!state &&
        state.content === content &&
        state.ranges[0]?.[0] === 0 &&
        state.ranges[0]?.[1] === content.length
      );
    },
  };
}
function filePage(path, content, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Read offset must be a non-negative integer.');
  if (content === null) return { path, content: null, deleted: true };
  return {
    path,
    content: content.slice(offset, offset + 4000),
    offset,
    nextOffset: offset + 4000 < content.length ? offset + 4000 : null,
    totalCharacters: content.length,
  };
}
function compactContext(messages, state) {
  if (size(messages) <= CONTEXT_LIMIT) return false;
  const initial = JSON.parse(messages[1].content);
  const checkpoint = {
    repo: state.repo,
    tasks: state.tasks,
    note: 'Earlier file contents and action history were compacted. All staged changes and original files remain in the app. Read any file again to see its current staged contents; use offset for subsequent pages. Do not repeat completed edits. Nothing has been committed yet. Finish must account for every original task. You can list repository paths again.',
    stagedChanges: state.changes.map(({ path, after }) => ({
      path,
      action: after === null ? 'delete' : 'write',
    })),
    recentlyReadPaths: state.readPaths.slice(-30),
    recentActivity: state.log.slice(-12).map((entry) => entry.message),
    files: initial.files,
    documents: initial.documents,
  };
  const base = [messages[0], { role: 'user', content: '' }];
  const encode = () => {
    base[1].content = JSON.stringify(checkpoint);
  };
  encode();
  // Drop rediscoverable metadata before task or staged-change information.
  for (const field of [
    'documents',
    'files',
    'recentlyReadPaths',
    'recentActivity',
  ]) {
    if (size(base) <= 90000) break;
    delete checkpoint[field];
    encode();
  }
  if (size(base) > CONTEXT_LIMIT)
    throw new Error(
      'Task/checkpoint metadata exceeds the context budget. Saved edits were not published.',
    );
  const recent = [];
  // Keep recent complete messages only, avoiding another copy of full write contents.
  for (let i = messages.length - 1; i >= 2 && recent.length < 6; i--) {
    let message = messages[i];
    if (message.role === 'assistant') {
      try {
        const action = JSON.parse(message.content);
        if (['write', 'replace'].includes(action.action))
          message = {
            role: 'assistant',
            content: JSON.stringify({
              action: action.action,
              path: action.path,
              note: 'Content omitted from context; consult staged state and read the file again.',
            }),
          };
      } catch {
        /* Keep correction messages as text. */
      }
    }
    if (size([...base, message, ...recent]) > CONTEXT_LIMIT) break;
    recent.unshift(message);
  }
  messages.splice(0, messages.length, ...base, ...recent);
  return true;
}
module.exports = {
  compactContext,
  filePage,
  treePage,
  createReadTracker,
  CONTEXT_LIMIT,
};
