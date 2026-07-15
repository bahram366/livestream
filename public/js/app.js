(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  const urlParams = new URLSearchParams(window.location.search);
  const roomId = (urlParams.get('room') || '').toUpperCase().trim();
  // BASE_PATH is injected server-side (see server.js serveHtml) so every
  // API/socket URL still works when this app is mounted under a cPanel
  // sub-path like /vortex. BASE has no trailing slash: '' at the domain
  // root, or e.g. '/vortex' when mounted under a sub-path.
  const BASE = window.__BASE_PATH__ || ''; // '' at root, e.g. '/vortex' under a sub-path

  // Video quality tiers. This is a peer-to-peer mesh (every participant
  // connects directly to every other one, no media server in the middle),
  // so upload bandwidth is the real constraint: sending 4K to 5 people at
  // once means encoding & uploading 5 separate 4K streams simultaneously.
  // "Auto" picks a sensible tier from the participant count and then
  // actively steps down further if it detects real packet loss.
  const QUALITY_PRESETS = {
    '4k':    { width: 3840, height: 2160, frameRate: 30, maxBitrate: 8000000, label: '4K' },
    '1080p': { width: 1920, height: 1080, frameRate: 30, maxBitrate: 3000000, label: '1080p' },
    '720p':  { width: 1280, height: 720,  frameRate: 30, maxBitrate: 1500000, label: '720p' },
    '480p':  { width: 854,  height: 480,  frameRate: 24, maxBitrate: 600000,  label: '480p' }
  };
  const TIER_ORDER = ['480p', '720p', '1080p', '4k'];

  const state = {
    myId: 'u_' + Math.random().toString(36).slice(2, 10),
    myName: '',
    isAdmin: false,
    adminTicket: null,
    socket: null,
    localStream: null,
    screenStream: null,
    peers: {},          // userId -> RTCPeerConnection
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    knownUsers: [],     // last room-users-update payload
    recording: false,
    joinedAt: null,
    timerHandle: null,
    qualityMode: 'auto',      // 'auto' | 'manual'
    effectiveQuality: '720p',
    networkPenalty: 0,        // 0..2, auto-mode step-down on detected packet loss
    qualityMonitorHandle: null
  };

  // ---------------------------------------------------------------------
  // Step 0: does this browser hold an admin session? (used to unlock host
  // controls automatically when the admin opens a room link themselves)
  // ---------------------------------------------------------------------
  async function fetchAdminTicketIfAny() {
    try {
      const me = await fetch(BASE + '/api/admin/me', { credentials: 'same-origin' }).then(r => r.json());
      if (!me.authed) return;
      const t = await fetch(BASE + '/api/admin/socket-ticket', { method: 'POST', credentials: 'same-origin' }).then(r => r.json());
      if (t.ticket) state.adminTicket = t.ticket;
    } catch (e) { /* not an admin browser, ignore */ }
  }

  // ---------------------------------------------------------------------
  // Step 1: validate the room before showing anything else. No room param
  // and no default "Lobby" fallback — that's intentional (no open lobby).
  // ---------------------------------------------------------------------
  async function boot() {
    await fetchAdminTicketIfAny();

    if (!roomId) {
      hide($('screen-loading'));
      show($('screen-invalid'));
      return;
    }

    try {
      const res = await fetch(BASE + '/api/rooms/' + encodeURIComponent(roomId) + '/status').then(r => r.json());
      hide($('screen-loading'));
      if (!res.exists) {
        $('invalid-reason').textContent = 'کد اتاق درست وارد نشده یا هرگز چنین اتاقی ساخته نشده است.';
        show($('screen-invalid'));
        return;
      }
      if (!res.active) {
        $('invalid-reason').textContent = 'این جلسه توسط مدیر پایان یافته و غیرفعال شده است. لینک جدید را از مدیر جلسه بگیرید.';
        show($('screen-invalid'));
        return;
      }
      $('join-room-label').textContent = 'اتاق ' + roomId + (res.name ? ' — ' + res.name : '');
      show($('screen-join'));
      setupPreview();
    } catch (e) {
      hide($('screen-loading'));
      $('invalid-reason').textContent = 'ارتباط با سرور برقرار نشد. اتصال اینترنت یا آدرس سرور را بررسی کنید.';
      show($('screen-invalid'));
    }
  }

  // ---------------------------------------------------------------------
  // Local camera/mic preview (join screen)
  // ---------------------------------------------------------------------
  async function setupPreview() {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
    } catch (err) {
      try {
        state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        alert('فقط دسترسی صدا فعال شد؛ دوربین در دسترس نیست یا اجازه داده نشد.');
      } catch (e2) {
        alert('دسترسی به میکروفون و دوربین ممکن نشد. بدون تصویر/صدا وارد می‌شوید.');
      }
    }
    if (state.localStream) {
      $('preview-video').srcObject = state.localStream;
      $('local-video').srcObject = state.localStream;
    }
  }

  function micActive() {
    const t = state.localStream && state.localStream.getAudioTracks()[0];
    return !!(t && t.enabled);
  }
  function camActive() {
    const t = state.localStream && state.localStream.getVideoTracks()[0];
    return !!(t && t.enabled);
  }

  // ---------------------------------------------------------------------
  // Join flow
  // ---------------------------------------------------------------------
  function bindJoinScreen() {
    $('preview-toggle-mic').onclick = () => {
      const t = state.localStream && state.localStream.getAudioTracks()[0];
      if (!t) return;
      t.enabled = !t.enabled;
      $('preview-toggle-mic').textContent = t.enabled ? '🎤' : '🔇';
    };
    $('preview-toggle-cam').onclick = () => {
      const t = state.localStream && state.localStream.getVideoTracks()[0];
      if (!t) return;
      t.enabled = !t.enabled;
      $('preview-toggle-cam').textContent = t.enabled ? '📷' : '📹';
    };

    const attemptJoin = () => {
      const name = $('username-input').value.trim();
      if (!name) {
        $('join-error').textContent = 'لطفاً نام خود را وارد کنید.';
        show($('join-error'));
        return;
      }
      hide($('join-error'));
      state.myName = name;
      joinRoom();
    };

    $('submit-join-btn').onclick = attemptJoin;
    $('username-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptJoin();
    });
  }

  function joinRoom() {
    $('local-user-badge').textContent = state.myName + ' (شما)';
    hide($('screen-join'));
    show($('app-workspace'));
    document.body.style.overflow = 'hidden';

    $('room-code-chip').textContent = roomId;
    state.joinedAt = Date.now();
    state.timerHandle = setInterval(updateTimer, 1000);
    updateTimer();

    applyTier(computeAutoTier());
    state.qualityMonitorHandle = setInterval(evaluateNetworkHealth, 6000);

    connectSocket();
  }

  function updateTimer() {
    const secs = Math.floor((Date.now() - state.joinedAt) / 1000);
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    $('session-timer').textContent = m + ':' + s;
  }

  // ---------------------------------------------------------------------
  // Video quality management
  // ---------------------------------------------------------------------
  function tierIndex(t) { return TIER_ORDER.indexOf(t); }

  // A sane starting point based on how many people are actually in the
  // call — more remote peers means more simultaneous outgoing streams to
  // encode & upload, so we start lower automatically rather than let
  // everyone's connection choke trying to send 4K to 6 people at once.
  function pickBaselineTier() {
    const remoteCount = Object.keys(state.peers).length;
    if (remoteCount <= 1) return '1080p';
    if (remoteCount <= 3) return '720p';
    return '480p';
  }

  function computeAutoTier() {
    const baseline = pickBaselineTier();
    const idx = Math.max(0, tierIndex(baseline) - state.networkPenalty);
    return TIER_ORDER[idx];
  }

  function applyBitrateToSender(pc, tier) {
    const preset = QUALITY_PRESETS[tier];
    const sender = pc.getSenders && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = preset.maxBitrate;
    sender.setParameters(params).catch(() => {});
  }

  async function applyTier(tier) {
    const preset = QUALITY_PRESETS[tier];
    if (!preset) return;
    state.effectiveQuality = tier;

    const track = state.localStream && state.localStream.getVideoTracks()[0];
    if (track && !state.screenStream) {
      try {
        await track.applyConstraints({
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.frameRate }
        });
      } catch (e) { /* camera can't hit this exact resolution — browser keeps the closest match */ }
    }

    Object.values(state.peers).forEach((pc) => applyBitrateToSender(pc, tier));

    const chip = $('quality-chip');
    if (chip) chip.textContent = 'کیفیت: ' + preset.label + (state.qualityMode === 'auto' ? ' (خودکار)' : '');
  }

  function reapplyAutoQuality() {
    if (state.qualityMode !== 'auto') return;
    const tier = computeAutoTier();
    if (tier !== state.effectiveQuality) applyTier(tier);
  }

  function setQuality(requested) {
    hide($('quality-panel'));
    if (requested === 'auto') {
      state.qualityMode = 'auto';
      state.networkPenalty = 0;
      applyTier(computeAutoTier());
      addSystemMessage('کیفیت روی حالت خودکار تنظیم شد.', 'signal');
    } else {
      state.qualityMode = 'manual';
      applyTier(requested);
      addSystemMessage('کیفیت تصویر روی ' + QUALITY_PRESETS[requested].label + ' تنظیم شد.', 'signal');
    }
  }

  // Runs periodically while in auto mode: reads real WebRTC stats (the
  // receiver-reported fraction of lost packets) and steps quality down if
  // the connection is actually struggling, and back up once it recovers.
  async function evaluateNetworkHealth() {
    if (state.qualityMode !== 'auto') return;
    const peerConns = Object.values(state.peers);
    if (!peerConns.length) return;

    let worstLoss = 0;
    for (const pc of peerConns) {
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type === 'remote-inbound-rtp' && r.kind === 'video' && typeof r.fractionLost === 'number') {
            worstLoss = Math.max(worstLoss, r.fractionLost);
          }
        });
      } catch (e) { /* connection may be mid-negotiation, skip this tick */ }
    }

    if (worstLoss > 0.08 && state.networkPenalty < 2) {
      state.networkPenalty++;
      addSystemMessage('به‌خاطر افت کیفیت اینترنت، کیفیت تصویر خودکار کاهش یافت.', 'tally');
      reapplyAutoQuality();
    } else if (worstLoss < 0.02 && state.networkPenalty > 0) {
      state.networkPenalty--;
      reapplyAutoQuality();
    }
  }

  // ---------------------------------------------------------------------
  // Socket connection & signaling
  // ---------------------------------------------------------------------
  function connectSocket() {
    state.socket = io({
      path: BASE + '/socket.io/',
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionAttempts: Infinity
    });

    const emitJoin = () => {
      state.socket.emit('join-room', {
        userId: state.myId,
        roomId,
        userName: state.myName,
        adminToken: state.adminTicket
      });
    };

    state.socket.on('connect', emitJoin);
    state.socket.on('reconnect', () => {
      addSystemMessage('اتصال دوباره برقرار شد.', 'signal');
      emitJoin();
    });
    state.socket.on('disconnect', () => {
      addSystemMessage('اتصال قطع شد؛ در حال تلاش برای اتصال مجدد…', 'tally');
    });

    state.socket.on('room-invalid', (data) => {
      showEndedScreen('امکان ورود وجود ندارد', data.reason || 'این اتاق دیگر در دسترس نیست.');
    });

    state.socket.on('room-config', (data) => {
      if (Array.isArray(data.iceServers) && data.iceServers.length) state.iceServers = data.iceServers;
      state.isAdmin = !!data.isAdmin;
      if (state.isAdmin) {
        show($('local-host-badge'));
        show($('record-btn'));
        show($('copy-obs-btn'));
      }
    });

    state.socket.on('room-users', async (usersList) => {
      addSystemMessage('شما به جلسه متصل شدید.', 'signal');
      for (const user of usersList) {
        if (user.userId !== state.myId && !user.isObsViewer) {
          await getPeerConnection(user.userId, true);
        }
      }
    });

    state.socket.on('peer-connected', (data) => {
      addSystemMessage(data.userName + ' به جلسه پیوست.', 'signal');
    });

    state.socket.on('peer-disconnected', (data) => {
      addSystemMessage(data.userName + ' جلسه را ترک کرد.', 'tally');
      removePeer(data.userId);
    });

    state.socket.on('signal', async (data) => {
      const pc = await getPeerConnection(data.senderId, false);
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          state.socket.emit('signal', { sdp: answer, targetId: data.senderId });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
        catch (e) { /* benign if arrives before remote description */ }
      }
    });

    state.socket.on('chat:received', (data) => {
      addChatMessage(data.senderName, data.message);
    });

    state.socket.on('room-users-update', (users) => {
      state.knownUsers = users;
      updateUsersList(users);
      selfHealConnections(users);
      reapplyAutoQuality();
    });

    state.socket.on('kicked-by-host', () => {
      showEndedScreen('از جلسه خارج شدید', 'مدیر شما را از این جلسه اخراج کرده است.');
    });

    state.socket.on('muted-by-host', () => {
      const t = state.localStream && state.localStream.getAudioTracks()[0];
      if (t && t.enabled) {
        t.enabled = false;
        setMicButtonState(false);
        addSystemMessage('میکروفون شما توسط مدیر قطع شد.', 'host');
      }
    });

    state.socket.on('camera-off-by-host', () => {
      const t = state.localStream && state.localStream.getVideoTracks()[0];
      if (t && t.enabled) {
        t.enabled = false;
        setCamButtonState(false);
        addSystemMessage('دوربین شما توسط مدیر خاموش شد.', 'host');
      }
    });

    state.socket.on('recording-state', (data) => {
      state.recording = !!data.active;
      $('rec-badge').classList.toggle('hidden', !state.recording);
      if (!state.isAdmin) {
        addSystemMessage(data.active ? 'ضبط این جلسه توسط مدیر آغاز شد.' : 'ضبط این جلسه پایان یافت.', 'host');
      }
    });

    state.socket.on('room-closed-by-admin', () => {
      showEndedScreen('جلسه پایان یافت', 'مدیر این اتاق را بسته است. این لینک دیگر کار نمی‌کند.');
    });
  }

  // Reconnect / late-join self-healing: whenever the roster updates, make
  // sure we have (or are trying to establish) a connection to everyone in
  // it. Lower userId initiates the offer to avoid glare between two peers
  // racing to call each other at the same time.
  function selfHealConnections(users) {
    users.forEach((u) => {
      if (u.userId === state.myId || u.isObsViewer) return;
      if (!state.peers[u.userId] && state.myId < u.userId) {
        getPeerConnection(u.userId, true);
      }
    });
  }

  // ---------------------------------------------------------------------
  // WebRTC mesh
  // ---------------------------------------------------------------------
  async function getPeerConnection(peerId, isOfferor) {
    if (state.peers[peerId]) return state.peers[peerId];

    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    state.peers[peerId] = pc;

    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
      applyBitrateToSender(pc, state.effectiveQuality);
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) state.socket.emit('signal', { candidate: e.candidate, targetId: peerId });
    };

    pc.oniceconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.iceConnectionState)) {
        // Give the browser a moment, then attempt a fresh negotiation once.
        setTimeout(() => {
          if (pc.iceConnectionState === 'failed' && state.peers[peerId] === pc) {
            removePeer(peerId);
            getPeerConnection(peerId, state.myId < peerId);
          }
        }, 4000);
      }
    };

    pc.ontrack = (e) => {
      ensureTile(peerId).video.srcObject = e.streams[0];
    };

    if (isOfferor) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        state.socket.emit('signal', { sdp: offer, targetId: peerId });
      } catch (err) { console.error('Offer failed', err); }
    }

    return pc;
  }

  function ensureTile(peerId) {
    let video = document.getElementById('video_' + peerId);
    if (video) return { video, box: document.getElementById('box_' + peerId) };

    const box = document.createElement('div');
    box.id = 'box_' + peerId;
    box.className = 'video-tile fade-in';

    video = document.createElement('video');
    video.id = 'video_' + peerId;
    video.autoplay = true;
    video.playsInline = true;

    const watermark = document.createElement('div');
    watermark.className = 'watermark';
    watermark.textContent = watermarkText();

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.id = 'label_' + peerId;
    label.innerHTML = '<span>در حال اتصال…</span>';

    box.appendChild(video);
    box.appendChild(watermark);
    box.appendChild(label);
    $('video-grid').appendChild(box);
    return { video, box };
  }

  function removePeer(peerId) {
    if (state.peers[peerId]) {
      state.peers[peerId].close();
      delete state.peers[peerId];
    }
    const box = document.getElementById('box_' + peerId);
    if (box) box.remove();
  }

  // Visible, per-viewer watermark: a real, honest deterrent/traceability
  // measure. It does NOT detect recording — no website can reliably detect
  // a phone's native screen recorder (iOS Control Center / Android capture),
  // so we don't pretend otherwise. This just makes any leaked recording
  // traceable back to the viewer who made it.
  function watermarkText() {
    const d = new Date();
    return state.myName + '\n' + roomId + ' · ' + d.toLocaleDateString('fa-IR');
  }

  // ---------------------------------------------------------------------
  // Users list + admin moderation controls
  // ---------------------------------------------------------------------
  function updateUsersList(users) {
    const container = $('panel-users-area');
    container.innerHTML = '';
    $('participant-count-chip').textContent = toFaNum(users.length) + ' نفر';

    users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'panel-2 flex items-center justify-between';
      row.style.cssText = 'padding:10px 12px;border-radius:12px;';

      const isMe = u.userId === state.myId;
      let badges = '';
      if (u.isAdmin) badges += '<span class="chip" style="color:var(--host);border-color:rgba(232,184,48,0.35);">👑 مدیر</span>';
      if (u.isObsViewer) badges += '<span class="chip">📡 OBS</span>';
      if (u.mutedByHost) badges += '<span class="chip" style="color:var(--tally);">🔇</span>';

      let actions = '';
      if (state.isAdmin && !isMe && !u.isAdmin) {
        actions = `
          <div class="flex gap-2">
            <button class="btn btn-sm" data-act="mute" data-id="${u.userId}">قطع صدا</button>
            <button class="btn btn-sm" data-act="cam" data-id="${u.userId}">قطع دوربین</button>
            <button class="btn btn-sm btn-danger-ghost" data-act="kick" data-id="${u.userId}">اخراج</button>
          </div>`;
      }

      row.innerHTML = `
        <div class="flex items-center gap-2" style="min-width:0;">
          <div class="tally-dot"></div>
          <span style="font-weight:600;font-size:12.5px;">${escapeHtml(u.userName)}${isMe ? ' (شما)' : ''}</span>
          ${badges}
        </div>
        ${actions}`;
      container.appendChild(row);

      const label = document.getElementById('label_' + u.userId);
      if (label && !isMe) {
        label.innerHTML = `<span>${escapeHtml(u.userName)}${u.isAdmin ? ' 👑' : ''}</span>` +
          (u.mutedByHost ? '<span class="mic-off-badge">🔇</span>' : '');
      }
    });

    container.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-id');
        const act = btn.getAttribute('data-act');
        if (act === 'kick' && !confirm('این کاربر اخراج شود؟')) return;
        const evt = act === 'mute' ? 'host:mute-user' : act === 'cam' ? 'host:disable-camera' : 'host:kick-user';
        state.socket.emit(evt, { targetId: id });
      };
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toFaNum(n) {
    return String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  }

  // ---------------------------------------------------------------------
  // Chat (no <form> anywhere — nothing here can ever trigger a page
  // refresh; sending is a plain click/Enter handler over the socket)
  // ---------------------------------------------------------------------
  function addChatMessage(sender, message) {
    const area = $('chat-messages');
    const el = document.createElement('div');
    el.className = 'panel-2 fade-in';
    el.style.cssText = 'padding:9px 12px;border-radius:12px;';
    el.innerHTML = `<span style="font-weight:700;color:var(--link);">${escapeHtml(sender)}:</span> <span>${escapeHtml(message)}</span>`;
    area.appendChild(el);
    area.scrollTop = area.scrollHeight;
  }
  function addSystemMessage(msg, tone) {
    const colorMap = { signal: 'var(--signal)', tally: 'var(--tally)', host: 'var(--host)' };
    const area = $('chat-messages');
    const el = document.createElement('div');
    el.className = 'text-center fade-in';
    el.style.cssText = `font-size:11.5px;color:${colorMap[tone] || 'var(--text-muted)'};`;
    el.textContent = msg;
    area.appendChild(el);
    area.scrollTop = area.scrollHeight;
  }

  function bindChat() {
    const send = () => {
      const input = $('chat-input');
      const msg = input.value.trim();
      if (!msg || !state.socket) return;
      state.socket.emit('chat:send', { message: msg });
      addChatMessage(state.myName + ' (شما)', msg);
      input.value = '';
    };
    $('chat-send-btn').onclick = send;
    $('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
  }

  // ---------------------------------------------------------------------
  // Controls: mic / camera / screen share / recording / leave / sidebar
  // ---------------------------------------------------------------------
  function setMicButtonState(on) {
    $('toggle-mic').textContent = on ? 'قطع صدا' : 'وصل صدا';
    $('toggle-mic').classList.toggle('btn-active', !on);
  }
  function setCamButtonState(on) {
    $('toggle-cam').textContent = on ? 'قطع دوربین' : 'وصل دوربین';
    $('toggle-cam').classList.toggle('btn-active', !on);
  }

  function bindControls() {
    $('toggle-mic').onclick = () => {
      const t = state.localStream && state.localStream.getAudioTracks()[0];
      if (!t) return;
      t.enabled = !t.enabled;
      setMicButtonState(t.enabled);
    };
    $('toggle-cam').onclick = () => {
      const t = state.localStream && state.localStream.getVideoTracks()[0];
      if (!t) return;
      t.enabled = !t.enabled;
      setCamButtonState(t.enabled);
    };

    $('quality-btn').onclick = (e) => {
      e.stopPropagation();
      $('quality-panel').classList.toggle('hidden');
    };
    document.querySelectorAll('.quality-opt').forEach((btn) => {
      btn.onclick = () => setQuality(btn.getAttribute('data-q'));
    });
    document.addEventListener('click', (e) => {
      const panel = $('quality-panel');
      if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== $('quality-btn')) {
        hide(panel);
      }
    });

    $('share-screen').onclick = async () => {
      if (!state.screenStream) {
        try {
          state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
          replaceOutgoingVideoTrack(state.screenStream.getVideoTracks()[0]);
          $('local-video').srcObject = state.screenStream;
          state.screenStream.getVideoTracks()[0].onended = stopShareScreen;
          $('share-screen').textContent = 'توقف اشتراک';
        } catch (e) { /* user cancelled the picker */ }
      } else {
        stopShareScreen();
      }
    };

    $('record-btn').onclick = toggleRecording;
    $('copy-link-btn').onclick = () => copyText(location.origin + BASE + '/?room=' + roomId, 'لینک دعوت کپی شد.');
    $('copy-obs-btn').onclick = () => copyText(location.origin + BASE + '/obs?room=' + roomId, 'لینک مخصوص OBS Browser Source کپی شد.');
    $('leave-btn').onclick = () => { window.location.href = window.location.pathname; };

    const sidebar = $('sidebar-panel');
    const scrim = $('sidebar-scrim');
    $('mobile-toggle-sidebar').onclick = () => {
      sidebar.classList.toggle('open');
      scrim.classList.toggle('show');
    };
    scrim.onclick = () => { sidebar.classList.remove('open'); scrim.classList.remove('show'); };

    $('tab-chat').onclick = () => switchTab('chat');
    $('tab-users').onclick = () => switchTab('users');
  }

  function switchTab(tab) {
    const chatOn = tab === 'chat';
    $('tab-chat').style.borderBottomColor = chatOn ? 'var(--link)' : 'transparent';
    $('tab-chat').style.color = chatOn ? 'var(--link)' : '';
    $('tab-users').style.borderBottomColor = chatOn ? 'transparent' : 'var(--link)';
    $('tab-users').style.color = chatOn ? '' : 'var(--link)';
    $('panel-chat-area').classList.toggle('hidden', !chatOn);
    $('panel-chat-area').classList.toggle('flex', chatOn);
    $('panel-users-area').classList.toggle('hidden', chatOn);
    $('panel-users-area').classList.toggle('flex', !chatOn);
  }

  function replaceOutgoingVideoTrack(track) {
    Object.values(state.peers).forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(track);
    });
  }
  function stopShareScreen() {
    if (state.screenStream) {
      state.screenStream.getTracks().forEach((t) => t.stop());
      state.screenStream = null;
    }
    const camTrack = state.localStream && state.localStream.getVideoTracks()[0];
    if (camTrack) replaceOutgoingVideoTrack(camTrack);
    $('local-video').srcObject = state.localStream;
    $('share-screen').textContent = 'اشتراک صفحه';
  }

  function copyText(text, message) {
    navigator.clipboard.writeText(text).then(() => alert(message)).catch(() => {
      const inp = document.createElement('input');
      inp.value = text;
      document.body.appendChild(inp);
      inp.select();
      document.execCommand('copy');
      document.body.removeChild(inp);
      alert(message);
    });
  }

  // --- Recording: only ever offered to the admin. This captures the
  // admin's own screen/tab via the browser's native picker and saves a
  // .webm locally — there is no server-side mixing/SFU in this build.
  let mediaRecorder = null;
  let recordedChunks = [];
  async function toggleRecording() {
    if (!state.recording) {
      try {
        const captureStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        recordedChunks = [];
        mediaRecorder = new MediaRecorder(captureStream, { mimeType: 'video/webm;codecs=vp9,opus' });
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = () => {
          const blob = new Blob(recordedChunks, { type: 'video/webm' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'vortex-' + roomId + '-' + Date.now() + '.webm';
          a.click();
        };
        mediaRecorder.start();
        captureStream.getVideoTracks()[0].onended = () => stopRecordingInternal();
        state.socket.emit('host:start-recording');
        $('record-btn').textContent = 'توقف ضبط';
      } catch (e) { /* picker cancelled */ }
    } else {
      stopRecordingInternal();
    }
  }
  function stopRecordingInternal() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    state.socket.emit('host:stop-recording');
    $('record-btn').textContent = 'شروع ضبط';
  }

  function showEndedScreen(title, reason) {
    if (state.timerHandle) clearInterval(state.timerHandle);
    if (state.qualityMonitorHandle) clearInterval(state.qualityMonitorHandle);
    Object.values(state.peers).forEach((pc) => pc.close());
    if (state.socket) state.socket.disconnect();
    $('ended-title').textContent = title;
    $('ended-reason').textContent = reason;
    show($('screen-ended'));
    hide($('app-workspace'));
  }

  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    bindJoinScreen();
    bindChat();
    bindControls();
    boot();
  });
})();
