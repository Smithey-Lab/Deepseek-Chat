const api = window.workspace;
const $ = (id) => document.getElementById(id);
let chats = [],
  current,
  busy = false,
  folder = '',
  opened,
  original = '',
  reviewed = null;
let saveQueue = Promise.resolve();
let codeBusy = false,
  saving = 0,
  allowClose = false;
async function withCodeLock(action) {
  if (codeBusy) throw new Error('Wait for the current repository operation.');
  codeBusy = true;
  $('code-view').inert = true;
  try {
    return await action();
  } finally {
    codeBusy = false;
    $('code-view').inert = false;
  }
}
const status = (message) => {
  $('status').textContent = message;
};
const run = (action) => async (event) => {
  try {
    await action(event);
  } catch (error) {
    status(error.message);
  }
};
function view(name) {
  for (const item of document.querySelectorAll('.view'))
    item.hidden = item.id !== `${name}-view`;
  for (const button of document.querySelectorAll('[data-view]'))
    button.classList.toggle('active', button.dataset.view === name);
  $('page-title').textContent = {
    chat: 'Conversations',
    code: 'GitHub & code',
    settings: 'Settings & updates',
  }[name];
}
for (const button of document.querySelectorAll('[data-view]'))
  button.onclick = () => view(button.dataset.view);
