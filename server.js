import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import dotenv from 'dotenv';
import * as DB from './DB.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'aethoria_secret_key_change_in_prod';
const SITE_URL   = process.env.SITE_URL || 'https://aethoria-rift-wars.onrender.com';

// ─── EMAIL ────────────────────────────────────────────────────────────────────
// Uses Resend API (https://resend.com — free tier: 3k emails/month)
// Set RESEND_API_KEY and FROM_EMAIL in your Render environment variables.
// If RESEND_API_KEY is not set, emails are logged to console only (dev mode).
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[Email MOCK] To: ${to}\nSubject: ${subject}\n`);
    return true;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'Aethoria <onboarding@resend.dev>',
        to, subject, html,
      }),
    });
    if (!res.ok) { console.error('[Email] Resend error:', await res.text()); return false; }
    return true;
  } catch (e) {
    console.error('[Email] Send failed:', e.message);
    return false;
  }
}

function emailVerifyTemplate(username, link) {
  return `<div style="background:#07071a;color:#f0f0ff;font-family:monospace;padding:32px;max-width:500px;margin:0 auto;border:1px solid #2a2060;">
  <h1 style="color:#dd99ff;letter-spacing:4px;font-size:22px;">AETHORIA<br><span style="font-size:14px;color:#99aaff;">RIFT WARS</span></h1>
  <p style="margin:24px 0 8px;">Hi <strong style="color:#dd99ff;">${username}</strong>,</p>
  <p style="color:#99aaff;line-height:1.6;">Click the button below to verify your email and activate your account.</p>
  <a href="${link}" style="display:inline-block;margin:20px 0;background:#220088;color:#fff;padding:12px 28px;text-decoration:none;letter-spacing:2px;font-size:13px;border:1px solid #6633ff;">VERIFY EMAIL →</a>
  <p style="color:#6655aa;font-size:11px;">Link expires in 24 hours. If you didn't create this account, ignore this email.</p>
  </div>`;
}

function email2FATemplate(username, code) {
  return `<div style="background:#07071a;color:#f0f0ff;font-family:monospace;padding:32px;max-width:500px;margin:0 auto;border:1px solid #2a2060;">
  <h1 style="color:#dd99ff;letter-spacing:4px;font-size:22px;">AETHORIA<br><span style="font-size:14px;color:#99aaff;">RIFT WARS</span></h1>
  <p style="margin:24px 0 8px;">Hi <strong style="color:#dd99ff;">${username}</strong>,</p>
  <p style="color:#99aaff;line-height:1.6;">Your verification code is:</p>
  <div style="font-size:36px;letter-spacing:12px;color:#ffcc00;margin:20px 0;padding:16px;background:#0c0c24;border:1px solid #3a3a8a;text-align:center;">${code}</div>
  <p style="color:#6655aa;font-size:11px;">Expires in 10 minutes. Never share this code with anyone.</p>
  </div>`;
}

function generate6DigitCode() {
  return String(crypto.randomInt(100000, 999999));
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Start server immediately so static files are always served
httpServer.listen(PORT, () => console.log(`[SERVER] Aethoria: Rift Wars running on http://localhost:${PORT}`));

// DB init runs after server is already up — never blocks serving files
DB.initDB().catch(e => console.error('[DB] Init failed:', e.message));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (!['admin', 'moderator', 'developer'].includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  });
}

function devMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'developer')
      return res.status(403).json({ error: 'Developer only' });
    next();
  });
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password || !email) return res.status(400).json({ error: 'Username, password and email are required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 chars' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const id = await DB.createUser(username, hash, email.toLowerCase());
    const token = crypto.randomBytes(32).toString('hex');
    await DB.setVerifyToken(id, token, Date.now() + 24 * 60 * 60 * 1000);
    const link = `${SITE_URL}/api/verify-email?token=${token}`;
    await sendEmail(email, 'Verify your Aethoria account', emailVerifyTemplate(username, link));
    res.json({ needs_verification: true, message: 'Account created! Check your email to verify before logging in.' });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already taken' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send(verifyPage('Invalid Link', 'No token provided.', false));
  const user = await DB.getUserByVerifyToken(token);
  if (!user) return res.send(verifyPage('Invalid Link', 'This link is invalid or has already been used.', false));
  if (Date.now() > user.email_verify_expires) {
    return res.send(verifyPage('Link Expired', 'This link has expired. Request a new one from the login screen.', false));
  }
  await DB.setEmailVerified(user.id);
  res.send(verifyPage('Email Verified!', `Welcome to Aethoria, <strong style="color:#dd99ff">${user.username}</strong>! Your account is now active. You can close this tab and log in.`, true));
});

function verifyPage(title, body, success) {
  const color = success ? '#00ffaa' : '#ff2244';
  return `<!DOCTYPE html><html><head><title>Aethoria – ${title}</title>
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#07071a;color:#f0f0ff;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;}</style>
  </head><body><div style="text-align:center;padding:40px;max-width:480px;">
  <div style="font-size:48px;margin-bottom:16px;">${success ? '✓' : '✗'}</div>
  <h1 style="color:${color};letter-spacing:4px;margin-bottom:16px;">${title}</h1>
  <p style="color:#99aaff;line-height:1.8;">${body}</p>
  <a href="${SITE_URL}" style="display:inline-block;margin-top:24px;color:#dd99ff;letter-spacing:2px;">← BACK TO GAME</a>
  </div></body></html>`;
}

