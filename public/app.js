// Glenride System Map SPA — talks to the Worker API (password-gated).
(function () {
  'use strict';
  var API = window.SYSMAP_API_BASE;
  var token = localStorage.getItem('sysmap_token') || '';

  var loginView = document.getElementById('loginView');
  var appView = document.getElementById('appView');
  var logoutBtn = document.getElementById('logoutBtn');
  var loginError = document.getElementById('loginError');
  var dialog = document.getElementById('editDialog');
  var editForm = document.getElementById('editForm');
  var editFields = document.getElementById('editFields');
  var editTitle = document.getElementById('editTitle');
  var editError = document.getElementById('editError');
  var currentEdit = null; // {kind, id, fields}

  function headers(extra) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (extra) Object.assign(h, extra);
    return h;
  }

  async function api(path, opts) {
    opts = opts || {};
    opts.headers = headers();
    opts.credentials = 'include';
    var res = await fetch(API + path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (res.status === 401) { showLogin('Session expired — sign in again.'); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  function showLogin(msg) {
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    if (msg) { loginError.textContent = msg; loginError.classList.remove('hidden'); }
  }
  function showApp() {
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render(map) {
    document.getElementById('premise').textContent = map.organization ? map.organization.premise : '';
    document.getElementById('orgCurrentTitle').textContent = map.organization ? map.organization.current_title : '';
    document.getElementById('orgCurrentBody').textContent = map.organization ? map.organization.current_body : '';
    document.getElementById('orgFutureTitle').textContent = map.organization ? map.organization.future_title : '';
    document.getElementById('orgFutureBody').textContent = map.organization ? map.organization.future_body : '';

    var hl = document.getElementById('hierarchyList');
    hl.innerHTML = map.hierarchy.map(function (h, i) {
      return '<li><span class="level">L' + (i + 1) + '</span>' +
        '<span><span class="title">' + esc(h.title) + '</span><br><span class="holder">' + esc(h.holder || '—') + '</span></span>' +
        '<p class="resp">' + esc(h.responsibility) + '</p>' +
        '<button class="btn small" type="button" data-edit-hier="' + h.id + '">Edit</button></li>';
    }).join('');

    document.getElementById('deptCount').textContent = '(' + map.departments.length + ')';
    var dg = document.getElementById('deptGrid');
    dg.innerHTML = map.departments.map(function (d) {
      return '<article class="dept accent-' + esc(d.accent || 'ember') + '">' +
        '<h3>' + esc(d.title) + (d.is_core ? ' · core' : '') + '</h3>' +
        '<p class="tagline">' + esc(d.tagline) + '</p><dl>' +
        '<div><dt>Mandate</dt><dd>' + esc(d.mandate) + '</dd></div>' +
        '<div><dt>Now</dt><dd>' + esc(d.current_state) + '</dd></div>' +
        '<div><dt>Next</dt><dd>' + esc(d.future_state) + '</dd></div>' +
        '<div><dt>Done looks like</dt><dd>' + esc(d.done_looks_like) + '</dd></div>' +
        '<div><dt>Cost center</dt><dd>' + esc(d.cost_center) + '</dd></div>' +
        (d.notes ? '<div><dt>Notes</dt><dd>' + esc(d.notes) + '</dd></div>' : '') +
        '</dl><div class="dept-actions">' +
        '<button class="btn small" type="button" data-edit-dept="' + d.id + '">Edit</button>' +
        '<button class="btn small danger" type="button" data-del-dept="' + d.id + '" data-dept-name="' + esc(d.title) + '">Delete</button>' +
        '</div></article>';
    }).join('');

    document.getElementById('stageCount').textContent = '(' + map.budget_stages.length + ')';
    var sl = document.getElementById('stageList');
    sl.innerHTML = map.budget_stages.map(function (s, i) {
      return '<li><span class="num">' + (i + 1) + '</span>' +
        '<span class="title">' + esc(s.title) + '</span>' +
        '<p>' + esc(s.description) + '<br><span class="muted">Rule: ' + esc(s.decision_rule) + '</span></p>' +
        '<span class="timing">' + esc(s.timing) + '</span>' +
        '<button class="btn small" type="button" data-edit-stage="' + s.id + '">Edit</button></li>';
    }).join('');
  }

  async function load() {
    var map = await api('/api/map');
    window._map = map;
    render(map);
    showApp();
  }

  // --- Login ---
  document.getElementById('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    loginError.classList.add('hidden');
    var pw = document.getElementById('passwordInput').value;
    try {
      var res = await fetch(API + '/api/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Sign-in failed');
      token = data.token || '';
      localStorage.setItem('sysmap_token', token);
      document.getElementById('passwordInput').value = '';
      await load();
    } catch (err) {
      loginError.textContent = err.message;
      loginError.classList.remove('hidden');
    }
  });

  logoutBtn.addEventListener('click', async function () {
    try { await fetch(API + '/api/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
    token = '';
    localStorage.removeItem('sysmap_token');
    showLogin();
  });

  // --- Edit dialog ---
  var FIELD_DEFS = {
    dept: [
      ['title', 'Title', 'input'], ['tagline', 'Tagline', 'input'],
      ['mandate', 'Mandate', 'textarea'], ['cost_center', 'Cost center', 'textarea'],
      ['current_state', 'Current state', 'textarea'], ['future_state', 'Future state', 'textarea'],
      ['done_looks_like', 'Done looks like', 'textarea'], ['notes', 'Notes', 'textarea'],
      ['accent', 'Accent', 'select:ember,teal,gold,sage'],
      ['is_core', 'Core department', 'checkbox'], ['sort_order', 'Sort order', 'number'],
    ],
    stage: [
      ['title', 'Title', 'input'], ['description', 'Description', 'textarea'],
      ['timing', 'Timing', 'input'], ['decision_rule', 'Decision rule', 'textarea'],
      ['sort_order', 'Sort order', 'number'],
    ],
    hier: [
      ['title', 'Title', 'input'], ['holder', 'Holder', 'input'],
      ['responsibility', 'Responsibility', 'textarea'], ['sort_order', 'Sort order', 'number'],
    ],
    org: [
      ['premise', 'Premise', 'textarea'],
      ['current_title', 'Current title', 'input'], ['current_body', 'Current body', 'textarea'],
      ['future_title', 'Future title', 'input'], ['future_body', 'Future body', 'textarea'],
    ],
  };
  var ENDPOINTS = { dept: '/api/departments/', stage: '/api/budget-stages/', hier: '/api/hierarchy/', org: '/api/organization' };

  function openEdit(kind, id, record, title) {
    currentEdit = { kind: kind, id: id };
    editTitle.textContent = title;
    editError.classList.add('hidden');
    editFields.innerHTML = FIELD_DEFS[kind].map(function (def) {
      var key = def[0], label = def[1], type = def[2], val = record ? record[key] : '';
      if (type === 'textarea') return '<label>' + label + '<textarea name="' + key + '">' + esc(val) + '</textarea></label>';
      if (type === 'checkbox') return '<label><input type="checkbox" name="' + key + '"' + (val ? ' checked' : '') + '> ' + label + '</label>';
      if (type.indexOf('select:') === 0) {
        var opts = type.slice(7).split(',');
        return '<label>' + label + '<select name="' + key + '">' + opts.map(function (o) {
          return '<option value="' + o + '"' + (val === o ? ' selected' : '') + '>' + o + '</option>';
        }).join('') + '</select></label>';
      }
      if (type === 'number') return '<label>' + label + '<input type="number" name="' + key + '" value="' + esc(val) + '"></label>';
      return '<label>' + label + '<input type="text" name="' + key + '" value="' + esc(val) + '"' + (key === 'title' ? ' required' : '') + '></label>';
    }).join('');
    dialog.showModal();
  }

  editForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!currentEdit) return;
    var fd = new FormData(editForm);
    var body = {};
    FIELD_DEFS[currentEdit.kind].forEach(function (def) {
      var key = def[0], type = def[2];
      if (type === 'checkbox') { body[key] = fd.has(key); return; }
      var v = fd.get(key);
      if (v === null || v === undefined) return;
      body[key] = type === 'number' ? (v === '' ? null : Number(v)) : String(v);
    });
    try {
      var url = ENDPOINTS[currentEdit.kind];
      var method = 'PATCH';
      if (currentEdit.kind === 'dept' && currentEdit.id === null) { method = 'POST'; url = '/api/departments'; }
      else if (currentEdit.id !== null && currentEdit.id !== undefined) { url = url + currentEdit.id; }
      await api(url, { method: method, body: JSON.stringify(body) });
      dialog.close();
      await load();
    } catch (err) {
      editError.textContent = err.message;
      editError.classList.remove('hidden');
    }
  });
  document.getElementById('editCancel').addEventListener('click', function () { dialog.close(); });

  document.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-edit-dept],[data-del-dept],[data-edit-stage],[data-edit-hier],[data-edit-org]');
    if (!t) return;
    var map = window._map;
    if (t.hasAttribute('data-edit-dept')) {
      var d = map.departments.find(function (x) { return String(x.id) === t.getAttribute('data-edit-dept'); });
      openEdit('dept', d.id, d, 'Edit department — ' + d.title);
    } else if (t.hasAttribute('data-del-dept')) {
      if (!confirm('Delete department "' + t.getAttribute('data-dept-name') + '"?')) return;
      try { await api('/api/departments/' + t.getAttribute('data-del-dept'), { method: 'DELETE' }); await load(); }
      catch (err) { alert(err.message); }
    } else if (t.hasAttribute('data-edit-stage')) {
      var s = map.budget_stages.find(function (x) { return String(x.id) === t.getAttribute('data-edit-stage'); });
      openEdit('stage', s.id, s, 'Edit budget stage — ' + s.title);
    } else if (t.hasAttribute('data-edit-hier')) {
      var h = map.hierarchy.find(function (x) { return String(x.id) === t.getAttribute('data-edit-hier'); });
      openEdit('hier', h.id, h, 'Edit hierarchy — ' + h.title);
    } else if (t.hasAttribute('data-edit-org')) {
      openEdit('org', null, map.organization, 'Edit organization');
    }
  });

  document.getElementById('addDeptBtn').addEventListener('click', function () {
    openEdit('dept', null, { accent: 'ember', is_core: true, sort_order: 99 }, 'Add department');
  });

  // Boot: try loading with any stored token; fall back to the login form.
  (async function () {
    if (!token) { showLogin(); return; }
    try { await load(); } catch (e) { /* showLogin already called on 401 */ }
  })();
})();