function persist() {
  saving++;
  const snapshot = JSON.parse(JSON.stringify(chats));
  saveQueue = saveQueue.catch(() => {}).then(() => api.saveChats(snapshot));
  return saveQueue.finally(() => {
    saving--;
  });
}
function newChat() {
  current = {
    id: crypto.randomUUID(),
    title: 'New conversation',
    messages: [],
  };
  chats.unshift(current);
  render();
  view('chat');
}
function render() {
  $('chat-list').replaceChildren();
  for (const chat of chats) {
    const button = document.createElement('button');
    button.textContent = chat.title;
    button.classList.toggle('selected', chat.id === current?.id);
    button.onclick = () => {
      current = chat;
      render();
      view('chat');
    };
    $('chat-list').append(button);
  }
  $('messages').replaceChildren();
  if (!current?.messages.length) {
    const welcome = document.createElement('div');
    welcome.className = 'welcome';
    const orb = document.createElement('div');
    orb.className = 'orb';
    orb.textContent = '✦';
    const title = document.createElement('h2');
    title.textContent = 'A little curiosity. A lot of possibility.';
    const subtitle = document.createElement('p');
    subtitle.textContent =
      'Think through a problem, build something new, or bring your repository into the conversation. Your next idea starts here.';
    const suggestions = document.createElement('div');
    suggestions.className = 'suggestions';
    for (const prompt of [
      'Help me plan a feature',
      'Explain a code snippet',
      'Review my approach',
    ]) {
      const button = document.createElement('button');
      button.textContent = prompt;
      button.onclick = () => {
        $('prompt').value = prompt;
        $('prompt').focus();
      };
      suggestions.append(button);
    }
    welcome.append(orb, title, subtitle, suggestions);
    $('messages').append(welcome);
  }
  for (const message of current?.messages || []) {
    const article = document.createElement('article');
    article.className = `message ${message.role}`;
    const author = document.createElement('div');
    author.className = 'author';
    author.textContent = message.role === 'user' ? 'You' : 'DeepSeek';
    const content = document.createElement('pre');
    content.textContent = message.content;
    article.append(author, content);
    if (message.role === 'assistant') {
      const copy = document.createElement('button');
      copy.textContent = 'Copy response';
      copy.onclick = run(async () => {
        await navigator.clipboard.writeText(message.content);
        status('Response copied.');
      });
      article.append(copy);
    }
    $('messages').append(article);
  }
  $('messages').scrollTop = $('messages').scrollHeight;
}
$('new-chat').onclick = run(async () => {
  newChat();
  await persist();
});
$('delete-chat').onclick = run(async () => {
  if (busy)
    throw new Error('Stop the response before deleting a conversation.');
  if (!current || !confirm('Delete this locally saved conversation?')) return;
  chats = chats.filter((chat) => chat.id !== current.id);
  current = chats[0];
  if (!current) newChat();
  render();
  await persist();
});
$('chat-form').onsubmit = run(async (event) => {
  event.preventDefault();
  if (busy) return;
  const content = $('prompt').value.trim();
  if (!content) return;
  if (!current) newChat();
  const target = current;
  target.messages.push({ role: 'user', content });
  target.title = target.messages[0].content.slice(0, 38);
  $('prompt').value = '';
  busy = true;
  $('send').disabled = true;
  $('stop').hidden = false;
  render();
  let received = false;
  try {
    await persist();
    status('DeepSeek is thinking…');
    const response = await api.send({
      model: $('model').value,
      messages: target.messages,
    });
    target.messages.push({ role: 'assistant', content: response });
    received = true;
    await persist();
    status('Response saved locally.');
  } catch (error) {
    if (!received) {
      target.messages.pop();
      $('prompt').value = content;
      await persist();
    }
    throw error;
  } finally {
    busy = false;
    $('send').disabled = false;
    $('stop').hidden = true;
    render();
  }
});
$('prompt').onkeydown = (event) => {
  if (event.ctrlKey && event.key === 'Enter') $('chat-form').requestSubmit();
};
$('stop').onclick = run(async () => {
  await api.cancel();
  status('Response stopped.');
});
$('refresh-models').onclick = run(async () => {
  const models = await api.models();
  if (!models.length) throw new Error('No models returned for this account.');
  $('model').replaceChildren(
    ...models.map((id) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      return option;
    }),
  );
  status('Models refreshed from your DeepSeek account.');
});
async function connections() {
  const settings = await api.settings();
  $('connection-status').textContent =
    `DeepSeek: ${settings.deepseek ? 'saved' : 'not connected'} · GitHub: ${settings.github ? 'saved' : 'not connected'}`;
  $('version').textContent = `v${settings.version}`;
}
$('settings-form').onsubmit = run(async (event) => {
  event.preventDefault();
  const input = {};
  if ($('deepseek-key').value.trim()) input.deepseek = $('deepseek-key').value;
  if ($('github-token').value.trim()) input.github = $('github-token').value;
  await api.saveSettings(input);
  $('deepseek-key').value = '';
  $('github-token').value = '';
  await connections();
  status(
    'Connections saved securely. Use Refresh models to load your available models.',
  );
});
$('clear-keys').onclick = run(async () => {
  if (confirm('Remove both saved credentials?')) {
    await api.saveSettings({ deepseek: '', github: '' });
    await connections();
    status('Saved credentials removed.');
  }
});
async function browse(path = '') {
  const repo = $('repo').value.trim();
  const files = await api.list({ repo, path });
  folder = path;
  $('directory').textContent = '/' + folder;
  $('files').replaceChildren();
  for (const file of files.sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  )) {
    const button = document.createElement('button');
    button.textContent = `${file.type === 'dir' ? '▸' : '·'} ${file.name}`;
    button.onclick = run(() =>
      withCodeLock(async () => {
        if (file.type === 'dir') return browse(file.path);
        if (!discard()) return;
        opened = await api.read({ repo, path: file.path });
        original = opened.content;
        $('file-path').value = opened.path;
        $('file-path').readOnly = true;
        $('editor').value = original;
        reviewed = null;
        $('diff').hidden = true;
        status(`Loaded ${repo}/${opened.path} from dev.`);
      }),
    );
    $('files').append(button);
  }
  status(`Browsing ${repo}:dev.`);
}
function discard() {
  return (
    $('editor').value === original || confirm('Discard unsaved editor changes?')
  );
}
$('browse').onclick = run(() => withCodeLock(() => browse()));
$('up').onclick = run(() =>
  withCodeLock(() => browse(folder.split('/').slice(0, -1).join('/'))),
);
$('new-file').onclick = () => {
  if (!discard()) return;
  opened = null;
  original = '';
  reviewed = null;
  $('file-path').readOnly = false;
  $('file-path').value = '';
  $('editor').value = '';
  $('diff').hidden = true;
  $('file-path').focus();
};
$('attach').onclick = () => {
  const path = $('file-path').value || 'untitled';
  $('prompt').value =
    `Please help me with this file.\n\nFile: ${path}\n\n\`\`\`\n${$('editor').value}\n\`\`\``;
  view('chat');
  status('File attached to your draft. Send it when ready.');
};
function proposal() {
  return {
    repo: opened?.repo || $('repo').value.trim(),
    path: $('file-path').value.trim(),
    content: $('editor').value,
    branch: 'dev',
    ...(opened ? { sha: opened.sha } : {}),
  };
}
$('review').onclick = () => {
  $('before').textContent = original || '(new or empty file)';
  $('after').textContent = $('editor').value;
  $('diff').hidden = false;
  reviewed = JSON.stringify(proposal());
  status(
    'Review the before and after contents below, then enter a commit message.',
  );
};
$('commit').onclick = run(() =>
  withCodeLock(async () => {
    const input = proposal();
    if (reviewed !== JSON.stringify(input))
      throw new Error('Click Review changes after your latest edits.');
    if (input.content === original && opened)
      throw new Error('No changes to commit.');
    $('commit').disabled = true;
    try {
      const result = await api.commit({
        ...input,
        message: $('commit-message').value.trim(),
      });
      if (result.cancelled) return;
      opened = { ...input, sha: result.sha };
      original = input.content;
      reviewed = null;
      $('file-path').readOnly = true;
      status(
        `Committed to ${input.repo}:dev. Open a dev → main pull request for Codex review.`,
      );
    } finally {
      $('commit').disabled = false;
    }
  }),
);
api.onUpdate((message) => {
  $('update-status').textContent = message;
});
$('check-update').onclick = run(async () => {
  status(await api.checkUpdate());
});
$('download-update').onclick = run(async () => {
  await api.downloadUpdate();
});
$('install-update').onclick = run(async () => {
  if (busy || codeBusy)
    throw new Error(
      'Finish the active response or repository operation before installing.',
    );
  if (confirm('Restart now? Save or commit any editor changes first.')) {
    await persist();
    allowClose = true;
    try {
      await api.installUpdate();
    } catch (error) {
      allowClose = false;
      throw error;
    }
  }
});
window.addEventListener('beforeunload', (event) => {
  if (allowClose) return;
  const pending = busy || codeBusy || saving > 0;
  const dirty = $('editor').value !== original || $('prompt').value.trim();
  if (
    pending ||
    (dirty &&
      !confirm('Discard unsaved editor changes and message draft, then close?'))
  ) {
    event.preventDefault();
    event.returnValue = '';
    if (pending)
      status(
        'Wait for the current operation to finish, or stop the response, before closing.',
      );
  }
});
run(async () => {
  await connections();
  chats = await api.loadChats();
  current = chats[0];
  if (!current) newChat();
  render();
})();