app.post('/api/resend-verification', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const user = await DB.getUserByUsername(username);
    if (!user || !await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.email_verified) return res.json({ message: 'Already verified. You can log in.' });
    const token = crypto.randomBytes(32).toString('hex');
    await DB.setVerifyToken(user.id, token, Date.now() + 24 * 60 * 60 * 1000);
    const link = `${SITE_URL}/api/verify-email?token=${token}`;
    await sendEmail(user.email, 'Verify your Aethoria account', emailVerifyTemplate(user.username, link));
    res.json({ message: 'Verification email resent. Check your inbox.' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const user = await DB.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.is_banned) return res.status(403).json({ error: `Banned: ${user.ban_reason || 'Violation'}` });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.email_verified === 0) return res.status(403).json({ error: 'Please verify your email before logging in.', needs_verification: true });
    if (user.two_fa_enabled) {
      const code = generate6DigitCode();
      await DB.set2FACode(user.id, code, Date.now() + 10 * 60 * 1000);
      await sendEmail(user.email, 'Your Aethoria login code', email2FATemplate(user.username, code));
      const partial = jwt.sign({ id: user.id, type: 'tfa_pending' }, JWT_SECRET, { expiresIn: '10m' });
      return res.json({ requires_2fa: true, partial_token: partial });
    }
    await DB.updateLastLogin(user.id);
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, currency: user.currency, custom_title: user.custom_title, developer_mode: user.developer_mode, two_fa_enabled: !!user.two_fa_enabled, email: user.email, email_verified: !!user.email_verified },
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await DB.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const ranking = await DB.getRanking(user.id);
  const cosmetics = await DB.getUserCosmetics(user.id);
  const storyProgress = await DB.getStoryProgress(user.id);
  res.json({ ...user, password_hash: undefined, email_verify_token: undefined, two_fa_code: undefined, ranking, cosmetics, storyProgress });
});

// ─── 2FA ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/2fa/verify-login', async (req, res) => {
  const { partial_token, code } = req.body;
  if (!partial_token || !code) return res.status(400).json({ error: 'Missing fields' });
  let payload;
  try { payload = jwt.verify(partial_token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expired. Please log in again.' }); }
  if (payload.type !== 'tfa_pending') return res.status(401).json({ error: 'Invalid token type' });
  const user = await DB.getUserById(payload.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.two_fa_code || Date.now() > user.two_fa_code_expires) {
    return res.status(401).json({ error: 'Code expired. Please log in again.' });
  }
  if (user.two_fa_code !== code.trim()) return res.status(401).json({ error: 'Invalid code' });
  await DB.clear2FACode(user.id);
  await DB.updateLastLogin(user.id);
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, currency: user.currency, custom_title: user.custom_title, developer_mode: user.developer_mode, two_fa_enabled: true, email: user.email, email_verified: true },
  });
});

app.post('/api/2fa/setup', authMiddleware, async (req, res) => {
  const user = await DB.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.email_verified) return res.status(403).json({ error: 'Verify your email first' });
  if (user.two_fa_enabled) return res.status(400).json({ error: '2FA is already enabled' });
  const code = generate6DigitCode();
  await DB.set2FACode(user.id, code, Date.now() + 10 * 60 * 1000);
  await sendEmail(user.email, 'Enable 2FA on your Aethoria account', email2FATemplate(user.username, code));
  res.json({ message: 'Code sent to your email. Enter it to confirm 2FA setup.' });
});

app.post('/api/2fa/confirm-setup', authMiddleware, async (req, res) => {
  const { code } = req.body;
  const user = await DB.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.two_fa_code || Date.now() > user.two_fa_code_expires) return res.status(401).json({ error: 'Code expired. Start setup again.' });
  if (user.two_fa_code !== code?.trim()) return res.status(401).json({ error: 'Invalid code' });
  await DB.set2FAEnabled(user.id, true);
  res.json({ success: true, message: '2FA enabled successfully!' });
});

app.post('/api/2fa/disable', authMiddleware, async (req, res) => {
  const { code } = req.body;
  const user = await DB.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.two_fa_enabled) return res.status(400).json({ error: '2FA is not enabled' });
  // Require a code to disable — send one if not already pending
  if (!code) {
    const newCode = generate6DigitCode();
    await DB.set2FACode(user.id, newCode, Date.now() + 10 * 60 * 1000);
    await sendEmail(user.email, 'Disable 2FA on your Aethoria account', email2FATemplate(user.username, newCode));
    return res.json({ needs_code: true, message: 'A code has been sent to your email. Submit it to confirm disabling 2FA.' });
  }
  if (!user.two_fa_code || Date.now() > user.two_fa_code_expires) return res.status(401).json({ error: 'Code expired. Try again.' });
  if (user.two_fa_code !== code.trim()) return res.status(401).json({ error: 'Invalid code' });
  await DB.set2FAEnabled(user.id, false);
  res.json({ success: true, message: '2FA disabled.' });
});

