'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { repoName, filePath, branchRef } = require('./core.cjs');
const WS_MAX_BYTES = 2 * 1024 * 1024;
const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_DRAFTS = 500;
const MAX_ACTIVITY = 200;
const MAX_CHAT_MESSAGES = 100;
const MAX_MESSAGE_CONTENT = 100000;
const MAX_DRAFT_CONTENT = 500000;
const GITHUB_OPEN = new Set(['repo', 'file', 'pulls', 'compare', 'releases']);
const DRAFT_KEYS = ['repo', 'path', 'ref', 'sha', 'content', 'original'];
const SHA_RE = /^[a-f0-9]{40}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function clamp(str, n) {
  return typeof str === 'string' ? str.slice(0, n) : '';
}

function byteLen(obj) {
  return Buffer.byteLength(JSON.stringify(obj === undefined ? null : obj));
}

function safeKey(k) {
  return (
    typeof k === 'string' &&
    k.length > 0 &&
    k.length <= 2048 &&
    ![...k].some((c) => c.charCodeAt(0) < 32) &&
    !FORBIDDEN_KEYS.has(k)
  );
}

function validateDraft(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = {};
  for (const key of DRAFT_KEYS) {
    if (!(key in v)) continue;
    const value = v[key];
    if (key === 'repo') d.repo = repoName(value);
    else if (key === 'path') {
      filePath(value);
      d.path = value;
    } else if (key === 'ref') d.ref = branchRef(value);
    else if (key === 'sha') {
      if (typeof value !== 'string' || !SHA_RE.test(value))
        throw new Error('Invalid file revision.');
      d.sha = value;
    } else {
      if (typeof value !== 'string')
        throw new Error('Draft content must be text.');
      if (Buffer.byteLength(value) > MAX_DRAFT_CONTENT)
        throw new Error('Draft is too large.');
      d[key] = value;
    }
  }
  if (!d.repo || !d.path) return null;
  return d;
}

function validateChat(input, opts) {
  if (!input || typeof input !== 'object') throw new Error('Chat is required.');
  const id = clamp(input.id, 200) || crypto.randomUUID();
  const title = clamp(input.title, 200) || 'Chat';
  const created = Number.isFinite(input.created) ? input.created : Date.now();
  const updated = Number.isFinite(input.updated) ? input.updated : created;
  const model = clamp(input.model, 100) || 'deepseek-chat';
  if (
    !Array.isArray(input.messages) ||
    input.messages.length > MAX_CHAT_MESSAGES
  )
    throw new Error(`Chat must have 1 to ${MAX_CHAT_MESSAGES} messages.`);
  const messages = input.messages.map((m) => {
    if (!m || typeof m !== 'object') throw new Error('Invalid message.');
    if (m.role !== 'user' && m.role !== 'assistant')
      throw new Error('Invalid message role.');
    if (
      typeof m.content !== 'string' ||
      m.content.length === 0 ||
      Buffer.byteLength(m.content) > MAX_MESSAGE_CONTENT
    )
      throw new Error('Invalid message content.');
    const out = { role: m.role, content: m.content };
    if (!opts || !opts.stripIds) {
      if (typeof m.id === 'string' && m.id) out.id = clamp(m.id, 100);
    }
    return out;
  });
  const chat = { id, title, created, updated, model, messages };
  for (const key of ['createdAt', 'updatedAt'])
    if (Number.isFinite(input[key])) chat[key] = input[key];
  if (typeof input.pinned === 'boolean') chat.pinned = input.pinned;
  else if (input.pinned === undefined && opts && opts.defaultPinned)
    chat.pinned = false;
  if (typeof input.archived === 'boolean') chat.archived = input.archived;
  else if (input.archived === undefined && opts && opts.defaultArchived)
    chat.archived = false;
  if (
    input.meta &&
    typeof input.meta === 'object' &&
    !Array.isArray(input.meta)
  )
    chat.meta = input.meta;
  if (typeof input.created === 'number' && Number.isFinite(input.created))
    chat.created = input.created;
  if (typeof input.updated === 'number' && Number.isFinite(input.updated))
    chat.updated = input.updated;
  if (byteLen(chat) > 500000) throw new Error('Chat is too large.');
  return chat;
}

