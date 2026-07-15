(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const BASE = window.__BASE_PATH__ || ''; // '' at root, e.g. '/vortex' under a sub-path

  async function api(url, opts = {}) {
    const res = await fetch(BASE + url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'خطای ناشناخته');
    return data;
  }

  async function checkAuth() {
    const me = await api('/api/admin/me');
    if (me.authed) {
      $('screen-login').classList.add('hidden');
      $('screen-dashboard').classList.remove('hidden');
      $('whoami-chip').textContent = me.username;
      loadRooms();
    }
  }

  $('login-btn').onclick = async () => {
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      checkAuth();
    } catch (e) {
      $('login-error').textContent = e.message;
      $('login-error').classList.remove('hidden');
    }
  };
  $('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });

  $('logout-btn').onclick = async () => {
    await api('/api/admin/logout', { method: 'POST' });
    location.reload();
  };

  async function loadRooms() {
    const { rooms } = await api('/api/admin/rooms');
    const tbody = $('rooms-tbody');
    tbody.innerHTML = '';
    if (!rooms.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-faint text-center" style="padding:20px;">هنوز اتاقی ساخته نشده است.</td></tr>';
      return;
    }
    rooms.forEach((r) => {
      const tr = document.createElement('tr');
      const link = location.origin + BASE + '/?room=' + r.code;
      const statusChip = r.active
        ? '<span class="chip" style="color:var(--signal);border-color:rgba(51,194,166,0.35);">فعال</span>'
        : '<span class="chip" style="color:var(--tally);border-color:rgba(242,84,45,0.35);">بسته‌شده</span>';

      tr.innerHTML = `
        <td data-label="کد اتاق"><span class="mono" style="font-weight:700;">${r.code}</span></td>
        <td data-label="نام">${r.name ? escapeHtml(r.name) : '<span class="text-faint">—</span>'}</td>
        <td data-label="وضعیت">${statusChip}</td>
        <td data-label="حاضرین">${r.liveCount || 0} نفر</td>
        <td data-label="ساخته‌شده" class="text-faint">${new Date(r.createdAt).toLocaleString('fa-IR')}</td>
        <td data-label="عملیات">
          <div class="flex gap-2" style="flex-wrap:wrap;">
            <button class="btn btn-sm" data-copy="${link}">کپی لینک</button>
            <button class="btn btn-sm" data-obs="${location.origin}${BASE}/obs?room=${r.code}">لینک OBS</button>
            ${r.active ? `<button class="btn btn-sm btn-danger-ghost" data-close="${r.code}">بستن اتاق</button>` : ''}
          </div>
        </td>`;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copy(b.getAttribute('data-copy'), 'لینک دعوت کپی شد.'));
    tbody.querySelectorAll('[data-obs]').forEach((b) => b.onclick = () => copy(b.getAttribute('data-obs'), 'لینک OBS کپی شد.'));
    tbody.querySelectorAll('[data-close]').forEach((b) => b.onclick = async () => {
      if (!confirm('این اتاق برای همیشه بسته شود؟ کاربران حاضر فوراً خارج می‌شوند و لینک دیگر کار نخواهد کرد.')) return;
      await api('/api/admin/rooms/' + b.getAttribute('data-close') + '/close', { method: 'POST' });
      loadRooms();
    });
  }

  $('create-room-btn').onclick = async () => {
    const name = $('new-room-name').value.trim();
    await api('/api/admin/rooms', { method: 'POST', body: JSON.stringify({ name }) });
    $('new-room-name').value = '';
    loadRooms();
  };

  $('save-creds-btn').onclick = async () => {
    const currentPassword = $('cur-pass').value;
    const newUsername = $('new-user').value.trim();
    const newPassword = $('new-pass').value;
    const msg = $('creds-msg');
    try {
      await api('/api/admin/credentials', { method: 'POST', body: JSON.stringify({ currentPassword, newUsername, newPassword }) });
      msg.style.color = 'var(--signal)';
      msg.textContent = 'ذخیره شد.';
      msg.classList.remove('hidden');
      $('cur-pass').value = ''; $('new-user').value = ''; $('new-pass').value = '';
    } catch (e) {
      msg.style.color = 'var(--tally)';
      msg.textContent = e.message;
      msg.classList.remove('hidden');
    }
  };

  function copy(text, message) {
    navigator.clipboard.writeText(text).then(() => alert(message)).catch(() => alert(text));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  checkAuth();
  setInterval(() => { if (!$('screen-dashboard').classList.contains('hidden')) loadRooms(); }, 8000);
})();