// ─── FRIENDS ROUTES ───────────────────────────────────────────────────────────
app.get('/api/friends', authMiddleware, async (req, res) => {
  const friends = await DB.getFriends(req.user.id);
  const pending = await DB.getPendingRequests(req.user.id);
  res.json({ friends, pending });
});

app.post('/api/friends/request', authMiddleware, async (req, res) => {
  const target = await DB.getUserByUsername(req.body.username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: "Can't friend yourself" });
  await DB.sendFriendRequest(req.user.id, target.id);
  io.to(`user:${target.id}`).emit('friend_request', { from: req.user.username });
  res.json({ success: true });
});

app.post('/api/friends/accept', authMiddleware, async (req, res) => {
  await DB.acceptFriend(req.user.id, req.body.friendId);
  res.json({ success: true });
});

app.delete('/api/friends/:friendId', authMiddleware, async (req, res) => {
  await DB.removeFriend(req.user.id, parseInt(req.params.friendId));
  res.json({ success: true });
});

// ─── PARTY ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/party/create', authMiddleware, async (req, res) => {
  const code = uuidv4().slice(0, 8).toUpperCase();
  const partyId = await DB.createParty(req.user.id, code, req.body.gameMode || 'casual');
  res.json({ partyId, code });
});

app.post('/api/party/join', authMiddleware, async (req, res) => {
  const party = await DB.getPartyByCode(req.body.code);
  if (!party) return res.status(404).json({ error: 'Party not found' });
  if (party.status !== 'waiting') return res.status(400).json({ error: 'Party already started' });
  const members = await DB.getPartyMembers(party.id);
  if (members.length >= party.max_players) return res.status(400).json({ error: 'Party full' });
  await DB.joinParty(party.id, req.user.id);
  io.to(`party:${party.id}`).emit('party_update', { type: 'join', username: req.user.username });
  res.json({ partyId: party.id, party });
});

app.post('/api/party/:id/ready', authMiddleware, async (req, res) => {
  await DB.setPartyReady(req.params.id, req.user.id, req.body.character);
  const members = await DB.getPartyMembers(req.params.id);
  io.to(`party:${req.params.id}`).emit('party_update', { type: 'ready', members });
  if (members.every(m => m.ready)) {
    io.to(`party:${req.params.id}`).emit('party_start', { members });
  }
  res.json({ success: true });
});

app.delete('/api/party/:id/leave', authMiddleware, async (req, res) => {
  await DB.leaveParty(req.params.id, req.user.id);
  io.to(`party:${req.params.id}`).emit('party_update', { type: 'leave', username: req.user.username });
  res.json({ success: true });
});

// ─── COSMETICS ROUTES ─────────────────────────────────────────────────────────
app.get('/api/cosmetics', authMiddleware, async (req, res) => {
  const all = await DB.getCosmetics(req.query.character || 'ALL');
  const owned = await DB.getUserCosmetics(req.user.id);
  const ownedIds = new Set(owned.map(c => c.id));
  res.json(all.map(c => ({ ...c, owned: ownedIds.has(c.id) })));
});

app.post('/api/cosmetics/buy', authMiddleware, async (req, res) => {
  try {
    await DB.purchaseCosmetic(req.user.id, req.body.cosmeticId);
    const user = await DB.getUserById(req.user.id);
    res.json({ success: true, currency: user.currency });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/cosmetics/equip', authMiddleware, async (req, res) => {
  await DB.equipCosmetic(req.user.id, req.body.cosmeticId);
  res.json({ success: true });
});

// ─── RANKINGS ────────────────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  const board = await DB.getLeaderboard(50);
  res.json(board);
});

app.get('/api/rankings/:userId', async (req, res) => {
  const ranking = await DB.getRanking(parseInt(req.params.userId));
  res.json(ranking);
});

// ─── STORY ────────────────────────────────────────────────────────────────────
app.get('/api/story', authMiddleware, async (req, res) => {
  const progress = await DB.getStoryProgress(req.user.id);
  res.json(progress);
});

app.post('/api/story/save', authMiddleware, async (req, res) => {
  const { characterId, chapter, completed } = req.body;
  await DB.saveStoryProgress(req.user.id, characterId, chapter, completed);
  if (completed) {
    await DB.updateCurrency(req.user.id, 250);
    await DB.logTransaction(req.user.id, 250, 'story_reward', `Completed ${characterId} story`);
  }
  res.json({ success: true });
});

// ─── MATCH HISTORY ────────────────────────────────────────────────────────────
app.get('/api/matches', authMiddleware, async (req, res) => {
  const history = await DB.getMatchHistory(req.user.id, 20);
  res.json(history);
});

// ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
app.get('/api/announcements', async (req, res) => {
  const announcements = await DB.getAnnouncements();
  const motd = await DB.getMotd();
  res.json({ announcements, motd });
});

