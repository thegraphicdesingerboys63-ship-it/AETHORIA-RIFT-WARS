import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import * as DB from './db.js';

dotenv.config();
await DB.initDB();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'aethoria_secret_key_change_in_prod';

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

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
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 chars' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const id = await DB.createUser(username, hash, email);
    const token = jwt.sign({ id, username, role: 'player' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, username, role: 'player', currency: 500 } });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email taken' });
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
    await DB.updateLastLogin(user.id);
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, currency: user.currency, custom_title: user.custom_title, developer_mode: user.developer_mode },
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
  res.json({ ...user, password_hash: undefined, ranking, cosmetics, storyProgress });
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

httpServer.listen(PORT, () => console.log(`[SERVER] Aethoria: Rift Wars running on http://localhost:${PORT}`));
