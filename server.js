const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Paths & persistence
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('Failed to read', file, e);
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

let rooms = loadJSON(ROOMS_FILE, {});
let settings = loadJSON(SETTINGS_FILE, null);
if (!settings) {
  settings = {
    adminUsername: 'admin',
    adminPasswordHash: bcrypt.hashSync('admin', 10)
  };
  saveJSON(SETTINGS_FILE, settings);
  console.log('✅ Default admin account created -> username: admin / password: admin (change this in the dashboard).');
}

// ---------------------------------------------------------------------------
// App / server setup
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);

// Many cPanel Node.js App setups proxy the app under a sub-path (whatever you
// set as "Application URL", e.g. "vortex" or "live-streem") WITHOUT stripping
// that prefix — the app still receives requests like "/vortex/...". Set
// BASE_PATH to match that exact "Application URL" value (with or without a
// leading slash) via an environment variable in the cPanel Node.js App
// screen, e.g. BASE_PATH=vortex. Leave it unset if the app is served at the
// domain root.
let BASE_PATH = (process.env.BASE_PATH || '').trim();
if (BASE_PATH && !BASE_PATH.startsWith('/')) BASE_PATH = '/' + BASE_PATH;
BASE_PATH = BASE_PATH.replace(/\/+$/, '');
const MOUNT = BASE_PATH || '/';

// Explicit socket.io path — kept explicit (rather than default) because many
// shared/cPanel Node.js hosts (Phusion Passenger) proxy a fixed path set and
// can silently break the implicit "/socket.io/" route when the app is mounted
// under a sub-path. Keeping it explicit here AND on the client avoids drift.
const SOCKET_PATH = BASE_PATH + '/socket.io/';

const io = new Server(server, {
  path: SOCKET_PATH,
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Allow polling to work first, then upgrade — Passenger-based cPanel Node
  // hosting frequently does NOT proxy WebSocket upgrades correctly. Without
  // this, two users joining the same link can both "connect" over polling
  // but never reliably exchange signaling data, which looks exactly like
  // "we're in the room but can't see each other".
  transports: ['polling', 'websocket']
});

const router = express.Router();

app.use(cookieParser());
app.use(express.json());

// جلوگیری از کش شدن API ها
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});


// ======================
// Admin Login
// ======================
router.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      error: 'نام کاربری و رمز عبور الزامی است.'
    });
  }

  if (
    username !== settings.adminUsername ||
    !bcrypt.compareSync(password, settings.adminPasswordHash)
  ) {
    return res.status(401).json({
      error: 'نام کاربری یا رمز عبور اشتباه است.'
    });
  }

  const token = crypto.randomBytes(32).toString('hex');

  sessions.set(token, Date.now());

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 7
  });

  res.json({
    ok: true
  });
});


// ======================
// Check Admin Session
// ======================
router.get('/api/admin/me', (req, res) => {

  const token = req.cookies[SESSION_COOKIE];

  const valid = isValidToken(token);

  res.json({
    authed: valid,
    username: valid ? settings.adminUsername : null
  });

});


// ======================
// Admin Logout
// ======================
router.post('/api/admin/logout', (req, res) => {

  const token = req.cookies[SESSION_COOKIE];

  if (token) {
    sessions.delete(token);
  }

  res.clearCookie(SESSION_COOKIE, {
    path: '/'
  });

  res.json({
    ok: true
  });

});

router.post('/api/admin/logout', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});



// The admin session cookie is httpOnly (page JS cannot read it), so to let a
// room page prove "this browser is the logged-in admin" to the socket layer,
// we hand out a short-lived ticket instead of exposing the real cookie value.
const socketTickets = new Map(); // ticket -> expiresAt
const TICKET_TTL_MS = 5 * 60 * 1000;

function isValidTicket(ticket) {
  if (!ticket || !socketTickets.has(ticket)) return false;
  if (Date.now() > socketTickets.get(ticket)) {
    socketTickets.delete(ticket);
    return false;
  }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of socketTickets) if (now > exp) socketTickets.delete(t);
}, 60 * 1000).unref();