// ─── REPORTS ─────────────────────────────────────────────────────────────────
app.post('/api/report', authMiddleware, async (req, res) => {
  const { reportedUsername, reason, description } = req.body;
  const reported = await DB.getUserByUsername(reportedUsername);
  if (!reported) return res.status(404).json({ error: 'User not found' });
  await DB.createReport(req.user.id, reported.id, reason, description);
  res.json({ success: true });
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
const adminCmds = {
  ban_player: async (admin, { userId, reason, expires }) => {
    await DB.banUser(userId, reason, expires);
    await DB.logAdminAction(admin.id, 'ban_player', userId, { reason });
    io.to(`user:${userId}`).emit('banned', { reason });
    return { success: true };
  },
  unban_player: async (admin, { userId }) => {
    await DB.unbanUser(userId);
    await DB.logAdminAction(admin.id, 'unban_player', userId, {});
    return { success: true };
  },
  mute_player: async (admin, { userId, duration }) => {
    await DB.logAdminAction(admin.id, 'mute_player', userId, { duration });
    io.to(`user:${userId}`).emit('muted', { duration });
    return { success: true };
  },
  unmute_player: async (admin, { userId }) => {
    await DB.logAdminAction(admin.id, 'unmute_player', userId, {});
    io.to(`user:${userId}`).emit('unmuted');
    return { success: true };
  },
  grant_currency: async (admin, { userId, amount, reason }) => {
    await DB.updateCurrency(userId, amount);
    await DB.logTransaction(userId, amount, 'admin_grant', reason, admin.id);
    await DB.logAdminAction(admin.id, 'grant_currency', userId, { amount, reason });
    io.to(`user:${userId}`).emit('currency_update', { amount });
    return { success: true };
  },
  remove_currency: async (admin, { userId, amount, reason }) => {
    await DB.updateCurrency(userId, -Math.abs(amount));
    await DB.logTransaction(userId, -Math.abs(amount), 'admin_remove', reason, admin.id);
    await DB.logAdminAction(admin.id, 'remove_currency', userId, { amount });
    return { success: true };
  },
  view_player: async (admin, { userId }) => {
    const user = await DB.getUserById(userId);
    const ranking = await DB.getRanking(userId);
    const history = await DB.getMatchHistory(userId, 10);
    return { user: { ...user, password_hash: '[HIDDEN]' }, ranking, history };
  },
  kick_from_match: async (admin, { userId }) => {
    io.to(`user:${userId}`).emit('force_disconnect', { reason: 'Kicked by admin' });
    await DB.logAdminAction(admin.id, 'kick_from_match', userId, {});
    return { success: true };
  },
  view_match_history: async (admin, { userId, limit }) => DB.getMatchHistory(userId, limit || 20),
  view_server_stats: async (admin) => DB.getServerStats(),
  broadcast_message: async (admin, { message }) => {
    io.emit('broadcast', { message, from: 'SERVER' });
    await DB.logAdminAction(admin.id, 'broadcast_message', null, { message });
    return { success: true };
  },
  view_reports: async (admin, { status }) => DB.getReports(status),
  resolve_report: async (admin, { reportId }) => {
    await DB.resolveReport(reportId, admin.id);
    return { success: true };
  },
  reset_player_stats: async (admin, { userId }) => {
    await DB.db.execute({ sql: 'UPDATE users SET total_wins=0,total_losses=0,total_matches=0 WHERE id=?', args: [userId] });
    await DB.logAdminAction(admin.id, 'reset_player_stats', userId, {});
    return { success: true };
  },
  force_disconnect: async (admin, { userId }) => {
    io.to(`user:${userId}`).emit('force_disconnect', { reason: 'Admin action' });
    return { success: true };
  },
  view_active_matches: async (admin) => {
    return { matches: [...gameRooms.values()].map(r => ({ id: r.id, players: r.players.map(p => p.username), stage: r.stage })) };
  },
  moderate_chat: async (admin, { messageId }) => {
    await DB.deleteChatMessage(messageId);
    return { success: true };
  },
  view_logs: async (admin, { limit }) => DB.getAdminLogs(limit || 50),
  create_tournament: async (admin, { name, maxPlayers, prize, rules, startsAt }) => {
    const id = await DB.createTournament(name, admin.id, maxPlayers, prize, rules, startsAt);
    await DB.logAdminAction(admin.id, 'create_tournament', null, { name, id });
    return { id };
  },
  verify_player: async (admin, { userId }) => {
    await DB.setCustomTitle(userId, 'Verified');
    return { success: true };
  },
  warn_player: async (admin, { userId, message }) => {
    io.to(`user:${userId}`).emit('warning', { message });
    await DB.logAdminAction(admin.id, 'warn_player', userId, { message });
    return { success: true };
  },
  // ─── DEVELOPER-ONLY COMMANDS (100 extra) ──────────────────────────────────
  delete_player_account: async (admin, { userId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.deleteUser(userId);
    await DB.logAdminAction(admin.id, 'delete_player_account', userId, {});
    return { success: true };
  },
  set_player_role: async (admin, { userId, role }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.setUserRole(userId, role);
    await DB.logAdminAction(admin.id, 'set_player_role', userId, { role });
    return { success: true };
  },
  execute_sql: async (admin, { sql: query, args }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const result = await DB.db.execute({ sql: query, args: args || [] });
    await DB.logAdminAction(admin.id, 'execute_sql', null, { query });
    return result;
  },
  bulk_ban: async (admin, { userIds, reason }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    for (const id of userIds) await DB.banUser(id, reason);
    await DB.logAdminAction(admin.id, 'bulk_ban', null, { count: userIds.length, reason });
    return { success: true, count: userIds.length };
  },
  bulk_grant_currency: async (admin, { userIds, amount }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    for (const id of userIds) await DB.updateCurrency(id, amount);
    return { success: true };
  },
  create_admin: async (admin, { userId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.setUserRole(userId, 'admin');
    await DB.logAdminAction(admin.id, 'create_admin', userId, {});
    return { success: true };
  },
  revoke_admin: async (admin, { userId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.setUserRole(userId, 'player');
    return { success: true };
  },
  set_maintenance: async (admin, { enabled }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    serverMaintenance = enabled;
    if (enabled) io.emit('maintenance', { message: 'Server going into maintenance mode' });
    return { success: true };
  },
  view_all_users: async (admin, { limit, offset }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    return DB.getAllUsers(limit || 100, offset || 0);
  },
  search_users: async (admin, { query }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    return DB.searchUsers(query);
  },
  reset_all_rankings: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: 'UPDATE rankings SET elo=1000,wins=0,losses=0,draws=0,season_elo=1000', args: [] });
    return { success: true };
  },
  create_cosmetic: async (admin, { characterId, name, type, price, rarity, description, colorData }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const id = await DB.createCosmetic(characterId, name, type, price, rarity, description, colorData);
    return { id };
  },
  delete_cosmetic: async (admin, { cosmeticId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: 'DELETE FROM cosmetics WHERE id=?', args: [cosmeticId] });
    return { success: true };
  },
  modify_cosmetic_price: async (admin, { cosmeticId, price }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: 'UPDATE cosmetics SET price=? WHERE id=?', args: [price, cosmeticId] });
    return { success: true };
  },
  grant_all_cosmetics: async (admin, { userId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const all = await DB.getCosmetics('ALL');
    for (const c of all) await DB.grantCosmetic(userId, c.id);
    return { success: true, count: all.length };
  },
  set_global_currency_multiplier: async (admin, { multiplier }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    globalCurrencyMultiplier = multiplier;
    io.emit('economy_update', { multiplier });
    return { success: true };
  },
  modify_character_stats: async (admin, { characterId, statKey, value }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.setBalanceOverride(characterId, statKey, value, admin.id);
    io.emit('balance_update', { characterId, statKey, value });
    return { success: true };
  },
  revert_character_stats: async (admin, { characterId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.revertBalance(characterId);
    io.emit('balance_revert', { characterId });
    return { success: true };
  },
  get_balance_overrides: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    return DB.getBalanceOverrides();
  },
  get_character_usage_stats: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const r = await DB.db.execute({
      sql: `SELECT character1 as char, COUNT(*) as p1_uses FROM matches GROUP BY character1
            UNION ALL SELECT character2, COUNT(*) FROM matches WHERE character2 IS NOT NULL GROUP BY character2`,
      args: [],
    });
    return r.rows;
  },
  void_match: async (admin, { matchId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.voidMatch(matchId);
    return { success: true };
  },
  force_match_result: async (admin, { matchId, winnerId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: 'UPDATE matches SET winner_id=? WHERE id=?', args: [winnerId, matchId] });
    return { success: true };
  },
  get_network_stats: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    return {
      connected_sockets: io.sockets.sockets.size,
      active_rooms: gameRooms.size,
      matchmaking_queue: matchmakingQueue.length,
      maintenance: serverMaintenance,
      currency_multiplier: globalCurrencyMultiplier,
    };
  },
  dissolve_party: async (admin, { partyId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    io.to(`party:${partyId}`).emit('party_dissolved', { reason: 'Admin action' });
    await DB.dissolveParty(partyId);
    return { success: true };
  },
  start_tournament: async (admin, { tournamentId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: "UPDATE tournaments SET status='active' WHERE id=?", args: [tournamentId] });
    io.emit('tournament_start', { tournamentId });
    return { success: true };
  },
  end_tournament: async (admin, { tournamentId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: "UPDATE tournaments SET status='ended',ended_at=datetime('now') WHERE id=?", args: [tournamentId] });
    return { success: true };
  },
  distribute_season_rewards: async (admin, { seasonId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const top = await DB.getLeaderboard(10);
    const rewards = [1000, 750, 500, 400, 300, 250, 200, 150, 100, 100];
    for (let i = 0; i < top.length; i++) {
      const user = await DB.getUserByUsername(top[i].username);
      if (user) {
        await DB.updateCurrency(user.id, rewards[i]);
        await DB.logTransaction(user.id, rewards[i], 'season_reward', `Season ${seasonId} placement #${i + 1}`, admin.id);
      }
    }
    await DB.endSeason(seasonId, { top10: top });
    return { success: true };
  },
  get_economy_stats: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    return DB.getEconomyStats();
  },
  get_purchase_history: async (admin, { userId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    return DB.getPurchaseHistory(userId, 100);
  },
  set_developer_mode: async (admin, { userId, enabled }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: 'UPDATE users SET developer_mode=? WHERE id=?', args: [enabled ? 1 : 0, userId] });
    return { success: true };
  },
  set_custom_title: async (admin, { userId, title }) => {
    await DB.setCustomTitle(userId, title);
    return { success: true };
  },
  remove_custom_title: async (admin, { userId }) => {
    await DB.setCustomTitle(userId, null);
    return { success: true };
  },
  create_announcement: async (admin, { title, content, pinned }) => {
    await DB.createAnnouncement(title, content, admin.id, pinned);
    io.emit('announcement', { title, content });
    return { success: true };
  },
  delete_announcement: async (admin, { id }) => {
    await DB.deleteAnnouncement(id);
    return { success: true };
  },
  set_motd: async (admin, { message }) => {
    await DB.setMotd(message, admin.id);
    io.emit('motd', { message });
    return { success: true };
  },
  view_story_progress_all: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const r = await DB.db.execute({ sql: 'SELECT sp.*,u.username FROM story_progress sp JOIN users u ON u.id=sp.user_id', args: [] });
    return r.rows;
  },
  reset_story_progress: async (admin, { userId, characterId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    if (characterId) {
      await DB.db.execute({ sql: 'DELETE FROM story_progress WHERE user_id=? AND character_id=?', args: [userId, characterId] });
    } else {
      await DB.db.execute({ sql: 'DELETE FROM story_progress WHERE user_id=?', args: [userId] });
    }
    return { success: true };
  },
  unlock_story_chapter: async (admin, { userId, characterId, chapter }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.saveStoryProgress(userId, characterId, chapter, false);
    return { success: true };
  },
  clear_all_chat_logs: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: 'UPDATE chat_logs SET is_deleted=1', args: [] });
    return { success: true };
  },
  clear_room_chat: async (admin, { room }) => {
    await DB.clearRoomChat(room);
    return { success: true };
  },
  flag_player: async (admin, { userId, reason }) => {
    await DB.db.execute({ sql: "INSERT INTO reports (reporter_id,reported_id,reason,description) VALUES (?,?,?,'Admin flag')", args: [admin.id, userId, reason] });
    return { success: true };
  },
  set_season: async (admin, { name }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: "UPDATE seasons SET status='ended' WHERE status='active'", args: [] });
    await DB.db.execute({ sql: "INSERT INTO seasons (name,status) VALUES (?,'active')", args: [name] });
    return { success: true };
  },
  get_chat_logs: async (admin, { room, limit }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    return DB.getChatLogs(room || 'global', limit || 100);
  },
  send_direct_message: async (admin, { userId, message }) => {
    io.to(`user:${userId}`).emit('system_message', { message });
    return { success: true };
  },
  create_in_game_event: async (admin, { eventType, duration, data }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    io.emit('world_event', { eventType, duration, data });
    return { success: true };
  },
  set_character_lore: async (admin, { characterId, field, value }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    io.emit('lore_update', { characterId, field, value });
    return { success: true };
  },
  emergency_shutdown: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    io.emit('server_shutdown', { message: 'Emergency shutdown initiated' });
    await DB.logAdminAction(admin.id, 'emergency_shutdown', null, {});
    setTimeout(() => process.exit(0), 2000);
    return { success: true };
  },
  benchmark_server: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const start = Date.now();
    await DB.getServerStats();
    const elapsed = Date.now() - start;
    return { db_query_ms: elapsed, memory: process.memoryUsage(), uptime: process.uptime() };
  },
  toggle_elemental_reactions: async (admin, { enabled }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    globalFlags.elementalReactions = enabled;
    io.emit('flag_update', { elementalReactions: enabled });
    return { success: true };
  },
  get_global_flags: async (admin) => {
    return globalFlags;
  },
  set_global_flag: async (admin, { flag, value }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    globalFlags[flag] = value;
    io.emit('flag_update', { [flag]: value });
    return { success: true };
  },

  // ─── FUN DEVELOPER COMMANDS ───────────────────────────────────────────────
  chaos_mode: async (admin, { enabled }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    // Randomly scramble all character stats by ±30%
    const chars = ['NEON_RYU','VHS_VIPER','ARCADE_TITAN','TURBO_KID','PIXEL_PIRATE',
      'SYNTH_SAMURAI','GLITCH_WITCH','BIT_CRUSHER','RETRO_RANGER','VENOM_VOODOO',
      'FROST_VALKYRIE','INFERNO_BRAWLER','SHADOW_BEAST'];
    if (enabled) {
      for (const c of chars) {
        for (const stat of ['speed','jumpStrength','weight']) {
          const mult = 0.7 + Math.random() * 0.6;
          await DB.setBalanceOverride(c, stat, Math.round(mult * 10) / 10, admin.id);
        }
      }
      io.emit('broadcast', { message: '⚡ CHAOS MODE ACTIVATED — all character stats scrambled!' });
    } else {
      for (const c of chars) await DB.revertBalance(c);
      io.emit('broadcast', { message: '✅ Chaos mode deactivated — stats restored.' });
    }
    return { success: true, chaos: enabled };
  },

  give_everyone_currency: async (admin, { amount }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const users = await DB.getAllUsers(9999, 0);
    for (const u of users.users || users) {
      await DB.updateCurrency(u.id, amount);
    }
    io.emit('broadcast', { message: `💎 ${admin.username} gifted everyone ${amount} Rift Shards!` });
    return { success: true, recipients: (users.users || users).length };
  },

  summon_rift_event: async (admin, { type }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const events = {
      meteor: { msg: '☄️ METEOR SHOWER — dodge or die!', duration: 30000 },
      gravity: { msg: '🌀 ZERO GRAVITY EVENT — floaty fights!', duration: 20000 },
      golden: { msg: '✨ GOLDEN HOUR — 3x currency drops for 10 minutes!', duration: 600000 },
      blackout: { msg: '🌑 BLACKOUT — can you fight in the dark?', duration: 15000 },
      speed: { msg: '💨 SPEED RUSH — everyone moves 2x faster!', duration: 30000 },
    };
    const ev = events[type] || { msg: `🎮 ${type} event started!`, duration: 30000 };
    io.emit('world_event', { eventType: type, duration: ev.duration, data: {} });
    io.emit('broadcast', { message: ev.msg });
    await DB.logAdminAction(admin.id, 'summon_rift_event', null, { type });
    return { success: true, event: type, duration: ev.duration };
  },

  unlock_all_for_everyone: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const users = await DB.getAllUsers(9999, 0);
    const cosmetics = await DB.getCosmetics('ALL');
    let count = 0;
    for (const u of (users.users || users)) {
      for (const c of cosmetics) {
        await DB.grantCosmetic(u.id, c.id).catch(() => {});
        count++;
      }
    }
    io.emit('broadcast', { message: '🎁 All cosmetics unlocked for all players!' });
    return { success: true, granted: count };
  },

  rename_server: async (admin, { name }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    io.emit('broadcast', { message: `🏷️ Server renamed to: ${name}` });
    await DB.setMotd(`Welcome to ${name}`, admin.id);
    return { success: true };
  },

  clone_player: async (admin, { userId }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const user = await DB.getUserById(userId);
    if (!user) return { error: 'User not found' };
    const clone = await DB.createUser(
      user.username + '_CLONE_' + Date.now().toString(36).slice(-4),
      user.password_hash,
      null
    );
    return { success: true, cloneId: clone, original: user.username };
  },

  flip_gravity: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    globalFlags.flipGravity = !globalFlags.flipGravity;
    io.emit('flag_update', globalFlags);
    io.emit('broadcast', { message: globalFlags.flipGravity ? '🙃 GRAVITY FLIPPED — the world is upside down!' : '😮‍💨 Gravity restored.' });
    return { success: true, flipped: globalFlags.flipGravity };
  },

  giant_mode: async (admin, { userId, enabled }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    io.to(`user:${userId}`).emit('giant_mode', { enabled });
    io.emit('broadcast', { message: enabled ? `👾 GIANT MODE activated for user ${userId}!` : `Giant mode off.` });
    return { success: true };
  },

  spawn_coins_rain: async (admin, { amount }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const users = await DB.getAllUsers(9999, 0);
    const list = users.users || users;
    const each = Math.floor(amount / list.length) || 1;
    for (const u of list) await DB.updateCurrency(u.id, each);
    io.emit('world_event', { eventType: 'coin_rain', duration: 5000, data: { amount: each } });
    io.emit('broadcast', { message: `🌧️ COIN RAIN! Everyone got ${each} Rift Shards!` });
    return { success: true, perPlayer: each };
  },

  wipe_all_bans: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: "UPDATE users SET is_banned=0, ban_reason=NULL, ban_expires=NULL", args: [] });
    io.emit('broadcast', { message: '🕊️ All bans have been wiped. Fresh start.' });
    return { success: true };
  },

  set_all_titles: async (admin, { title }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    await DB.db.execute({ sql: 'UPDATE users SET custom_title=?', args: [title] });
    io.emit('broadcast', { message: `🏆 Everyone is now titled: [${title}]` });
    return { success: true };
  },

  dev_broadcast_styled: async (admin, { message, style }) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const prefixes = { warning: '⚠️', hype: '🔥', info: 'ℹ️', lore: '📜', secret: '🔐' };
    const prefix = prefixes[style] || '📢';
    io.emit('broadcast', { message: `${prefix} [DEV] ${message}` });
    await DB.logAdminAction(admin.id, 'dev_broadcast_styled', null, { message, style });
    return { success: true };
  },

  reset_everyone_damage: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    io.emit('reset_match_state', {});
    return { success: true };
  },

  godmode_self: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    io.to(`user:${admin.id}`).emit('godmode', { enabled: true });
    return { success: true, message: 'You are now invincible.' };
  },

  server_status_full: async (admin) => {
    if (admin.role !== 'developer') throw new Error('Developer only');
    const stats = await DB.getServerStats();
    return {
      ...stats,
      uptime_seconds: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      node_version: process.version,
      active_sockets: io.sockets.sockets.size,
      queue_length: matchmakingQueue.length,
      active_rooms: gameRooms.size,
      maintenance: serverMaintenance,
      global_flags: globalFlags,
      currency_multiplier: globalCurrencyMultiplier,
    };
  },
};