function validateWorkspace(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Workspace must be an object.');
  if (byteLen(input) > WS_MAX_BYTES) throw new Error('Workspace exceeds 2 MB.');
  const out = { preferences: {}, drafts: {}, activity: [] };
  if (input.preferences !== undefined) {
    if (
      !input.preferences ||
      typeof input.preferences !== 'object' ||
      Array.isArray(input.preferences)
    )
      throw new Error('Invalid preferences.');
    const prefs = input.preferences;
    for (const k of Object.keys(prefs)) {
      if (!safeKey(k)) throw new Error('Invalid preference key.');
      const v = prefs[k];
      if (v === undefined) throw new Error('Invalid preference value.');
      if (byteLen(v) > 200000) throw new Error('Preference value too large.');
      out.preferences[k] = v;
    }
  }
  if (input.drafts !== undefined) {
    if (
      !input.drafts ||
      typeof input.drafts !== 'object' ||
      Array.isArray(input.drafts)
    )
      throw new Error('Invalid drafts.');
    const keys = Object.keys(input.drafts);
    for (const k of keys) {
      if (!safeKey(k)) throw new Error('Invalid draft key.');
      const d = validateDraft(input.drafts[k]);
      if (!d) continue;
      if (Object.keys(out.drafts).length >= MAX_DRAFTS)
        throw new Error('Too many drafts.');
      out.drafts[k] = d;
    }
  }
  if (input.activity !== undefined) {
    if (!Array.isArray(input.activity)) throw new Error('Invalid activity.');
    const slice =
      input.activity.length > MAX_ACTIVITY
        ? input.activity.slice(-MAX_ACTIVITY)
        : input.activity;
    if (input.activity.length > MAX_ACTIVITY)
      throw new Error('Too many activity entries.');
    for (const a of slice) {
      if (!a || typeof a !== 'object')
        throw new Error('Invalid activity entry.');
      out.activity.push({
        time: Number.isFinite(a.time) ? a.time : Date.now(),
        message: clamp(String(a.message || ''), 500),
      });
    }
  }
  if (byteLen(out) > WS_MAX_BYTES) throw new Error('Workspace exceeds 2 MB.');
  return out;
}