router.post('/api/admin/socket-ticket', requireAdmin, (req, res) => {
  const ticket = crypto.randomBytes(20).toString('hex');
  socketTickets.set(ticket, Date.now() + TICKET_TTL_MS);
  res.json({ ticket });
});

router.post('/api/admin/credentials', requireAdmin, (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body || {};
  if (!currentPassword || !bcrypt.compareSync(currentPassword, settings.adminPasswordHash)) {
    return res.status(401).json({ error: 'رمز عبور فعلی اشتباه است.' });
  }
  if (newUsername && newUsername.trim()) settings.adminUsername = newUsername.trim();
  if (newPassword && newPassword.trim()) settings.adminPasswordHash = bcrypt.hashSync(newPassword.trim(), 10);
  saveJSON(SETTINGS_FILE, settings);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin rooms API
// ---------------------------------------------------------------------------
router.get('/api/admin/rooms', requireAdmin, (req, res) => {
  const list = Object.values(rooms).map(r => ({
    ...r,
    liveCount: (roomsState[r.code] || []).length
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ rooms: list });
});

router.post('/api/admin/rooms', requireAdmin, (req, res) => {
  const { name } = req.body || {};
  const code = generateRoomCode();
  const room = {
    code,
    name: (name && name.trim()) || null,
    createdAt: new Date().toISOString(),
    active: true,
    closedAt: null
  };
  rooms[code] = room;
  saveJSON(ROOMS_FILE, rooms);
  res.json({ ok: true, room });
});

router.post('/api/admin/rooms/:code/close', requireAdmin, (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const room = rooms[code];
  if (!room) return res.status(404).json({ error: 'اتاق یافت نشد.' });

  room.active = false;
  room.closedAt = new Date().toISOString();
  saveJSON(ROOMS_FILE, rooms);

  // Force everyone currently in the room out immediately.
  io.to(code).emit('room-closed-by-admin');
  if (roomsState[code]) {
    roomsState[code] = [];
  }
  io.to('admins').emit('admin:rooms-changed');

  res.json({ ok: true, room });
});

function serveHtml(relPath) {
  return (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, relPath), 'utf8');
    const baseHref = (BASE_PATH || '') + '/';
    const inject = `<base href="${baseHref}">\n<script>window.__BASE_PATH__=${JSON.stringify(BASE_PATH)};</script>\n`;
    html = html.replace('<head>', '<head>\n' + inject);
    res.type('html').send(html);
  };
}

router.get('/', serveHtml('public/index.html'));
router.get('/admin', serveHtml('public/admin/index.html'));
router.get('/admin/', serveHtml('public/admin/index.html'));
router.get('/obs', serveHtml('public/obs/index.html'));
router.get('/obs/', serveHtml('public/obs/index.html'));

// ---------------------------------------------------------------------------
// Realtime state & socket handling
// ---------------------------------------------------------------------------
// roomsState: { [code]: [ { socketId, userId, userName, isAdmin, mutedByHost, cameraOffByHost } ] }
const roomsState = {};

function broadcastRoomUsers(code) {
  io.to(code).emit('room-users-update', roomsState[code] || []);
  io.to('admins').emit('admin:room-users', { code, users: roomsState[code] || [] });
}

io.on('connection', (socket) => {
  let joinedRoomId = null;
  let currentUserId = null;
  let currentUserName = null;

  socket.on('join-room', (data = {}) => {
    const code = String(data.roomId || '').toUpperCase().trim();
    const userName = String(data.userName || '').trim().slice(0, 40);
    const adminToken = data.adminToken;

    if (!code || !userName) {
      socket.emit('room-invalid', { reason: 'اطلاعات ورود ناقص است.' });
      return;
    }
    if (!isRoomJoinable(code)) {
      socket.emit('room-invalid', { reason: 'این اتاق وجود ندارد یا توسط مدیر بسته شده است.' });
      return;
    }

    joinedRoomId = code;
    currentUserId = data.userId;
    currentUserName = userName;
    const isAdmin = isValidTicket(adminToken);
    const isObsViewer = !!data.obsViewer;

    socket.join(joinedRoomId);
    socket.emit('room-config', { iceServers, isAdmin });

    if (!roomsState[joinedRoomId]) roomsState[joinedRoomId] = [];

    const userObj = {
      socketId: socket.id,
      userId: currentUserId,
      userName: currentUserName,
      isAdmin,
      isObsViewer,
      mutedByHost: false,
      cameraOffByHost: false
    };
    roomsState[joinedRoomId].push(userObj);

    const otherUsers = roomsState[joinedRoomId].filter(u => u.userId !== currentUserId);
    socket.emit('room-users', otherUsers);

    socket.to(joinedRoomId).emit('peer-connected', {
      userId: currentUserId,
      userName: currentUserName
    });

    broadcastRoomUsers(joinedRoomId);
  });

  // WebRTC signaling relay
  socket.on('signal', (data = {}) => {
    if (!joinedRoomId || !roomsState[joinedRoomId]) return;
    const targetUser = roomsState[joinedRoomId].find(u => u.userId === data.targetId);
    if (targetUser) {
      io.to(targetUser.socketId).emit('signal', {
        senderId: currentUserId,
        sdp: data.sdp,
        candidate: data.candidate
      });
    }
  });

  socket.on('chat:send', (data = {}) => {
    if (!joinedRoomId) return;
    const message = String(data.message || '').slice(0, 1000);
    if (!message.trim()) return;
    io.to(joinedRoomId).emit('chat:received', {
      senderName: currentUserName,
      senderId: currentUserId,
      message,
      at: Date.now()
    });
  });

  function findSelf() {
    if (!joinedRoomId || !roomsState[joinedRoomId]) return null;
    return roomsState[joinedRoomId].find(u => u.userId === currentUserId);
  }

  // --- Admin-only in-room moderation actions ---
  socket.on('host:kick-user', (data = {}) => {
    const self = findSelf();
    if (!self || !self.isAdmin) return;
    const target = roomsState[joinedRoomId]?.find(u => u.userId === data.targetId);
    if (target) io.to(target.socketId).emit('kicked-by-host');
  });

  socket.on('host:mute-user', (data = {}) => {
    const self = findSelf();
    if (!self || !self.isAdmin) return;
    const target = roomsState[joinedRoomId]?.find(u => u.userId === data.targetId);
    if (target) {
      target.mutedByHost = true;
      io.to(target.socketId).emit('muted-by-host');
      broadcastRoomUsers(joinedRoomId);
    }
  });

  socket.on('host:disable-camera', (data = {}) => {
    const self = findSelf();
    if (!self || !self.isAdmin) return;
    const target = roomsState[joinedRoomId]?.find(u => u.userId === data.targetId);
    if (target) {
      target.cameraOffByHost = true;
      io.to(target.socketId).emit('camera-off-by-host');
      broadcastRoomUsers(joinedRoomId);
    }
  });

  socket.on('host:start-recording', () => {
    const self = findSelf();
    if (!self || !self.isAdmin || !joinedRoomId) return;
    io.to(joinedRoomId).emit('recording-state', { active: true });
  });
  socket.on('host:stop-recording', () => {
    const self = findSelf();
    if (!self || !self.isAdmin || !joinedRoomId) return;
    io.to(joinedRoomId).emit('recording-state', { active: false });
  });

  // --- Admin dashboard subscription ---
  socket.on('admin:subscribe', (data = {}) => {
    if (!isValidTicket(data.token)) return;
    socket.join('admins');
  });

  socket.on('disconnect', () => {
    if (!currentUserId || !joinedRoomId || !roomsState[joinedRoomId]) return;

    roomsState[joinedRoomId] = roomsState[joinedRoomId].filter(u => u.userId !== currentUserId);

    socket.to(joinedRoomId).emit('peer-disconnected', {
      userId: currentUserId,
      userName: currentUserName
    });

    broadcastRoomUsers(joinedRoomId);
  });
});

server.listen(PORT, () => {
  console.log(`Vortex server running on port ${PORT}`);
  console.log(`Base path: ${BASE_PATH || '(root)'} — set BASE_PATH env var if this app is mounted under a cPanel sub-path.`);
});