// ─── ADMIN ENDPOINT ───────────────────────────────────────────────────────────
app.post('/api/admin/command', adminMiddleware, async (req, res) => {
  const { command, params } = req.body;
  const handler = adminCmds[command];
  if (!handler) return res.status(400).json({ error: `Unknown command: ${command}` });
  try {
    const result = await handler(req.user, params || {});
    res.json(result);
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.get('/api/admin/commands', adminMiddleware, (req, res) => {
  const allCmds = Object.keys(adminCmds);
  const devOnlyCmds = ['delete_player_account','set_player_role','execute_sql','bulk_ban','bulk_grant_currency',
    'create_admin','revoke_admin','set_maintenance','view_all_users','search_users','reset_all_rankings',
    'create_cosmetic','delete_cosmetic','modify_cosmetic_price','grant_all_cosmetics','set_global_currency_multiplier',
    'modify_character_stats','revert_character_stats','get_balance_overrides','get_character_usage_stats',
    'void_match','force_match_result','get_network_stats','dissolve_party','start_tournament','end_tournament',
    'distribute_season_rewards','get_economy_stats','get_purchase_history','set_developer_mode',
    'view_story_progress_all','reset_story_progress','unlock_story_chapter','clear_all_chat_logs','get_chat_logs',
    'send_direct_message','create_in_game_event','set_character_lore','emergency_shutdown','benchmark_server',
    'toggle_elemental_reactions','get_global_flags','set_global_flag','set_season',
  ];
  const available = req.user.role === 'developer' ? allCmds : allCmds.filter(c => !devOnlyCmds.includes(c));
  res.json({ commands: available, total: available.length, role: req.user.role });
});

// ─── GLOBAL STATE ─────────────────────────────────────────────────────────────
let serverMaintenance = false;
let globalCurrencyMultiplier = 1;
const globalFlags = { elementalReactions: true, comboSystem: true, ranked: true };
const matchmakingQueue = [];
const gameRooms = new Map();

// ─── MATCHMAKING ──────────────────────────────────────────────────────────────
function tryMatch() {
  if (matchmakingQueue.length < 2) return;
  const p1 = matchmakingQueue.shift();
  const p2 = matchmakingQueue.shift();
  const roomId = uuidv4();
  const room = { id: roomId, players: [p1, p2], state: null, stage: 'VERDANT_THRONE', frame: 0 };
  gameRooms.set(roomId, room);
  io.to(p1.socketId).emit('match_found', { roomId, opponent: p2.username, playerIndex: 0 });
  io.to(p2.socketId).emit('match_found', { roomId, opponent: p1.username, playerIndex: 1 });
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const { id: userId, username } = socket.user;
  socket.join(`user:${userId}`);
  console.log(`[WS] ${username} connected`);

  socket.on('join_party', (partyId) => socket.join(`party:${partyId}`));

  socket.on('join_matchmaking', async (data) => {
    if (serverMaintenance) return socket.emit('error', { message: 'Server in maintenance' });
    const existing = matchmakingQueue.findIndex(p => p.userId === userId);
    if (existing !== -1) return;
    matchmakingQueue.push({ userId, username, socketId: socket.id, character: data.character, ranked: data.ranked });
    socket.emit('matchmaking_joined', { position: matchmakingQueue.length });
    tryMatch();
  });

  socket.on('leave_matchmaking', () => {
    const idx = matchmakingQueue.findIndex(p => p.userId === userId);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);
  });

  socket.on('join_room', (roomId) => {
    socket.join(`room:${roomId}`);
  });

  socket.on('game_input', async (data) => {
    const { roomId, input, frame } = data;
    const room = gameRooms.get(roomId);
    if (!room) return;
    socket.to(`room:${roomId}`).emit('opponent_input', { input, frame, username });
  });

  socket.on('game_state_sync', (data) => {
    const { roomId, state } = data;
    const room = gameRooms.get(roomId);
    if (!room) return;
    room.state = state;
    socket.to(`room:${roomId}`).emit('state_sync', { state, frame: room.frame++ });
  });

  socket.on('match_result', async (data) => {
    const { roomId, winnerId, loserId, character1, character2, stage, duration, replayData } = data;
    const room = gameRooms.get(roomId);
    if (!room) return;
    gameRooms.delete(roomId);
    const matchId = await DB.createMatch(winnerId, loserId, character1, character2, stage, 'ranked', true);
    await DB.finishMatch(matchId, winnerId, duration, replayData);
    await DB.updateWinLoss(winnerId, loserId);
    const winnerDelta = 25 * globalCurrencyMultiplier;
    const loserDelta = 10 * globalCurrencyMultiplier;
    await DB.updateElo(winnerId, 25);
    await DB.updateElo(loserId, -15);
    await DB.updateCurrency(winnerId, Math.floor(winnerDelta));
    await DB.updateCurrency(loserId, Math.floor(loserDelta));
    io.to(`user:${winnerId}`).emit('match_complete', { result: 'win', eloChange: 25, currencyEarned: Math.floor(winnerDelta) });
    io.to(`user:${loserId}`).emit('match_complete', { result: 'loss', eloChange: -15, currencyEarned: Math.floor(loserDelta) });
  });

  socket.on('chat_message', async (data) => {
    const { room, message } = data;
    if (!message || message.length > 200) return;
    await DB.logChat(userId, room, message);
    io.to(room === 'global' ? null : `room:${room}`).emit('chat', { username, message, userId });
    if (room === 'global') io.emit('chat', { username, message, userId });
  });

  socket.on('disconnect', () => {
    const idx = matchmakingQueue.findIndex(p => p.userId === userId);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);
    console.log(`[WS] ${username} disconnected`);
  });
});
