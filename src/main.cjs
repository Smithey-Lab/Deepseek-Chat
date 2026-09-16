const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  session,
} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const {
  text,
  repoName,
  filePath,
  commitInput,
  chatInput,
} = require('./core.cjs');
if (!app.isPackaged && process.env.DEEPSEEK_TEST_DATA) {
  app.setPath('userData', process.env.DEEPSEEK_TEST_DATA);
}
let window,
  secrets = {},
  activeChat,
  updateReady = false;
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
const dataFile = (name) => path.join(app.getPath('userData'), name);
async function atomicWrite(name, content) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(dataFile(`${name}.tmp`), content);
  await fs.rename(dataFile(`${name}.tmp`), dataFile(name));
}
async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(dataFile(name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${name}. Your data has been preserved.`, {
      cause: error,
    });
  }
}
function handle(channel, action) {
  ipcMain.handle(channel, async (event, input) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== page
    )
      throw new Error('Untrusted request.');
    return action(input);
  });
}
async function request(service, endpoint, options = {}) {
  const key = service === 'github' ? secrets.github : secrets.deepseek;
  if (!key)
    throw new Error(
      `Add your ${service === 'github' ? 'GitHub token' : 'DeepSeek API key'} in Settings first.`,
    );
  const response = await fetch(
    (service === 'github'
      ? 'https://api.github.com'
      : 'https://api.deepseek.com') + endpoint,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(service === 'github'
          ? {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            }
          : {}),
      },
      signal: options.signal || AbortSignal.timeout(60000),
    },
  );
  if (!response.ok)
    throw new Error(
      `${service} request failed (${response.status}). ${response.status === 409 ? 'The file changed remotely. Reload before committing.' : response.status === 404 ? 'Repository, dev branch, or file not found. Check access and create dev first.' : 'Check credentials, permissions, model, and account limits.'}`,
    );
  return response.json();
}
function updateStatus(message) {
  if (window && !window.isDestroyed())
    window.webContents.send('update:status', message);
}
app
  .whenReady()
  .then(async () => {
    const encrypted = await readJson('credentials.json', {});
    for (const name of ['deepseek', 'github']) {
      if (encrypted[name])
        secrets[name] = safeStorage.decryptString(
          Buffer.from(encrypted[name], 'base64'),
        );
    }
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    handle('settings:get', () => ({
      deepseek: !!secrets.deepseek,
      github: !!secrets.github,
      version: app.getVersion(),
    }));
    handle('settings:save', async (input) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('Windows credential encryption is unavailable.');
      const next = { ...secrets },
        stored = {};
      for (const name of ['deepseek', 'github']) {
        if (input[name] !== undefined) {
          if (typeof input[name] !== 'string' || input[name].length > 1000)
            throw new Error('Invalid credential.');
          next[name] = input[name].trim();
        }
        if (next[name])
          stored[name] = safeStorage
            .encryptString(next[name])
            .toString('base64');
      }
      await atomicWrite('credentials.json', JSON.stringify(stored));
      secrets = next;
      return true;
    });
    handle('chat:load', () => readJson('conversations.json', []));
    handle('chat:save', async (input) => {
      if (!Array.isArray(input) || JSON.stringify(input).length > 10000000)
        throw new Error(
          'Chat history exceeds 10 MB. Delete older conversations.',
        );
      await atomicWrite('conversations.json', JSON.stringify(input));
    });
    handle('chat:models', async () =>
      (await request('deepseek', '/models')).data.map((model) => model.id),
    );
    handle('chat:send', async (input) => {
      if (activeChat) throw new Error('A response is already in progress.');
      const body = chatInput(input);
      activeChat = new AbortController();
      try {
        const result = await request('deepseek', '/chat/completions', {
          method: 'POST',
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            activeChat.signal,
            AbortSignal.timeout(180000),
          ]),
        });
        return text(
          result.choices?.[0]?.message?.content,
          'API response',
          500000,
        );
      } finally {
        activeChat = undefined;
      }
    });
    handle('chat:cancel', () => activeChat?.abort());
    handle('github:list', async (input) => {
      const repo = repoName(input.repo);
      const location = input.path ? '/' + filePath(input.path) : '';
      const result = await request(
        'github',
        `/repos/${repo}/contents${location}?ref=dev`,
      );
      if (!Array.isArray(result)) throw new Error('Choose a directory.');
      return result
        .filter((item) => ['file', 'dir'].includes(item.type))
        .map(({ name, path, type, size }) => ({ name, path, type, size }));
    });
    handle('github:read', async (input) => {
      const result = await request(
        'github',
        `/repos/${repoName(input.repo)}/contents/${filePath(input.path)}?ref=dev`,
      );
      if (
        result.type !== 'file' ||
        result.encoding !== 'base64' ||
        result.size > 500000
      )
        throw new Error('Only text files up to 500 KB can be edited.');
      const bytes = Buffer.from(result.content, 'base64');
      let content;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('Only UTF-8 text files can be edited.');
      }
      if (content.includes('\0'))
        throw new Error('Binary files cannot be edited.');
      return { content, sha: result.sha, path: result.path, repo: input.repo };
    });
    handle('github:commit', async (input) => {
      const body = commitInput(input);
      const approval = await dialog.showMessageBox(window, {
        type: 'question',
        buttons: ['Cancel', 'Commit to dev'],
        defaultId: 0,
        cancelId: 0,
        title: 'Review commit',
        message: `Commit ${input.path} to ${input.repo}:dev?`,
        detail: `${input.message}\n\nThis publishes the editor contents to GitHub. Review the before/after view before continuing.`,
      });
      if (approval.response !== 1) return { cancelled: true };
      const result = await request(
        'github',
        `/repos/${input.repo}/contents/${filePath(input.path)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
      return { sha: result.content.sha, url: result.commit.html_url };
    });
    handle('update:check', async () => {
      if (!app.isPackaged)
        return 'Updates are available in the installed app. Publish a release first.';
      await autoUpdater.checkForUpdates();
      return 'Update check complete.';
    });
    handle('update:download', async () => {
      if (!app.isPackaged) throw new Error('Install the packaged app first.');
      await autoUpdater.downloadUpdate();
    });
    handle('update:install', () => {
      if (!updateReady) throw new Error('Download an update first.');
      autoUpdater.quitAndInstall();
    });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('update-available', (info) =>
      updateStatus(
        `Version ${info.version} is available. Download when ready.`,
      ),
    );
    autoUpdater.on('update-not-available', () =>
      updateStatus('You are up to date.'),
    );
    autoUpdater.on('download-progress', (info) =>
      updateStatus(`Downloading update: ${Math.round(info.percent)}%`),
    );
    autoUpdater.on('update-downloaded', () => {
      updateReady = true;
      updateStatus(
        'Update ready. Save your work, then click Restart & install.',
      );
    });
    autoUpdater.on('error', () =>
      updateStatus(
        'Update failed. Check your connection and that a GitHub release exists.',
      ),
    );
    window = new BrowserWindow({
      width: 1320,
      height: 900,
      minWidth: 980,
      minHeight: 700,
      backgroundColor: '#10131b',
      title: 'DeepSeek Workspace',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await window.loadURL(page);
  })
  .catch((error) => {
    dialog.showErrorBox('Unable to start', error.message);
    app.quit();
  });
app.on('window-all-closed', () => {
  activeChat?.abort();
  app.quit();
});
