(() => {
  const api = window.workspace;
  const $ = (id) => document.getElementById(id);
  let chats = [],
    current = null,
    busy = false,
    busyCode = false,
    folder = '',
    opened = null,
    original = '',
    reviewed = null,
    filteredFiles = [],
    matchIndex = -1;
  let saveQueue = Promise.resolve(),
    allowClose = false,
    reposState = { items: [], page: 0, hasMore: false },
    branchesState = { items: [], page: 0, hasMore: false },
    workspace = { preferences: {}, drafts: {}, activity: [] };
  let editorContext = null,
    saveError = null,
    ready = false,
    closing = false;
  let stopRequested = false;
  const prefs = () => workspace.preferences || (workspace.preferences = {});
  const drafts = () => workspace.drafts || (workspace.drafts = {});
  const status = (m) => {
    $('status').textContent = String(m ?? '');
  };
  const run = (fn) => async (ev) => {
    try {
      await fn(ev);
    } catch (e) {
      status(e && e.message ? e.message : String(e));
    }
  };
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function opt(value, label) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label == null ? value : label;
    return o;
  }
  function toastErr(e) {
    status(e && e.message ? e.message : String(e));
  }
  function enqueueSave(action) {
    const job = saveQueue.catch(() => {}).then(action);
    saveQueue = job;
    job.then(
      () => {
        saveError = null;
      },
      (error) => {
        saveError = error;
        toastErr(error);
      },
    );
    return job;
  }
  function queueWorkspaceSave() {
    if (!ready) return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(workspace));
    return enqueueSave(() => api.saveWorkspace(snapshot));
  }
  async function withCodeLock(action) {
    if (busyCode) throw Error('Wait for the current repository operation.');
    busyCode = true;
    $('code-view').inert = true;
    try {
      return await action();
    } finally {
      busyCode = false;
      $('code-view').inert = false;
      updateEditorAccess();
    }
  }
  function updateEditorAccess() {
    const ref = editorContext?.ref || $('branch').value;
    const meta = reposState.items.find(
      (r) => r.full_name === (editorContext?.repo || $('repo').value),
    );
    const readOnly =
      ref !== 'dev' || meta?.archived === true || meta?.push === false;
    $('editor').readOnly = readOnly;
    $('commit').disabled = readOnly;
    $('review').disabled = readOnly;
    $('new-file').disabled = readOnly;
    $('branch-fallback').hidden = ref === 'dev';
  }
  function resetEditor() {
    opened = null;
    editorContext = null;
    original = '';
    reviewed = null;
    $('editor').value = '';
    $('file-path').value = '';
    $('file-path').readOnly = false;
    $('diff').hidden = true;
    folder = '';
    filteredFiles = [];
    $('files').replaceChildren();
    $('breadcrumb').replaceChildren();
    $('directory').textContent = '/';
    updateDirtyState();
    updateEditorMeta();
    updateEditorAccess();
  }
  function clearRepositoryPanels() {
    for (const id of ['commit-list', 'compare-box', 'pulls-box'])
      $(id).replaceChildren();
  }

  function logActivity(kind, info) {
    const p = prefs();
    const log = (p.activityLog = p.activityLog || []);
    log.unshift({
      kind: String(kind),
      info: String(info || ''),
      at: new Date().toISOString(),
    });
    if (log.length > 200) log.length = 200;
    queueWorkspaceSave();
  }
  function draftKey(repo, path, ref) {
    return `${repo}::${ref || 'dev'}::${path}`;
  }
  function editorDraft() {
    const repo = editorContext?.repo;
    const path = $('file-path').value.trim();
    if (!repo || !path) return null;
    return { repo, path, ref: editorContext.ref };
  }
  function persistEditorDraft() {
    clearTimeout($('editor')._t);
    const k = editorDraft();
    if (!k) {
      if (editorContext && $('editor').value) {
        const scratch = prefs().untitledDrafts || (prefs().untitledDrafts = {});
        scratch[draftKey(editorContext.repo, '', editorContext.ref)] = {
          ...editorContext,
          path: '',
          content: $('editor').value,
          original: '',
        };
        renderDrafts();
        return queueWorkspaceSave();
      }
      return Promise.resolve();
    }
    const value = {
      ...k,
      content: $('editor').value,
      original,
      ...(opened?.sha ? { sha: opened.sha } : {}),
    };
    drafts()[draftKey(k.repo, k.path, k.ref)] = value;
    delete (prefs().untitledDrafts || {})[draftKey(k.repo, '', k.ref)];
    renderDrafts();
    prefs().lastEditor = k;
    const job = queueWorkspaceSave();
    job.then(
      () => {
        $('draft-status').textContent = 'Draft saved locally';
      },
      () => {
        $('draft-status').textContent = 'Draft could not be saved';
      },
    );
    return job;
  }

  function restoreEditorDraft(repo, path, ref) {
    const d = drafts();
    const k = draftKey(repo, path, ref);
    return d[k] || null;
  }
  function renderDrafts() {
    const box = $('saved-drafts');
    box.replaceChildren();
    const all = [
      ...Object.values(drafts()),
      ...Object.values(prefs().untitledDrafts || {}),
    ].filter((d) => d.content !== d.original);
    if (!all.length) box.append(el('p', 'muted', 'No unsaved drafts.'));
    for (const d of all) {
      const button = el(
        'button',
        null,
        d.repo + ' · ' + (d.path || '(untitled)') + ' @ ' + d.ref,
      );
      button.onclick = run(() =>
        withCodeLock(async () => {
          await persistEditorDraft();
          editorContext = { repo: d.repo, ref: d.ref };
          opened = d.sha
            ? { repo: d.repo, path: d.path, ref: d.ref, sha: d.sha }
            : null;
          original = d.original || '';
          $('repo').replaceChildren(opt(d.repo));
          $('branch').replaceChildren(opt(d.ref));
          prefs().selectedRepo = d.repo;
          $('file-path').value = d.path;
          $('file-path').readOnly = !!opened;
          $('editor').value = d.content;
          reviewed = null;
          $('diff').hidden = true;
          $('draft-status').textContent = 'Restored local draft';
          updateDirtyState();
          updateEditorMeta();
          updateEditorAccess();
          await queueWorkspaceSave();
        }),
      );
      box.append(button);
    }
  }
  function view(name) {
    for (const item of document.querySelectorAll('.view'))
      item.hidden = item.id !== `${name}-view`;
    for (const b of document.querySelectorAll('[data-view]'))
      b.classList.toggle('active', b.dataset.view === name);
    $('page-title').textContent = {
      chat: 'Conversations',
      code: 'GitHub & code',
      agent: 'Agent tasks',
      settings: 'Settings & updates',
    }[name];
    prefs().view = name;
    queueWorkspaceSave();
  }
  for (const b of document.querySelectorAll('[data-view]'))
    b.onclick = () => view(b.dataset.view);
  function chatModel(c) {
    return (
      (prefs().modelByChat || {})[c.id] || prefs().model || 'deepseek-chat'
    );
  }
  function setChatModel(c, id) {
    const m = prefs().modelByChat || (prefs().modelByChat = {});
    m[c.id] = id;
    prefs().model = id;
    queueWorkspaceSave();
  }
  function chatDraft(c) {
    return (prefs().chatDrafts || {})[c.id] || '';
  }
  function setChatDraft(c, v) {
    const d = prefs().chatDrafts || (prefs().chatDrafts = {});
    d[c.id] = v;
    queueWorkspaceSave();
  }
  function currentChats() {
    const q = ($('chat-search').value || '').toLowerCase();
    const showArch = $('show-archived').checked;
    return chats
      .filter((c) => (showArch ? !!c.archived : !c.archived))
      .filter(
        (c) =>
          !q ||
          ((c.title || '') + ' ' + c.messages.map((m) => m.content).join(' '))
            .toLowerCase()
            .includes(q),
      )
      .sort(
        (a, b) =>
          (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
          (b.updatedAt || 0) - (a.updatedAt || 0),
      );
  }
  function renderChatList() {
    const list = $('chat-list');
    list.replaceChildren();
    for (const c of currentChats()) {
      const b = el('button');
      b.classList.toggle('selected', c.id === current?.id);
      b.classList.toggle('quiet', !!c.archived);
      const t = el(
        'span',
        null,
        (c.pinned ? '★ ' : '') + (c.title || 'Untitled'),
      );
      b.append(t);
      const meta = el('span', 'badge', c.archived ? 'archived' : '');
      if (c.archived) b.append(meta);
      b.onclick = run(async () => {
        if (current && current !== c) {
          setChatDraft(current, $('prompt').value);
        }
        current = c;
        render();
        view('chat');
        restoreCurrentDraft();
      });
      list.append(b);
    }
  }
  function renderMessages() {
    const m = $('messages');
    m.replaceChildren();
    if (!current || !current.messages.length) {
      const w = el('div', 'welcome');
      w.append(el('div', 'orb', '✦'));
      w.append(el('h2', null, 'A little curiosity. A lot of possibility.'));
      w.append(
        el(
          'p',
          null,
          'Think through a problem, build something new, or bring your repository into the conversation. Your next idea starts here.',
        ),
      );
      const s = el('div', 'suggestions');
      for (const p of [
        'Help me plan a feature',
        'Explain a code snippet',
        'Review my approach',
      ]) {
        const b = el('button', null, p);
        b.onclick = () => {
          $('prompt').value = p;
          $('prompt').focus();
        };
        s.append(b);
      }
      w.append(s);
      m.append(w);
      return;
    }
    for (const msg of current.messages) {
      const art = el('article', `message ${msg.role}`);
      art.append(el('div', 'author', msg.role === 'user' ? 'You' : 'DeepSeek'));
      renderContent(art, msg.content);
      if (msg.role === 'assistant') {
        const cp = el('button', null, 'Copy');
        cp.onclick = run(async () => {
          await navigator.clipboard.writeText(msg.content);
          status('Response copied.');
        });
        art.append(cp);
      }
      m.append(art);
    }
    m.scrollTop = m.scrollHeight;
  }
  function renderContent(art, content) {
    const parts = String(content).split(/```/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const lines = part.replace(/^[a-zA-Z0-9+#-]*\n/, '');
        const pre = el('pre', 'code', lines);
        art.append(pre);
        const cp = el('button', null, 'Copy code');
        cp.onclick = run(async () => {
          await navigator.clipboard.writeText(lines);
          status('Code copied.');
        });
        art.append(cp);
      } else if (part.trim()) {
        const pre = el('pre', null, part);
        art.append(pre);
      }
    });
  }
  function updateComposerMeta() {
    const t = $('prompt').value;
    $('prompt-meta').textContent =
      `${t.length} chars · ~${Math.ceil(t.length / 4)} tokens · Ctrl+Enter send`;
  }
  function restoreCurrentDraft() {
    if (!current) return;
    $('prompt').value = chatDraft(current);
    const model = chatModel(current);
    if (![...$('model').options].some((o) => o.value === model))
      $('model').append(opt(model));
    $('model').value = model;
    prefs().currentChatId = current.id;
    updateComposerMeta();
    $('retry').hidden = !current.messages.some((m) => m.role === 'user');
  }
  function render() {
    renderChatList();
    renderMessages();
    restoreCurrentDraft();
    updateDirtyState();
    updateEditorMeta();
  }
  $('chat-search').oninput = () => renderChatList();
  $('show-archived').onchange = () => renderChatList();
  $('prompt').oninput = () => {
    if (current) setChatDraft(current, $('prompt').value);
    updateComposerMeta();
  };
  $('prompt').onkeydown = (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      $('chat-form').requestSubmit();
    }
  };
  $('model').onchange = () => {
    if (current) setChatModel(current, $('model').value);
  };
  function newChat() {
    current = {
      id: crypto.randomUUID(),
      title: 'New conversation',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    chats.unshift(current);
    render();
    view('chat');
    drainChats();
  }
  function drainChats() {
    chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    queueSaveChats();
  }
  function queueSaveChats() {
    const snapshot = JSON.parse(JSON.stringify(chats));
    return enqueueSave(() => api.saveChats(snapshot));
  }

  $('new-chat').onclick = run(async () => {
    if (current) setChatDraft(current, $('prompt').value);
    newChat();
    await saveQueue;
  });
  $('delete-chat').onclick = run(async () => {
    if (busy) throw new Error('Stop the response first.');
    if (!current) return;
    if (!confirm('Delete this locally saved conversation?')) return;
    delete (prefs().chatDrafts || {})[current.id];
    chats = chats.filter((c) => c.id !== current.id);
    current = chats[0] || null;
    if (!current) newChat();
    else {
      render();
      queueSaveChats();
    }
  });
  $('pin-chat').onclick = run(async () => {
    if (!current) return;
    current.pinned = !current.pinned;
    render();
    queueSaveChats();
    status(current.pinned ? 'Pinned.' : 'Unpinned.');
  });
  $('archive-chat').onclick = run(async () => {
    if (!current) return;
    current.archived = !current.archived;
    render();
    queueSaveChats();
    status(current.archived ? 'Archived.' : 'Unarchived.');
  });
  $('rename-chat').onclick = run(async () => {
    if (!current) return;
    $('rename-input').value = current.title || '';
    if ($('rename-dialog').showModal) $('rename-dialog').showModal();
    $('rename-input').focus();
  });
  $('rename-form').onsubmit = run(async (e) => {
    e.preventDefault();
    if (!current) return;
    const v = $('rename-input').value.trim();
    if (v) current.title = v;
    $('rename-dialog').close();
    render();
    queueSaveChats();
  });
  $('rename-cancel').onclick = () => $('rename-dialog').close();
  $('help').onclick = () => {
    if ($('help-dialog').showModal) $('help-dialog').showModal();
  };
  async function doSend(content, retry = false) {
    if (busy) return;
    const target = current;
    const previous = target.messages.slice();
    if (retry) {
      const last = target.messages.map((m) => m.role).lastIndexOf('user');
      if (last < 0) return;
      target.messages = target.messages.slice(0, last + 1);
    } else target.messages.push({ role: 'user', content });
    if (target.title === 'New conversation')
      target.title = content.slice(0, 38);
    const model = chatModel(target);
    const messages = target.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const previousDraft = chatDraft(target);
    $('prompt').value = '';
    setChatDraft(target, '');
    busy = true;
    stopRequested = false;
    $('send').disabled = true;
    $('retry').disabled = true;
    $('stop').hidden = false;
    render();
    let received = false;
    try {
      await queueSaveChats();
      if (stopRequested) throw Error('Response stopped before sending.');
      status('DeepSeek is thinking…');
      const response = await api.send({ model, messages });
      target.messages.push({ role: 'assistant', content: response });
      received = true;
      target.updatedAt = Date.now();
      await queueSaveChats();
      status('Response saved locally.');
    } catch (error) {
      if (!received) {
        target.messages = previous;
        setChatDraft(target, retry ? previousDraft : content);
        await queueSaveChats();
      }
      throw error;
    } finally {
      busy = false;
      $('send').disabled = false;
      $('retry').disabled = false;
      $('stop').hidden = true;
      render();
    }
  }
  $('chat-form').onsubmit = run(async (e) => {
    e.preventDefault();
    if (busy) return;
    const content = $('prompt').value.trim();
    if (!content) return;
    if (!current) newChat();
    await doSend(content);
  });
  $('retry').onclick = run(async () => {
    if (current && !busy) await doSend('', true);
  });
  $('stop').onclick = run(async () => {
    stopRequested = true;
    await api.cancel();
    status('Stopping response…');
  });

  for (const b of document.querySelectorAll('[data-template]'))
    b.onclick = run(async () => {
      const t = b.dataset.template;
      $('prompt').value =
        (t === 'Explain' ? 'Explain this code in detail:\n\n' : '') +
        (t === 'Review'
          ? 'Review this change for bugs, clarity, and risk:\n\n'
          : '') +
        (t === 'Tests' ? 'Write focused tests for this code:\n\n' : '') +
        (t === 'Refactor'
          ? 'Refactor this for clarity without changing behavior:\n\n'
          : '') +
        $('prompt').value;
      if (current) setChatDraft(current, $('prompt').value);
      updateComposerMeta();
      $('prompt').focus();
    });
  $('export-json').onclick = run(async () => {
    if (!current) return;
    const r = await api.exportChat({ format: 'json', chat: current });
    if (r && r.cancelled) return;
    status('Exported to ' + (r.path || 'file'));
    logActivity('export', current.title);
  });
  $('export-md').onclick = run(async () => {
    if (!current) return;
    const r = await api.exportChat({ format: 'markdown', chat: current });
    if (r && r.cancelled) return;
    status('Exported to ' + (r.path || 'file'));
    logActivity('export', current.title);
  });
  $('import-chat').onclick = run(async () => {
    const r = await api.importChat();
    if (!r || r.cancelled) return;
    const c = r.chat;
    c.id = crypto.randomUUID();
    if (Array.isArray(c.messages))
      c.messages = c.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
    chats.unshift(c);
    current = c;
    render();
    queueSaveChats();
    status('Imported conversation.');
    logActivity('import', c.title || '');
  });
  $('refresh-models').onclick = run(async () => {
    const models = await api.models();
    if (!models.length) throw new Error('No models returned for this account.');
    $('model').replaceChildren(...models.map((id) => opt(id, id)));
    status('Models refreshed.');
  });
  async function loadRepos(next) {
    if (next) {
      if (!reposState.hasMore) return;
    }
    const page = next ? reposState.page + 1 : 1;
    if (!prefs().hasGithub) throw new Error('Save a GitHub token first.');
    $('load-repos').disabled = true;
    try {
      const r = await api.repos({ page });
      reposState.items = next
        ? reposState.items.concat(r.items || [])
        : r.items || [];
      reposState.page = r.page || page;
      reposState.hasMore = !!r.hasMore;
      $('load-more-repos').disabled = !reposState.hasMore;
      fillOwners();
      renderRepoSelect();
      status(`Loaded ${reposState.items.length} repositories.`);
    } finally {
      $('load-repos').disabled = false;
    }
  }
  function mergeList(list, name) {
    list = list || [];
    return [name].concat(list.filter((x) => x !== name)).slice(0, 20);
  }
  function fillOwners() {
    const owners = [
      ...new Set(
        (reposState.items || [])
          .map((r) => (r.owner && r.owner.login ? r.owner.login : r.owner))
          .filter(Boolean),
      ),
    ];
    $('owner-filter').replaceChildren(
      opt('', 'All owners'),
      ...owners.map((o) => opt(o, o)),
    );
  }
  function visibleRepos() {
    let items = (reposState.items || []).slice();
    const q = ($('repo-filter').value || '').toLowerCase();
    const own = $('owner-filter').value;
    const vis = $('visibility-filter').value;
    const hide = $('hide-archived').checked;
    if (hide) items = items.filter((r) => !r.archived);
    if (own)
      items = items.filter((r) => {
        const o = r.owner && r.owner.login ? r.owner.login : r.owner;
        return o === own;
      });
    if (vis)
      items = items.filter((r) => (vis === 'private' ? r.private : !r.private));
    if (q)
      items = items.filter((r) =>
        (r.full_name + ' ' + (r.description || '')).toLowerCase().includes(q),
      );
    const fav = prefs().favorites || [];
    const sort = $('repo-sort').value;
    items.sort((a, b) => {
      const fa = fav.includes(a.full_name) ? 1 : 0,
        fb = fav.includes(b.full_name) ? 1 : 0;
      if (fa !== fb) return fb - fa;
      if (sort === 'recent')
        return (b.updated_at || '').localeCompare(a.updated_at || '');
      return a.full_name.localeCompare(b.full_name);
    });
    return items;
  }
  function renderRepoSelect() {
    const sel = $('repo');
    const keep = sel.value || prefs().selectedRepo || '';
    const items = visibleRepos();
    sel.replaceChildren(
      opt('', 'Choose a repository…'),
      ...items.map((r) =>
        opt(
          r.full_name,
          (prefs().favorites || []).includes(r.full_name)
            ? '★ ' + r.full_name
            : r.full_name,
        ),
      ),
    );
    sel.value = items.some((r) => r.full_name === keep) ? keep : '';
    showRepoMeta();
    renderFavorites();
  }
  function showRepoMeta() {
    const meta = reposState.items.find((r) => r.full_name === $('repo').value);
    $('repo-badge').textContent = meta
      ? [
          meta.private ? 'Private' : 'Public',
          meta.default_branch,
          meta.language || '',
          meta.archived ? 'Archived' : '',
          meta.description || '',
        ]
          .filter(Boolean)
          .join(' · ')
      : 'Choose a repository to browse';
  }
  async function selectRepo(name) {
    await persistEditorDraft();
    resetEditor();
    clearRepositoryPanels();
    $('repo').value = name;
    prefs().selectedRepo = name;
    prefs().recentRepos = mergeList(prefs().recentRepos, name);
    await queueWorkspaceSave();
    branchesState = { items: [], page: 0, hasMore: false };
    $('branch').replaceChildren();
    showRepoMeta();
    renderFavorites();
    if (name) await loadBranches(false);
  }

  $('load-repos').onclick = run(() => loadRepos(false));
  $('load-more-repos').onclick = run(() => loadRepos(true));
  $('repo-filter').oninput = renderRepoSelect;
  $('owner-filter').onchange = renderRepoSelect;
  $('visibility-filter').onchange = renderRepoSelect;
  $('hide-archived').onchange = renderRepoSelect;
  $('repo-sort').onchange = renderRepoSelect;
  $('repo').onchange = run(() =>
    withCodeLock(() => selectRepo($('repo').value)),
  );

  $('favorite-repo').onclick = run(async () => {
    const name = $('repo').value;
    if (!name) throw new Error('Pick a repository first.');
    const f = prefs().favorites || (prefs().favorites = []);
    const i = f.indexOf(name);
    if (i >= 0) f.splice(i, 1);
    else f.unshift(name);
    renderRepoSelect();
    status(i >= 0 ? 'Removed favorite.' : 'Favorited ' + name);
    renderFavorites();
    await queueWorkspaceSave();
  });
  function renderFavorites() {
    for (const [id, values] of [
      ['favorite-list', prefs().favorites || []],
      ['recent-list', prefs().recentRepos || []],
    ]) {
      const box = $(id);
      box.replaceChildren();
      for (const name of values) {
        const b = el('button', null, name);
        b.onclick = run(() =>
          withCodeLock(async () => {
            if (![...$('repo').options].some((o) => o.value === name))
              $('repo').append(opt(name));
            await selectRepo(name);
          }),
        );
        box.append(b);
      }
    }
    syncChecklist();
  }

  async function loadBranches(next) {
    const repo = $('repo').value;
    if (!repo) throw Error('Pick a repository first.');
    if (next && !branchesState.hasMore) return;
    const previous = $('branch').value;
    const result = await api.branches({
      repo,
      page: next ? branchesState.page + 1 : 1,
    });
    branchesState = {
      items: next ? branchesState.items.concat(result.items) : result.items,
      page: result.page,
      hasMore: result.hasMore,
    };
    $('branch').replaceChildren(
      ...branchesState.items.map((b) =>
        opt(b.name, b.name + (b.protected ? ' [protected]' : '')),
      ),
    );
    const names = branchesState.items.map((b) => b.name);
    const meta = reposState.items.find((r) => r.full_name === repo);
    $('branch').value =
      next && names.includes(previous)
        ? previous
        : names.includes('dev')
          ? 'dev'
          : names.includes(meta?.default_branch)
            ? meta.default_branch
            : names[0] || '';
    $('load-more-branches').disabled = !result.hasMore;
    updateEditorAccess();
    status('Loaded ' + names.length + ' branches.');
  }
  $('branch').onchange = run(() =>
    withCodeLock(async () => {
      await persistEditorDraft();
      resetEditor();
      clearRepositoryPanels();
      updateEditorAccess();
    }),
  );

  $('load-branches').onclick = run(() => loadBranches(false));
  $('load-more-branches').onclick = run(() => loadBranches(true));
  $('create-dev').onclick = run(async () => {
    const repo = $('repo').value;
    const source = $('branch').value || 'dev';
    if (!repo) throw new Error('Pick a repository first.');
    const r = await api.createDev({ repo, source });
    if (r && r.cancelled) return;
    status('Created dev from ' + source + '.');
    logActivity('create-dev', repo);
    await loadBranches(false);
    $('branch').value = 'dev';
    updateEditorAccess();
  });
  $('open-repo').onclick = run(async () => {
    const repo = $('repo').value;
    if (!repo) throw new Error('Pick a repository first.');
    await api.openGithub({ repo, kind: 'repo' });
    logActivity('open', repo);
  });
  $('open-pulls').onclick = run(async () => {
    const repo = $('repo').value;
    if (!repo) throw new Error('Pick a repository first.');
    await api.openGithub({ repo, kind: 'pulls' });
  });
  $('open-compare').onclick = run(async () => {
    const repo = $('repo').value;
    if (!repo) throw new Error('Pick a repository first.');
    const meta = (reposState.items || []).find((x) => x.full_name === repo);
    const base = meta ? meta.default_branch : 'main';
    await api.openGithub({ repo, kind: 'compare', ref: base });
    logActivity('open-compare', repo);
  });
  $('open-file').onclick = run(async () => {
    const context = editorDraft();
    const repo = context?.repo;
    const path = context?.path;
    if (!repo || !path) throw new Error('Pick a repo and file.');
    await api.openGithub({
      repo,
      kind: 'file',
      path,
      ref: context.ref,
    });
  });
  async function browse(path, ref) {
    const repo = $('repo').value.trim();
    if (!repo) throw new Error('Pick a repository first.');
    ref = ref || $('branch').value || 'dev';
    const files = await api.list({ repo, path, ref });
    folder = path || '';
    filteredFiles = files
      .slice()
      .sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === 'dir'
            ? -1
            : 1,
      );
    $('directory').textContent = '/' + folder;
    renderBreadcrumb(repo, ref);
    renderFiles(repo, ref);
    status(`Browsing ${repo}:${ref}${folder ? '/' + folder : ''}.`);
  }
  function renderBreadcrumb(repo, ref) {
    const bc = $('breadcrumb');
    bc.replaceChildren();
    const root = el('button', null, repo + '@' + ref);
    root.onclick = run(async () => {
      try {
        await enterDir('');
      } catch (e) {
        toastErr(e);
      }
    });
    bc.append(root);
    const parts = folder ? folder.split('/') : [];
    let acc = '';
    for (const p of parts) {
      acc = acc ? acc + '/' + p : p;
      const b = el('button', null, p);
      const target = acc;
      b.onclick = run(async () => {
        await enterDir(target);
      });
      bc.append(el('span', null, '/'), b);
    }
  }
  async function loadFile(repo, path, ref, restore = true) {
    await persistEditorDraft();
    const result = await api.read({ repo, path, ref });
    const draft = restore ? restoreEditorDraft(repo, path, ref) : null;
    opened = { ...result, ref };
    editorContext = { repo, ref };
    original =
      draft?.sha && draft.sha !== result.sha ? draft.original : result.content;
    if (draft?.sha && draft.sha !== result.sha) opened.sha = draft.sha;
    $('file-path').value = path;
    $('file-path').readOnly = true;
    $('editor').value = draft ? draft.content : result.content;
    $('draft-status').textContent = draft
      ? 'Restored local draft; reload to discard it.'
      : '';
    reviewed = null;
    $('diff').hidden = true;
    updateDirtyState();
    updateEditorMeta();
    updateEditorAccess();
    prefs().lastEditor = { repo, path, ref };
    await queueWorkspaceSave();
    status('Loaded ' + path);
  }
  function renderFiles(repo, ref) {
    const q = $('file-filter').value.toLowerCase();
    const box = $('files');
    box.replaceChildren();
    const files = filteredFiles.filter(
      (f) => !q || f.name.toLowerCase().includes(q),
    );
    if (!files.length) box.append(el('p', 'muted', 'No files match.'));
    for (const f of files) {
      const b = el('button', 'file', (f.type === 'dir' ? '▸ ' : '· ') + f.name);
      if (f.type === 'file')
        b.append(
          el(
            'span',
            'file-size',
            ' ' +
              (f.size < 1024
                ? f.size + ' B'
                : (f.size / 1024).toFixed(1) + ' KB'),
          ),
        );
      b.onclick = run(() =>
        withCodeLock(() =>
          f.type === 'dir' ? browse(f.path, ref) : loadFile(repo, f.path, ref),
        ),
      );
      box.append(b);
    }
  }

  $('file-filter').oninput = () => {
    renderFiles($('repo').value, $('branch').value || 'dev');
  };
  async function enterDir(path) {
    await browse(path, $('branch').value || 'dev');
  }
  $('browse').onclick = run(async () => {
    const repo = $('repo').value;
    if (!repo) throw Error('Pick a repository first.');
    if (!branchesState.items.length) await loadBranches(false);
    await browse('', $('branch').value);
    prefs().recentRepos = mergeList(prefs().recentRepos, repo);
    prefs().selectedRepo = repo;
    await queueWorkspaceSave();
    renderFavorites();
  });

  $('up').onclick = run(async () => {
    await enterDir(folder.split('/').slice(0, -1).join('/'));
  });
  $('new-file').onclick = run(async () => {
    await persistEditorDraft();
    opened = null;
    editorContext = { repo: $('repo').value, ref: $('branch').value };
    original = '';
    reviewed = null;
    $('file-path').readOnly = false;
    $('file-path').value = '';
    $('editor').value = '';
    $('diff').hidden = true;
    $('file-path').focus();
    updateDirtyState();
    updateEditorMeta();
  });
  $('attach').onclick = () => {
    const path = $('file-path').value || 'untitled';
    $('prompt').value =
      `Please help me with this file.\n\nFile: ${path}\n\n\`\`\`\n${$('editor').value}\n\`\`\``;
    if (current) setChatDraft(current, $('prompt').value);
    updateComposerMeta();
    view('chat');
    status('File attached to your draft. Send it when ready.');
  };
  function proposal() {
    if (!editorContext || editorContext.ref !== 'dev')
      throw Error('Only files loaded from dev can be committed.');
    return {
      repo: editorContext.repo,
      path: $('file-path').value.trim(),
      content: $('editor').value,
      branch: 'dev',
      ...(opened ? { sha: opened.sha } : {}),
    };
  }
  function simpleDiffStats(a, b) {
    const al = a.split('\n'),
      bl = b.split('\n');
    let add = 0,
      del = 0;
    const max = Math.max(al.length, bl.length);
    for (let i = 0; i < max; i++) {
      if (al[i] === bl[i]) continue;
      if (al[i] == null) add++;
      else if (bl[i] == null) del++;
      else {
        add++;
        del++;
      }
    }
    return { add, del };
  }
  $('review').onclick = () => {
    const a = original || '',
      b = $('editor').value;
    $('before').textContent = a || '(new or empty file)';
    $('after').textContent = b;
    $('diff').hidden = false;
    reviewed = JSON.stringify(proposal());
    const s = simpleDiffStats(a, b);
    status(
      `Approximate changed lines: +${s.add} / -${s.del}. Review both versions, then enter a commit message.`,
    );
  };
  $('commit').onclick = run(async () => {
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
      if (result && result.cancelled) return;
      opened = { ...input, ref: 'dev', sha: result.sha };
      original = input.content;
      reviewed = null;
      $('file-path').readOnly = true;
      const d = drafts();
      delete d[draftKey(input.repo, input.path, input.branch)];
      queueWorkspaceSave();
      status('Committed to ' + input.repo + ':dev.');
      logActivity('commit', input.repo + '/' + input.path);
      updateDirtyState();
    } finally {
      $('commit').disabled = false;
    }
  });
  $('revert').onclick = () => {
    if (!confirm('Revert editor to last loaded content?')) return;
    $('editor').value = original;
    const k = editorDraft();
    if (k) {
      const d = drafts();
      delete d[draftKey(k.repo, k.path, k.ref)];
      queueWorkspaceSave();
    }
    reviewed = null;
    $('diff').hidden = true;
    updateDirtyState();
    updateEditorMeta();
    status('Reverted.');
  };
  $('reload').onclick = run(async () => {
    const k = editorDraft();
    if (!k) throw Error('No file loaded.');
    if (!discard()) return;
    const result = await api.read(k);
    opened = { ...result, ref: k.ref };
    original = result.content;
    $('editor').value = original;
    delete drafts()[draftKey(k.repo, k.path, k.ref)];
    reviewed = null;
    $('diff').hidden = true;
    await queueWorkspaceSave();
    updateDirtyState();
    updateEditorMeta();
    status('Reloaded from GitHub.');
  });

  $('copy-path').onclick = run(async () => {
    const p = $('file-path').value.trim();
    if (!p) throw new Error('No file path.');
    await navigator.clipboard.writeText(p);
    status('Copied ' + p);
  });
  $('find-open').onclick = () => {
    if ($('find-dialog').showModal) $('find-dialog').showModal();
    $('find-input').focus();
  };
  $('find-close').onclick = () => $('find-dialog').close();
  $('find-form').onsubmit = run(async (e) => {
    e.preventDefault();
    const q = $('find-input').value;
    const text = $('editor').value;
    if (!q) return;
    const start = matchIndex + 1;
    const i = text.indexOf(q, start);
    if (i < 0) {
      matchIndex = -1;
      throw new Error('No more matches.');
    }
    matchIndex = i;
    $('find-dialog').close();
    $('editor').focus();
    $('editor').setSelectionRange(i, i + q.length);
    status('Match at ' + (i + 1));
  });
  $('wrap-toggle').onclick = () => {
    const on = $('editor').classList.toggle('wrap');
    $('editor').classList.toggle('nowrap', !on);
    prefs().wrap = on;
    queueWorkspaceSave();
    $('wrap-toggle').textContent = 'Wrap: ' + (on ? 'on' : 'off');
  };
  $('tab-indent').onclick = () => {
    prefs().tabs = !prefs().tabs;
    queueWorkspaceSave();
    $('tab-indent').textContent = 'Tab: ' + (prefs().tabs ? 'tab' : 'spaces');
  };
  $('font-size').onchange = () => {
    const v = Math.min(
      24,
      Math.max(10, parseInt($('font-size').value, 10) || 13),
    );
    $('editor').style.fontSize = v + 'px';
    prefs().fontSize = v;
    queueWorkspaceSave();
  };
  function updateEditorMeta() {
    const t = $('editor').value;
    $('editor-meta').textContent =
      `${t.length} chars · ${t.split('\n').length} lines`;
  }
  function updateDirtyState() {
    const dirty = $('editor').value !== original;
    const b = $('dirty-indicator');
    b.textContent = dirty ? 'Dirty' : 'Clean';
    b.classList.toggle('dirty', dirty);
    b.classList.toggle('clean', !dirty);
  }
  $('editor').oninput = () => {
    updateDirtyState();
    updateEditorMeta();
    clearTimeout($('editor')._t);
    $('editor')._t = setTimeout(persistEditorDraft, 600);
  };
  $('editor').onkeydown = (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const t = e.target;
      const s = t.selectionStart,
        en = t.selectionEnd;
      const ind = prefs().tabs ? '\t' : '  ';
      t.value = t.value.slice(0, s) + ind + t.value.slice(en);
      t.selectionStart = t.selectionEnd = s + ind.length;
      $('editor').dispatchEvent(new Event('input'));
    }
  };
  function discard() {
    return (
      $('editor').value === original ||
      confirm('Discard unsaved editor changes?')
    );
  }
  $('load-commits').onclick = run(async () => {
    const repo = $('repo').value;
    if (!repo) throw new Error('Pick a repo.');
    const ref = $('branch').value || 'dev';
    const list = await api.commits({ repo, ref });
    const box = $('commit-list');
    box.replaceChildren();
    for (const c of list) {
      const row = el('div', 'list-row');
      row.textContent = `${c.sha.slice(0, 7)} ${c.message} — ${c.author || ''} ${c.date || ''}`;
      box.append(row);
    }
  });
  $('load-compare').onclick = run(async () => {
    const repo = $('repo').value;
    if (!repo) throw new Error('Pick a repo.');
    const meta = (reposState.items || []).find((x) => x.full_name === repo);
    const base = meta ? meta.default_branch : 'main';
    const r = await api.compare({ repo, base });
    const box = $('compare-box');
    box.replaceChildren();
    box.append(
      el(
        'div',
        'list-row',
        `ahead ${r.ahead}, behind ${r.behind} vs ${base}${r.truncated ? ' (truncated)' : ''}`,
      ),
    );
    for (const f of r.files || []) {
      box.append(
        el(
          'div',
          'list-row',
          `${f.status} ${f.filename} +${f.additions} -${f.deletions}`,
        ),
      );
    }
  });
  $('load-pulls').onclick = run(async () => {
    const repo = $('repo').value;
    if (!repo) throw new Error('Pick a repo.');
    const list = await api.pulls({ repo });
    const box = $('pulls-box');
    box.replaceChildren();
    for (const p of list) {
      const row = el('div', 'list-row');
      const link = el('button', null, '#' + p.number + ' ' + p.title);
      link.onclick = run(() =>
        api.openGithub({ repo, kind: 'pulls', number: p.number }),
      );
      row.append(
        link,
        el('span', null, p.draft ? ' draft' : ''),
        el('span', null, ' ' + p.state),
      );
      box.append(row);
    }
  });
  async function connections() {
    const s = await api.settings();
    $('connection-status').textContent =
      `DeepSeek: ${s.deepseek ? 'saved' : 'not connected'} · GitHub: ${s.github ? 'saved' : 'not connected'}`;
    $('version').textContent = 'v' + s.version;
    prefs().hasDeepseek = !!s.deepseek;
    prefs().hasGithub = !!s.github;
    syncChecklist();
    renderActivity();
  }
  $('settings-form').onsubmit = run(async (e) => {
    e.preventDefault();
    const input = {};
    if ($('deepseek-key').value.trim())
      input.deepseek = $('deepseek-key').value;
    if ($('github-token').value.trim()) input.github = $('github-token').value;
    await api.saveSettings(input);
    if (input.deepseek) prefs().deepseekTested = false;
    if (input.github) prefs().githubTested = false;
    $('deepseek-key').value = '';
    $('github-token').value = '';
    await connections();
    status('Connections saved. Test them before assuming access.');
  });
  $('clear-keys').onclick = run(async () => {
    if (!confirm('Remove both saved credentials?')) return;
    await api.saveSettings({ deepseek: '', github: '' });
    prefs().deepseekTested = false;
    prefs().githubTested = false;
    await connections();
    status('Credentials removed.');
  });
  $('test-github').onclick = run(async () => {
    const r = await api.testConnection({ service: 'github' });
    status('GitHub: ' + ((r && r.message) || 'ok'));
    prefs().githubTested = true;
    syncChecklist();
    queueWorkspaceSave();
    logActivity('test', 'github');
  });
  $('test-deepseek').onclick = run(async () => {
    const r = await api.testConnection({ service: 'deepseek' });
    status('DeepSeek: ' + ((r && r.message) || 'ok'));
    prefs().deepseekTested = true;
    syncChecklist();
    queueWorkspaceSave();
    logActivity('test', 'deepseek');
  });
  function syncChecklist() {
    $('setup-1').checked = !!prefs().hasDeepseek;
    $('setup-2').checked = !!prefs().hasGithub;
    $('setup-3').checked = !!(prefs().deepseekTested && prefs().githubTested);
    $('setup-4').checked = !!prefs().favorites?.length;
  }

  $('toggle-theme').onclick = () => {
    document.body.classList.toggle('light');
    prefs().light = document.body.classList.contains('light');
    queueWorkspaceSave();
    status('Theme updated.');
  };
  $('toggle-density').onclick = () => {
    document.body.classList.toggle('compact');
    prefs().compact = document.body.classList.contains('compact');
    queueWorkspaceSave();
  };
  $('diagnostics').onclick = run(async () => {
    const d = await api.diagnostics();
    $('diagnostics-out').textContent = JSON.stringify(d, null, 2);
  });
  $('open-data').onclick = run(async () => {
    await api.openDataFolder();
  });
  $('check-update').onclick = run(async () => {
    status(await api.checkUpdate());
    logActivity('update', 'check');
  });
  $('download-update').onclick = run(async () => {
    await api.downloadUpdate();
    logActivity('update', 'download');
  });
  $('install-update').onclick = run(async () => {
    if (busy || busyCode) throw new Error('Finish active work first.');
    if (confirm('Restart now? Save or commit editor changes first.')) {
      await flushAll();
      allowClose = true;
      try {
        await api.installUpdate();
      } catch (e) {
        allowClose = false;
        throw e;
      }
    }
  });
  let updateState = 'idle';
  function setUpdateState(state) {
    updateState = state;
    $('download-update').disabled = state !== 'available';
    $('install-update').disabled = state !== 'ready';
    $('check-update').disabled = ['checking', 'downloading'].includes(state);
  }
  api.onUpdate((msg) => {
    $('update-status').textContent = String(msg);
    $('update-progress').textContent = String(msg);
    if (msg.includes('Update ready')) setUpdateState('ready');
    else if (msg.includes('is available')) setUpdateState('available');
    else if (msg.includes('Downloading')) setUpdateState('downloading');
    else if (msg.includes('failed') || msg.includes('up to date'))
      setUpdateState('idle');
  });
  setUpdateState('idle');

  function renderActivity() {
    const box = $('activity-box');
    if (!box) return;
    box.replaceChildren();
    for (const a of (prefs().activityLog || []).slice(0, 40)) {
      box.append(el('div', 'list-row', `${a.at} ${a.kind} ${a.info}`));
    }
  }
  async function flushAll() {
    if (current) setChatDraft(current, $('prompt').value);
    await persistEditorDraft();
    await queueWorkspaceSave();
    await queueSaveChats();
    await saveQueue;
    if (saveError) throw saveError;
  }
  window.addEventListener('beforeunload', (e) => {
    if (allowClose) return;
    e.preventDefault();
    e.returnValue = '';
    if (busy || busyCode) {
      status('Finish or stop the current operation before closing.');
      return;
    }
    if (closing) return;
    closing = true;
    flushAll().then(
      () => {
        allowClose = true;
        window.close();
      },
      (error) => {
        closing = false;
        toastErr(error);
      },
    );
  });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      $('new-chat').click();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('chat-search').focus();
    } else if (
      (e.ctrlKey && e.key === '\u003f') ||
      (e.ctrlKey && e.shiftKey && e.key === '/')
    ) {
      e.preventDefault();
      $('help').click();
    } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      persistEditorDraft();
      status('Editor draft saved.');
    } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('find-open').click();
    }
  });
  run(async () => {
    workspace = await api.loadWorkspace();
    await connections();
    chats = await api.loadChats();
    ready = true;
    document.body.classList.toggle('light', !!prefs().light);
    document.body.classList.toggle('compact', !!prefs().compact);
    $('editor').classList.toggle('wrap', !!prefs().wrap);
    $('editor').classList.toggle('nowrap', !prefs().wrap);
    $('wrap-toggle').textContent = 'Wrap: ' + (prefs().wrap ? 'on' : 'off');
    $('font-size').value = prefs().fontSize || 13;
    $('editor').style.fontSize = (prefs().fontSize || 13) + 'px';
    if (chats.length)
      current = chats.find((c) => c.id === prefs().currentChatId) || chats[0];
    else newChat();
    const repo = prefs().selectedRepo;
    if (repo) {
      $('repo').replaceChildren(opt(repo));
      $('repo').value = repo;
    }
    const last = prefs().lastEditor;
    const draft = last && restoreEditorDraft(last.repo, last.path, last.ref);
    if (draft) {
      editorContext = { repo: draft.repo, ref: draft.ref };
      opened = draft.sha
        ? { repo: draft.repo, path: draft.path, ref: draft.ref, sha: draft.sha }
        : null;
      original = draft.original || '';
      $('repo').replaceChildren(opt(draft.repo));
      $('branch').replaceChildren(opt(draft.ref));
      $('file-path').value = draft.path;
      $('file-path').readOnly = !!opened;
      $('editor').value = draft.content;
      $('draft-status').textContent =
        'Restored local draft; reload to get the latest GitHub version.';
    }
    render();
    renderFavorites();
    renderDrafts();
    renderActivity();
    updateEditorAccess();
    view(
      ['chat', 'code', 'agent', 'settings'].includes(prefs().view)
        ? prefs().view
        : 'chat',
    );
  })();

  for (const id of [
    'load-repos',
    'load-more-repos',
    'load-branches',
    'load-more-branches',
    'create-dev',
    'browse',
    'up',
    'reload',
    'new-file',
    'commit',
    'load-commits',
    'load-compare',
    'load-pulls',
  ]) {
    const action = $(id).onclick;
    $(id).onclick = run((e) => withCodeLock(() => action(e)));
  }
  $('file-path').oninput = () => {
    reviewed = null;
    persistEditorDraft();
  };
  const oldCheck = $('check-update').onclick;
  $('check-update').onclick = run(async (e) => {
    setUpdateState('checking');
    try {
      await oldCheck(e);
    } finally {
      if (updateState === 'checking') setUpdateState('idle');
    }
  });
  const oldDownload = $('download-update').onclick;
  $('download-update').onclick = run(async (e) => {
    setUpdateState('downloading');
    await oldDownload(e);
    if (updateState === 'downloading') setUpdateState('available');
  });
})();
