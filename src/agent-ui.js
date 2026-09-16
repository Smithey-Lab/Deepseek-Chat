(function () {
  'use strict';

  var bridge = window.workspace || {};
  var STORAGE_KEY = 'agent-ui-draft-v1';

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setFeedback(msg, isError) {
    var fb = $('agent-feedback');
    if (!fb) return;
    fb.textContent = msg == null ? '' : String(msg);
    fb.className = isError ? 'error' : '';
  }

  function clearFeedback() {
    setFeedback('', false);
  }

  function safeLocalGet() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
      return {};
    } catch {
      return {};
    }
  }

  function safeLocalSet(data) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore (quota / disabled)
    }
  }

  function saveDraft() {
    var repoEl = $('agent-repo');
    var modelEl = $('agent-model');
    var tasksEl = $('agent-tasks');
    var budgetEl = $('agent-budget');
    safeLocalSet({
      repo: repoEl ? repoEl.value || '' : '',
      model: modelEl ? modelEl.value || '' : '',
      tasks: tasksEl ? tasksEl.value || '' : '',
      budget: budgetEl ? budgetEl.value || '' : '',
    });
  }

  function restoreDraft() {
    var d = safeLocalGet();
    var repoEl = $('agent-repo');
    var modelEl = $('agent-model');
    var tasksEl = $('agent-tasks');
    var budgetEl = $('agent-budget');
    if (repoEl && typeof d.repo === 'string' && d.repo) {
      // only preselect if it still exists after repos load; store for later
      repoEl.setAttribute('data-saved-repo', d.repo);
      var repoOption = el('option', null, d.repo);
      repoOption.value = d.repo;
      repoEl.appendChild(repoOption);
    }
    if (tasksEl && typeof d.tasks === 'string') tasksEl.value = d.tasks;
    if (budgetEl && d.budget != null && d.budget !== '')
      budgetEl.value = d.budget;
    if (modelEl && typeof d.model === 'string' && d.model) {
      modelEl.setAttribute('data-saved-model', d.model);
      clear(modelEl);
      var modelOption = el('option', null, d.model);
      modelOption.value = d.model;
      modelEl.appendChild(modelOption);
    }
  }

  // -------- repository pagination --------
  var repoPage = 1;
  var loadedRepos = [];

  function repoFullName(r) {
    if (!r) return '';
    if (typeof r === 'string') return r;
    if (typeof r.full_name === 'string') return r.full_name;
    return '';
  }

  function fillRepoSelect() {
    var sel = $('agent-repo');
    if (!sel) return;
    var current = sel.value;
    var saved = sel.getAttribute('data-saved-repo') || current || '';
    clear(sel);
    var seen = {};
    for (var i = 0; i < loadedRepos.length; i++) {
      var full = repoFullName(loadedRepos[i]);
      if (!full || seen[full]) continue;
      seen[full] = true;
      var opt = document.createElement('option');
      opt.value = full;
      opt.textContent = full;
      sel.appendChild(opt);
    }
    if (saved) {
      var match = Array.prototype.some.call(sel.options, function (o) {
        return o.value === saved;
      });
      if (match) sel.value = saved;
    }
    sel.removeAttribute('data-saved-repo');
  }

  function fillModelSelect(models) {
    var sel = $('agent-model');
    if (!sel) return;
    var current = sel.getAttribute('data-saved-model') || sel.value || '';
    clear(sel);
    var list = Array.isArray(models) ? models : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m == null) continue;
      var opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = String(m);
      sel.appendChild(opt);
    }
    if (current) {
      var match = Array.prototype.some.call(sel.options, function (o) {
        return o.value === current;
      });
      if (match) sel.value = current;
    }
    sel.removeAttribute('data-saved-model');
  }

  function loadRepos(page) {
    if (typeof bridge.repos !== 'function') return Promise.resolve([]);
    return Promise.resolve(bridge.repos({ page: page })).then(function (list) {
      var arr = Array.isArray(list.items) ? list.items : [];
      $('agent-more-repos').disabled = !list.hasMore;
      if (page <= 1) {
        loadedRepos = arr.slice();
      } else {
        loadedRepos = loadedRepos.concat(arr);
      }
      fillRepoSelect();
      return arr;
    });
  }

  function onLoadRepos() {
    clearFeedback();
    repoPage = 1;
    loadRepos(1)
      .then(function () {
        setFeedback('Repositories loaded.', false);
      })
      .catch(function (e) {
        setFeedback('Failed to load repositories: ' + errMsg(e), true);
      });
  }

  function onMoreRepos() {
    clearFeedback();
    repoPage += 1;
    loadRepos(repoPage)
      .then(function (arr) {
        if (!arr.length) setFeedback('No more repositories.', false);
        else setFeedback('Loaded more repositories.', false);
      })
      .catch(function (e) {
        repoPage -= 1;
        setFeedback('Failed to load more repositories: ' + errMsg(e), true);
      });
  }

  function onUseRepo() {
    clearFeedback();
    var repoEl = $('agent-repo');
    if (!repoEl) return;
    var value = $('repo').value || '';
    if (!value) {
      setFeedback('No repository selected.', true);
      return;
    }
    if (
      !loadedRepos.some(function (r) {
        return repoFullName(r) === value;
      })
    )
      loadedRepos.push({ full_name: value });
    repoEl.setAttribute('data-saved-repo', value);
    fillRepoSelect();
    setFeedback('Using repository: ' + value, false);
    saveDraft();
  }

  function onLoadModels() {
    clearFeedback();
    if (typeof bridge.models !== 'function') {
      setFeedback('Model listing unavailable.', true);
      return;
    }
    Promise.resolve(bridge.models())
      .then(function (models) {
        fillModelSelect(models);
        setFeedback('Models loaded.', false);
      })
      .catch(function (e) {
        setFeedback('Failed to load models: ' + errMsg(e), true);
      });
  }

  // -------- run state --------
  var activeRunId = null;
  var activeStatus = null;
  var historyCache = {};
  var unsubscribe = null;

  var STATUS_ACTIVE = {
    running: true,
    publishing: true,
  };

  function isActiveStatus(status) {
    return !!STATUS_ACTIVE[status];
  }

  function errMsg(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    if (typeof e.message === 'string') return e.message;
    return String(e);
  }

  function parseTasks() {
    var ta = $('agent-tasks');
    if (!ta) return [];
    var lines = String(ta.value || '').split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t) out.push(t);
    }
    return out;
  }

  function parseBudget() {
    var b = $('agent-budget');
    var n = b ? Number(b.value) : 40;
    if (!isFinite(n)) n = 40;
    n = Math.round(n);
    if (n < 10) n = 10;
    if (n > 80) n = 80;
    if (b) b.value = String(n);
    return n;
  }

  function setStartDisabled(disabled) {
    var btn = $('agent-start');
    if (btn) btn.disabled = !!disabled;
  }

  function syncStartState() {
    var running = Object.values(historyCache).find(function (r) {
      return isActiveStatus(r.status);
    });
    setStartDisabled(starting || !!running);
    $('agent-cancel').disabled = !running || running.status === 'publishing';
  }

  function formatTime(ts) {
    if (ts == null || ts === '') return '';
    var d;
    if (typeof ts === 'number') d = new Date(ts);
    else d = new Date(String(ts));
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString();
  }

  var starting = false;
  function onStart() {
    clearFeedback();
    if (
      starting ||
      Object.values(historyCache).some(function (r) {
        return isActiveStatus(r.status);
      })
    ) {
      setFeedback('A run is already active.', true);
      setStartDisabled(true);
      return;
    }
    var repoEl = $('agent-repo');
    var repo = repoEl ? repoEl.value || '' : '';
    if (!repo) {
      setFeedback('Select a repository first.', true);
      return;
    }
    var tasks = parseTasks();
    if (!tasks.length) {
      setFeedback('Enter at least one task (one per line).', true);
      return;
    }
    var modelEl = $('agent-model');
    var model = modelEl ? modelEl.value || '' : '';
    var maxSteps = parseBudget();
    saveDraft();

    // disable synchronously to prevent double submit before promise resolves
    setStartDisabled(true);
    var payload = {
      repo: repo,
      tasks: tasks.join('\n'),
      model: model,
      maxSteps: maxSteps,
    };
    if (typeof bridge.agentStart !== 'function') {
      setFeedback('Agent start unavailable.', true);
      setStartDisabled(false);
      return;
    }
    starting = true;
    Promise.resolve(bridge.agentStart(payload))
      .then(function (run) {
        if (!run) {
          setStartDisabled(false);
          return;
        }
        if (run.cancelled) {
          setFeedback('Run cancelled by authorization.', false);
          setStartDisabled(false);
          return;
        }
        if (run.id) {
          activeRunId = run.id;
          activeStatus = run.status || 'running';
          syncStartState();
          loadDetail(run.id).catch(function () {});
          return refreshHistory();
        }
        setStartDisabled(false);
      })
      .catch(function (e) {
        setFeedback('Failed to start: ' + errMsg(e), true);
        setStartDisabled(false);
      })
      .finally(function () {
        starting = false;
        syncStartState();
      });
  }

  function onCancel() {
    clearFeedback();
    if (!activeRunId) {
      setFeedback('No active run to cancel.', true);
      return;
    }
    if (typeof bridge.agentCancel !== 'function') {
      setFeedback('Cancel unavailable.', true);
      return;
    }
    Promise.resolve(bridge.agentCancel())
      .then(function () {
        setFeedback('Cancel requested.', false);
      })
      .catch(function (e) {
        setFeedback('Failed to cancel: ' + errMsg(e), true);
      });
  }

  function refreshHistory() {
    if (typeof bridge.agentList !== 'function') return Promise.resolve([]);
    return Promise.resolve(bridge.agentList()).then(function (list) {
      historyCache = {};
      list.forEach(function (r) {
        historyCache[r.id] = r;
      });
      syncStartState();
      renderHistory(list);
      if (!activeRunId && list.length) selectRun(list[0].id);
      return list;
    });
  }

  function onRefresh() {
    clearFeedback();
    refreshHistory()
      .then(function () {
        if (activeRunId) {
          loadDetail(activeRunId).catch(function () {});
        }
      })
      .catch(function (e) {
        setFeedback('Failed to refresh: ' + errMsg(e), true);
      });
  }

  function statusClass(status) {
    return (
      'agent-status agent-status-' +
      String(status || 'unknown').replace(/[^a-z0-9_-]/gi, '')
    );
  }

  function renderHistory(list) {
    var hist = $('agent-history');
    if (!hist) return;
    var arr = Array.isArray(list) ? list.slice() : [];
    // sort newest first by updatedAt
    arr.sort(function (a, b) {
      var ta = a && a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      var tb = b && b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });
    clear(hist);
    if (!arr.length) {
      hist.appendChild(el('div', 'agent-empty', 'No agent runs yet.'));
      return;
    }
    for (var i = 0; i < arr.length; i++) {
      (function (run) {
        if (!run || !run.id) return;
        historyCache[run.id] = run;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'agent-history-item';
        if (run.id === activeRunId) btn.setAttribute('data-active', 'true');
        var title = el('span', 'agent-history-title', run.repo || '(repo)');
        var st = el('span', statusClass(run.status), run.status || '');
        var meta = el(
          'span',
          'agent-history-meta',
          formatTime(run.updatedAt || run.startedAt),
        );
        btn.appendChild(title);
        btn.appendChild(st);
        btn.appendChild(meta);
        btn.addEventListener('click', function () {
          // user explicitly switched selection
          selectRun(run.id);
        });
        hist.appendChild(btn);
      })(arr[i]);
    }
  }

  function selectRun(id) {
    if (!id) return;
    activeRunId = id;
    var cached = historyCache[id];
    if (cached) {
      activeStatus = cached.status || activeStatus;
      renderRun(cached);
      syncStartState();
    }
    loadDetail(id).catch(function (e) {
      setFeedback('Failed to load run: ' + errMsg(e), true);
    });
  }

  function loadDetail(id) {
    if (!id || typeof bridge.agentGet !== 'function')
      return Promise.resolve(null);
    return Promise.resolve(bridge.agentGet({ id: id })).then(function (run) {
      if (!run) return null;
      // Only adopt status changes for this run; do not steal user selection.
      historyCache[run.id] = run;
      if (run.id === activeRunId) {
        activeStatus = run.status || activeStatus;
        renderRun(run);
        syncStartState();
      }
      return run;
    });
  }

  function renderRun(run) {
    var detail = $('agent-detail');
    if (!detail) return;
    clear(detail);
    if (!run) {
      detail.appendChild(
        el('div', 'agent-empty', 'Select a run to see details.'),
      );
      return;
    }
    var header = el('div', 'agent-detail-header');
    header.appendChild(el('h3', null, run.repo || '(repo)'));
    header.appendChild(el('span', statusClass(run.status), run.status || ''));
    detail.appendChild(header);

    var facts = el('ul', 'agent-facts');
    facts.appendChild(factRow('ID', run.id));
    facts.appendChild(factRow('Model', run.model));
    facts.appendChild(factRow('Max steps', run.maxSteps));
    facts.appendChild(factRow('Started', formatTime(run.startedAt)));
    facts.appendChild(factRow('Updated', formatTime(run.updatedAt)));
    facts.appendChild(factRow('Requests', run.requests));
    facts.appendChild(
      factRow(
        'Usage',
        typeof run.usage === 'object' && run.usage
          ? JSON.stringify(run.usage)
          : run.usage,
      ),
    );
    facts.appendChild(factRow('Base SHA', run.baseSha));
    facts.appendChild(factRow('Commit SHA', run.commitSha));
    detail.appendChild(facts);

    if (run.error) {
      var errBox = el('div', 'agent-error', 'Error: ' + String(run.error));
      detail.appendChild(errBox);
    }
    if (run.summary) {
      var sumBox = el('div', 'agent-summary');
      sumBox.appendChild(el('strong', null, 'Summary'));
      sumBox.appendChild(el('p', null, String(run.summary)));
      detail.appendChild(sumBox);
    }

    // Tasks
    var tasksWrap = el('details', 'agent-section agent-tasks-section');
    tasksWrap.open = true;
    var tasksSummary = el(
      'summary',
      null,
      'Tasks (' + (Array.isArray(run.tasks) ? run.tasks.length : 0) + ')',
    );
    tasksWrap.appendChild(tasksSummary);
    var taskList = el('ol', 'agent-task-list');
    var tasks = Array.isArray(run.tasks) ? run.tasks : [];
    for (var i = 0; i < tasks.length; i++) {
      taskList.appendChild(el('li', null, typecast(tasks[i])));
    }
    tasksWrap.appendChild(taskList);
    detail.appendChild(tasksWrap);

    // Task results
    var results = Array.isArray(run.taskResults) ? run.taskResults : [];
    var resWrap = el('details', 'agent-section agent-results-section');
    var resSummary = el(
      'summary',
      null,
      'Task results (' + results.length + ')',
    );
    resWrap.appendChild(resSummary);
    for (var r = 0; r < results.length; r++) {
      var item = results[r] || {};
      var itemWrap = el('div', 'agent-task-result');
      var itemHead = el('div', 'agent-task-result-head');
      itemHead.appendChild(el('span', 'agent-task-text', typecast(item.task)));
      itemHead.appendChild(
        el('span', statusClass(item.status), item.status || ''),
      );
      itemWrap.appendChild(itemHead);
      if (item.detail) {
        itemWrap.appendChild(
          el('pre', 'agent-task-detail', String(item.detail)),
        );
      }
      resWrap.appendChild(itemWrap);
    }
    if (!results.length)
      resWrap.appendChild(el('div', 'agent-empty', 'No task results.'));
    detail.appendChild(resWrap);

    // Log (collapsed)
    var logs = Array.isArray(run.log) ? run.log : [];
    var logWrap = el('details', 'agent-section agent-log-section');
    var logSummary = el('summary', null, 'Log (' + logs.length + ')');
    logWrap.appendChild(logSummary);
    var logList = el('div', 'agent-log-list');
    for (var l = 0; l < logs.length; l++) {
      var entry = logs[l] || {};
      var line = el('div', 'agent-log-line');
      line.appendChild(el('span', 'agent-log-time', formatTime(entry.time)));
      line.appendChild(
        el('span', 'agent-log-message', typecast(entry.message)),
      );
      logList.appendChild(line);
    }
    if (!logs.length)
      logList.appendChild(el('div', 'agent-empty', 'No log entries.'));
    logWrap.appendChild(logList);
    detail.appendChild(logWrap);

    // Changes (readonly diffs)
    var changes = Array.isArray(run.changes) ? run.changes : [];
    var chWrap = el('details', 'agent-section agent-changes-section');
    var chSummary = el(
      'summary',
      null,
      'Changes (test execution NOT performed) (' + changes.length + ')',
    );
    chWrap.appendChild(chSummary);
    var note = el(
      'p',
      'agent-note',
      'Test execution NOT performed. Diffs are read-only.',
    );
    chWrap.appendChild(note);
    for (var c = 0; c < changes.length; c++) {
      chWrap.appendChild(renderChange(changes[c]));
    }
    if (!changes.length)
      chWrap.appendChild(el('div', 'agent-empty', 'No file changes.'));
    detail.appendChild(chWrap);

    // Actions
    var actions = el('div', 'agent-detail-actions');
    var repoBtn = document.createElement('button');
    repoBtn.type = 'button';
    repoBtn.textContent = 'Open repo on GitHub';
    repoBtn.addEventListener('click', function () {
      clearFeedback();
      if (typeof bridge.openGithub !== 'function') {
        setFeedback('Open GitHub unavailable.', true);
        return;
      }
      try {
        Promise.resolve(
          bridge.openGithub({ repo: run.repo, kind: 'repo' }),
        ).catch(function (e) {
          setFeedback('Failed to open repo: ' + errMsg(e), true);
        });
      } catch (e) {
        setFeedback('Failed to open repo: ' + errMsg(e), true);
      }
    });
    actions.appendChild(repoBtn);
    var reviewBtn = el('button', null, 'Review dev against default branch');
    reviewBtn.type = 'button';
    reviewBtn.addEventListener('click', function () {
      bridge.agentReview({ id: run.id }).catch(function (e) {
        setFeedback(errMsg(e), true);
      });
    });
    actions.appendChild(reviewBtn);
    detail.appendChild(actions);
  }

  function renderChange(change) {
    var c = change || {};
    var wrap = el('details', 'agent-change');
    wrap.appendChild(el('summary', null, String(c.path || '(unknown path)')));
    var before = el('div', 'agent-diff agent-diff-before');
    before.appendChild(el('div', 'agent-diff-label', 'Before'));
    before.appendChild(el('pre', 'agent-diff-body', typecast(c.before)));
    var after = el('div', 'agent-diff agent-diff-after');
    after.appendChild(el('div', 'agent-diff-label', 'After'));
    after.appendChild(el('pre', 'agent-diff-body', typecast(c.after)));
    wrap.appendChild(before);
    wrap.appendChild(after);
    return wrap;
  }

  function factRow(label, value) {
    var li = el('li', 'agent-fact');
    li.appendChild(el('span', 'agent-fact-label', label + ': '));
    li.appendChild(
      el(
        'span',
        'agent-fact-value',
        value == null || value === '' ? '—' : typecast(value),
      ),
    );
    return li;
  }

  function typecast(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  function onAgentEvent(data) {
    try {
      if (!data) return;
      if (data.id && !data.status && !data.tasks) {
        // lightweight notification -> refresh
        loadDetail(data.id).catch(function () {});
        refreshHistory().catch(function () {});
        return;
      }
      // full run
      historyCache[data.id] = data;
      if (data.id === activeRunId) {
        activeStatus = data.status || activeStatus;
        renderRun(data);
        syncStartState();
      } else {
        // Do not steal user's selection; just update start state for our own run.
        if (data.id === activeRunId) {
          activeStatus = data.status;
          syncStartState();
        }
      }
      // keep history list fresh without stealing selection
      refreshHistory().catch(function () {});
    } catch {
      // never throw out of listener
    }
  }

  function initVisibilityRefresh() {
    var nav = document.getElementById('agent-view');
    if (nav && typeof MutationObserver !== 'undefined') {
      var obs = new MutationObserver(function () {
        var hidden = nav.hasAttribute('hidden') || nav.style.display === 'none';
        if (!hidden) {
          refreshHistory().catch(function () {});
          if (activeRunId) loadDetail(activeRunId).catch(function () {});
        }
      });
      try {
        obs.observe(nav, {
          attributes: true,
          attributeFilter: ['hidden', 'style', 'class'],
        });
      } catch {
        // ignore
      }
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        refreshHistory().catch(function () {});
        if (activeRunId) loadDetail(activeRunId).catch(function () {});
      }
    });
  }

  function wireHandlers() {
    var loadReposBtn = $('agent-load-repos');
    if (loadReposBtn)
      loadReposBtn.addEventListener('click', function () {
        onLoadRepos();
      });

    var moreReposBtn = $('agent-more-repos');
    if (moreReposBtn)
      moreReposBtn.addEventListener('click', function () {
        onMoreRepos();
      });

    var useRepoBtn = $('agent-use-repo');
    if (useRepoBtn)
      useRepoBtn.addEventListener('click', function () {
        onUseRepo();
      });

    var modelsBtn = $('agent-models');
    if (modelsBtn)
      modelsBtn.addEventListener('click', function () {
        onLoadModels();
      });

    var startBtn = $('agent-start');
    if (startBtn)
      startBtn.addEventListener('click', function () {
        onStart();
      });

    var cancelBtn = $('agent-cancel');
    if (cancelBtn)
      cancelBtn.addEventListener('click', function () {
        onCancel();
      });

    var refreshBtn = $('agent-refresh');
    if (refreshBtn)
      refreshBtn.addEventListener('click', function () {
        onRefresh();
      });

    var repoEl = $('agent-repo');
    if (repoEl)
      repoEl.addEventListener('change', function () {
        saveDraft();
      });
    var modelEl = $('agent-model');
    if (modelEl)
      modelEl.addEventListener('change', function () {
        saveDraft();
      });
    var tasksEl = $('agent-tasks');
    if (tasksEl)
      tasksEl.addEventListener('input', function () {
        saveDraft();
      });
    var budgetEl = $('agent-budget');
    if (budgetEl)
      budgetEl.addEventListener('change', function () {
        parseBudget();
        saveDraft();
      });
  }

  function init() {
    try {
      restoreDraft();
      wireHandlers();
      initVisibilityRefresh();
      syncStartState();

      if (typeof bridge.onAgent === 'function') {
        try {
          unsubscribe = bridge.onAgent(onAgentEvent);
        } catch {
          // ignore
        }
      }

      // initial loads (non-blocking)
      refreshHistory().catch(function () {});
      // Repository access starts only when requested by the user.
    } catch (e) {
      setFeedback('Init error: ' + errMsg(e), true);
    }
  }

  function boot() {
    try {
      var p = init();
      if (p && typeof p.then === 'function') {
        p.catch(function (e) {
          setFeedback('Init error: ' + errMsg(e), true);
        });
      }
    } catch (e) {
      setFeedback('Init error: ' + errMsg(e), true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose a small hook for tests / teardown.
  window.__agentUI = {
    refresh: function () {
      return refreshHistory();
    },
    loadDetail: loadDetail,
    dispose: function () {
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
        unsubscribe = null;
      }
    },
  };
})();