function safeNumber(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function registerServices({
  handle,
  request,
  readJson,
  atomicWrite,
  getWindow,
  dialog,
  shell,
  app,
}) {
  const dataPath = app.getPath('userData');
  const wsFile = 'workspace.json';

  async function gh(endpoint, opts) {
    const opts2 = Object.assign({ method: 'GET' }, opts || {});
    if (opts2.body !== undefined && typeof opts2.body !== 'string')
      opts2.body = JSON.stringify(opts2.body);
    return request('github', endpoint, opts2);
  }

  async function loadWorkspaceRaw() {
    return readJson(wsFile, { preferences: {}, drafts: {}, activity: [] });
  }

  const api = {
    repos: async (p) => {
      const page = safeNumber(p && p.page, 1);
      const r = await gh(
        `/user/repos?sort=updated&per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`,
      );
      const items = (Array.isArray(r) ? r : []).map((x) => ({
        full_name: x.full_name,
        description: clamp(x.description || '', 500),
        private: !!x.private,
        archived: !!x.archived,
        default_branch: clamp(x.default_branch || 'main', 250),
        owner: x.owner ? x.owner.login : '',
        language: x.language || null,
        updated_at: x.updated_at || null,
        push: !!(x.permissions && x.permissions.push),
      }));
      return { items, hasMore: items.length === 100, page };
    },
    branches: async (p) => {
      const repo = repoName(p && p.repo);
      const page = safeNumber(p && p.page, 1);
      const r = await gh(`/repos/${repo}/branches?per_page=100&page=${page}`);
      const items = (Array.isArray(r) ? r : []).map((x) => ({
        name: x.name,
        protected: !!x.protected,
      }));
      return { items, hasMore: items.length === 100, page };
    },
    createDev: async (p) => {
      const repo = repoName(p && p.repo);
      const source = branchRef(p && p.source);
      const win = getWindow();
      if (!dialog || !win) throw new Error('Create dev requires confirmation.');
      const res = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Cancel', 'Create dev'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: `Create the dev branch in ${repo}?`,
        detail: `Branch from ${source}. Existing dev will not be overwritten.`,
      });
      if (!res || res.response !== 1) return { cancelled: true };
      const ref = await gh(
        `/repos/${repo}/git/ref/heads/${encodeURIComponent(source)}`,
      );
      const sha = ref && ref.object && ref.object.sha;
      if (typeof sha !== 'string' || !SHA_RE.test(sha))
        throw new Error('Could not resolve source branch.');
      try {
        await gh(`/repos/${repo}/git/refs`, {
          method: 'POST',
          body: { ref: 'refs/heads/dev', sha },
        });
        return { created: true };
      } catch (e) {
        if (e && e.status === 422)
          throw new Error('dev branch already exists.', { cause: e });
        throw e;
      }
    },
    commits: async (p) => {
      const repo = repoName(p && p.repo);
      const ref = branchRef((p && p.ref) || 'dev');
      const r = await gh(
        `/repos/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=20`,
      );
      return (Array.isArray(r) ? r : []).map((x) => ({
        sha: x.sha,
        message: clamp((x.commit && x.commit.message) || '', 2000),
        date: (x.commit && x.commit.author && x.commit.author.date) || null,
        author: (x.commit && x.commit.author && x.commit.author.name) || '',
      }));
    },
    compare: async (p) => {
      const repo = repoName(p && p.repo);
      const base = branchRef((p && p.base) || 'main');
      const r = await gh(
        `/repos/${repo}/compare/${encodeURIComponent(base)}...dev`,
      );
      const files = (r && r.files) || [];
      return {
        ahead: (r && r.ahead_by) || 0,
        behind: (r && r.behind_by) || 0,
        files: files.slice(0, 300).map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        })),
        truncated: files.length >= 300 || (r && r.total_commits > 250),
      };
    },
    pulls: async (p) => {
      const repo = repoName(p && p.repo);
      const r = await gh(`/repos/${repo}/pulls?state=open&per_page=30`);
      return (Array.isArray(r) ? r : []).map((x) => ({
        number: x.number,
        title: clamp(x.title || '', 500),
        state: x.state,
        draft: !!x.draft,
        url: x.html_url,
      }));
    },
    openGithub: async (p) => {
      const repo = repoName(p && p.repo);
      const kind = p && p.kind;
      if (!GITHUB_OPEN.has(kind)) throw new Error('Invalid open target.');
      let url = `https://github.com/${repo}`;
      if (kind === 'file') {
        const fp = filePath(p && p.path);
        const ref = branchRef((p && p.ref) || 'main');
        url += `/blob/${encodeURIComponent(ref)}/${fp}`;
      } else if (kind === 'pulls') {
        const num =
          p && p.number !== undefined ? positiveNumber(p.number) : null;
        if (p && p.number !== undefined && num === null)
          throw new Error('Invalid PR number.');
        url += num ? `/pull/${num}` : '/pulls';
      } else if (kind === 'releases') {
        url += '/releases';
      } else if (kind === 'compare') {
        const base = branchRef((p && (p.base || p.ref)) || 'main');
        url += `/compare/${encodeURIComponent(base)}...dev`;
      }
      await shell.openExternal(url);
    },
    test: async (p) => {
      const service = p && p.service;
      if (!['github', 'deepseek'].includes(service))
        throw new Error('Unknown service.');
      if (service === 'github') {
        await request('github', '/user', {});
        return { message: 'GitHub connection OK.' };
      }
      await request('deepseek', '/models', {});
      return { message: 'DeepSeek connection OK.' };
    },
    loadWorkspace: async () => {
      const raw = await loadWorkspaceRaw();
      if (raw === undefined || raw === null || raw === '')
        return { preferences: {}, drafts: {}, activity: [] };
      let parsed = raw;
      if (typeof raw === 'string') parsed = JSON.parse(raw);
      return validateWorkspace(parsed);
    },
    saveWorkspace: async (p) => {
      const ws = validateWorkspace(p);
      await atomicWrite(wsFile, JSON.stringify(ws));
      return { saved: true };
    },
    exportChat: async (p) => {
      const format = p && p.format;
      if (!['json', 'markdown'].includes(format))
        throw new Error('Invalid format.');
      const chat = validateChat(p && p.chat, { stripIds: false });
      const win = getWindow();
      const ext = format === 'json' ? 'json' : 'md';
      const base = clamp(chat.title.replace(/[^\w.-]+/g, '_'), 60) || 'chat';
      const res = await dialog.showSaveDialog(win, {
        defaultPath: `${base}.${ext}`,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      });
      if (!res || res.canceled || !res.filePath) return { cancelled: true };
      let out;
      if (format === 'json') {
        out = JSON.stringify({ schemaVersion: 1, chat }, null, 2);
      } else {
        const lines = [`# ${chat.title}`, ''];
        for (const m of chat.messages)
          lines.push(`## ${m.role}`, '', m.content, '');
        out = lines.join('\n');
      }
      await fs.promises.writeFile(res.filePath, out, 'utf8');
      return { path: res.filePath };
    },
    importChat: async () => {
      const win = getWindow();
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!res || res.canceled || !res.filePaths || !res.filePaths[0])
        return { cancelled: true };
      if ((await fs.promises.stat(res.filePaths[0])).size > IMPORT_MAX_BYTES)
        throw new Error('File exceeds 2 MB.');
      const raw = await fs.promises.readFile(res.filePaths[0], 'utf8');
      if (Buffer.byteLength(raw) > IMPORT_MAX_BYTES)
        throw new Error('File exceeds 2 MB.');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('Invalid JSON.');
      }
      if (!parsed || parsed.schemaVersion !== 1 || !parsed.chat)
        throw new Error('Unsupported schema version.');
      const chat = validateChat(parsed.chat, { stripIds: true });
      chat.id = crypto.randomUUID();
      chat.messages = chat.messages.map((m) => ({
        role: m.role,
        content: m.content,
        id: crypto.randomUUID(),
      }));
      return { chat };
    },
    diagnostics: async () => ({
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      dataPath,
    }),
    openDataFolder: async () => {
      const err = await shell.openPath(dataPath);
      if (typeof err === 'string' && err.length) throw new Error(err);
      return { opened: true };
    },
  };

  const channels = {
    'github:repos': api.repos,
    'github:branches': api.branches,
    'github:createDev': api.createDev,
    'github:commits': api.commits,
    'github:compare': api.compare,
    'github:pulls': api.pulls,
    'github:open': api.openGithub,
    'connection:test': api.test,
    'workspace:load': api.loadWorkspace,
    'workspace:save': api.saveWorkspace,
    'chat:export': api.exportChat,
    'chat:import': api.importChat,
    'app:diagnostics': api.diagnostics,
    'app:openDataFolder': api.openDataFolder,
  };

  const registered = {};
  for (const [ch, fn] of Object.entries(channels)) {
    registered[ch] = fn;
    handle(ch, async (payload) => fn(payload || {}));
  }
  return registered;
}

module.exports = {
  registerServices,
  validateChat,
  validateWorkspace,
  validateDraft,
};
