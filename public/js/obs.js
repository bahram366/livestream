(function () {
  'use strict';
  const urlParams = new URLSearchParams(window.location.search);
  const roomId = (urlParams.get('room') || '').toUpperCase().trim();
  const BASE = window.__BASE_PATH__ || '';
  if (urlParams.get('transparent') === '1') document.body.classList.add('obs-transparent');

  if (!roomId) {
    document.getElementById('obs-empty').textContent = 'برای استفاده در OBS باید room را در آدرس مشخص کنید، مثلاً: /obs?room=E15KKT';
    return;
  }

  const myId = 'obs_' + Math.random().toString(36).slice(2, 10);
  const peers = {};
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  const socket = io({ path: BASE + '/socket.io/', transports: ['polling', 'websocket'], reconnection: true });

  socket.on('connect', () => {
    socket.emit('join-room', {
      userId: myId,
      roomId,
      userName: 'OBS',
      obsViewer: true
    });
  });

  socket.on('room-invalid', (data) => {
    document.getElementById('obs-empty').textContent = data.reason || 'این اتاق در دسترس نیست.';
  });

  socket.on('room-config', (data) => {
    if (Array.isArray(data.iceServers) && data.iceServers.length) iceServers = data.iceServers;
  });

  socket.on('room-users', async (users) => {
    for (const u of users) {
      if (!u.isObsViewer) await getPeerConnection(u.userId, true);
    }
    refreshEmptyState();
  });

  socket.on('peer-connected', () => {}); // tile appears once media actually arrives

  socket.on('room-users-update', (users) => {
    users.forEach((u) => {
      if (u.userId === myId || u.isObsViewer) return;
      if (!peers[u.userId] && myId < u.userId) getPeerConnection(u.userId, true);
    });
    refreshEmptyState();
  });

  socket.on('peer-disconnected', (data) => {
    if (peers[data.userId]) { peers[data.userId].close(); delete peers[data.userId]; }
    const box = document.getElementById('obs_box_' + data.userId);
    if (box) box.remove();
    refreshEmptyState();
  });

  socket.on('signal', async (data) => {
    const pc = await getPeerConnection(data.senderId, false);
    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { sdp: answer, targetId: data.senderId });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
    }
  });

  socket.on('room-closed-by-admin', () => {
    document.getElementById('obs-empty').textContent = 'این جلسه توسط مدیر بسته شد.';
    Object.values(peers).forEach((pc) => pc.close());
  });

  async function getPeerConnection(peerId, isOfferor) {
    if (peers[peerId]) return peers[peerId];
    const pc = new RTCPeerConnection({ iceServers });
    peers[peerId] = pc;
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { candidate: e.candidate, targetId: peerId }); };
    pc.ontrack = (e) => {
      let video = document.getElementById('obs_video_' + peerId);
      if (!video) {
        const box = document.createElement('div');
        box.id = 'obs_box_' + peerId;
        box.className = 'video-tile';
        video = document.createElement('video');
        video.id = 'obs_video_' + peerId;
        video.autoplay = true;
        video.playsInline = true;
        box.appendChild(video);
        document.getElementById('obs-grid').appendChild(box);
        refreshEmptyState();
      }
      video.srcObject = e.streams[0];
    };

    if (isOfferor) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { sdp: offer, targetId: peerId });
    }
    return pc;
  }

  function refreshEmptyState() {
    const grid = document.getElementById('obs-grid');
    const hasTiles = grid.querySelectorAll('.video-tile').length > 0;
    const empty = document.getElementById('obs-empty');
    if (empty) empty.style.display = hasTiles ? 'none' : '';
  }
})();
