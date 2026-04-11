import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
dotenv.config();

let db;
try {
  db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:aethoria.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
} catch(e) {
  console.error('[DB] Failed to create client:', e.message);
  db = null;
}
export { db };

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
export async function initDB() {
  if (!db) { console.error('[DB] No client — skipping init'); return; }
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email TEXT UNIQUE,
      email_verified INTEGER DEFAULT 0,
      email_verify_token TEXT,
      email_verify_expires INTEGER,
      two_fa_enabled INTEGER DEFAULT 0,
      two_fa_code TEXT,
      two_fa_code_expires INTEGER,
      role TEXT NOT NULL DEFAULT 'player',
      currency INTEGER NOT NULL DEFAULT 500,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT,
      is_banned INTEGER DEFAULT 0,
      ban_reason TEXT,
      ban_expires TEXT,
      custom_title TEXT,
      developer_mode INTEGER DEFAULT 0,
      total_wins INTEGER DEFAULT 0,
      total_losses INTEGER DEFAULT 0,
      total_matches INTEGER DEFAULT 0,
      avatar_cosmetic INTEGER DEFAULT 0,
      backup_code TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, friend_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(friend_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL,
      code TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'waiting',
      max_players INTEGER DEFAULT 4,
      game_mode TEXT DEFAULT 'casual',
      stage TEXT DEFAULT 'VERDANT_THRONE',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(host_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS party_members (
      party_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      character_id TEXT,
      ready INTEGER DEFAULT 0,
      joined_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(party_id, user_id),
      FOREIGN KEY(party_id) REFERENCES parties(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS cosmetics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      price INTEGER NOT NULL,
      rarity TEXT DEFAULT 'common',
      description TEXT,
      color_data TEXT,
      is_special INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS user_cosmetics (
      user_id INTEGER NOT NULL,
      cosmetic_id INTEGER NOT NULL,
      equipped INTEGER DEFAULT 0,
      purchased_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(user_id, cosmetic_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(cosmetic_id) REFERENCES cosmetics(id)
    )`,
    `CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player1_id INTEGER NOT NULL,
      player2_id INTEGER,
      winner_id INTEGER,
      character1 TEXT NOT NULL,
      character2 TEXT,
      stage TEXT NOT NULL,
      game_mode TEXT DEFAULT 'casual',
      duration INTEGER,
      is_ranked INTEGER DEFAULT 0,
      is_voided INTEGER DEFAULT 0,
      replay_data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS rankings (
      user_id INTEGER PRIMARY KEY,
      elo INTEGER DEFAULT 1000,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      peak_elo INTEGER DEFAULT 1000,
      season_elo INTEGER DEFAULT 1000,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS story_progress (
      user_id INTEGER NOT NULL,
      character_id TEXT NOT NULL,
      chapter INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      completed_at TEXT,
      PRIMARY KEY(user_id, character_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS admin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      command TEXT NOT NULL,
      target_id INTEGER,
      data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL,
      reported_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      resolved_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      creator_id INTEGER NOT NULL,
      status TEXT DEFAULT 'registration',
      max_players INTEGER DEFAULT 16,
      prize_currency INTEGER DEFAULT 0,
      rules TEXT,
      starts_at TEXT,
      ended_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS tournament_participants (
      tournament_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      seed INTEGER,
      placement INTEGER,
      PRIMARY KEY(tournament_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      creator_id INTEGER NOT NULL,
      is_pinned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      admin_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      rewards TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      room TEXT NOT NULL,
      message TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS balance_overrides (
      character_id TEXT NOT NULL,
      stat_key TEXT NOT NULL,
      value REAL NOT NULL,
      set_by INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(character_id, stat_key)
    )`,
    `CREATE TABLE IF NOT EXISTS motd (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      set_by INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  ];

  for (const sql of tables) {
    await db.execute(sql);
  }

  // Add backup_code column to existing databases that predate this schema
  try { await db.execute('ALTER TABLE users ADD COLUMN backup_code TEXT'); } catch {}

  try {
    await seedData();
  } catch (e) {
    console.error('[DB] Seed error (non-fatal):', e.message);
  }
  console.log('[DB] Schema initialized');
}


async function seedData() {
  // Developer account AMGProdZ
  const existing = await db.execute({
    sql: 'SELECT id FROM users WHERE username = ?',
    args: ['AMGProdZ'],
  });
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash('202Aa61248', 12);
    await db.execute({
      sql: `INSERT INTO users (username, password_hash, email, email_verified, role, currency, developer_mode)
            VALUES (?, ?, ?, 1, ?, ?, ?)`,
      args: ['AMGProdZ', hash, 'thegraphicdesingerboys63@gmail.com', 'developer', 999999, 1],
    });
    const devUser = await db.execute({ sql: "SELECT id FROM users WHERE username='AMGProdZ'", args: [] });
    const devId = devUser.rows[0].id;
    await db.execute({ sql: 'INSERT OR IGNORE INTO rankings (user_id) VALUES (?)', args: [devId] });
    console.log('[DB] Developer account AMGProdZ created');
  } else {
    // Ensure existing AMGProdZ account has email and is verified
    await db.execute({
      sql: `UPDATE users SET email='thegraphicdesingerboys63@gmail.com', email_verified=1 WHERE username='AMGProdZ'`,
      args: [],
    });
  }

  // Seed base cosmetics — re-seed if old placeholder IDs (PYROS, GLACIS, etc.) are present
  const oldIds = await db.execute({ sql: "SELECT COUNT(*) as c FROM cosmetics WHERE character_id='NEON_RYU'", args: [] });
  if (oldIds.rows[0].c === 0) {
    await db.execute({ sql: 'DELETE FROM user_cosmetics', args: [] });
    await db.execute({ sql: 'DELETE FROM cosmetics', args: [] });
    const cosmetics = [
      // ── NEON RYU (LIGHTNING) ──────────────────────────────────────────────
      ['NEON_RYU','Static Surge','skin',300,'common',
        'The exact charge that ran through Ryu\'s veins the night Voltcity went dark. He stopped fearing it. He became it.',
        '{"primary":"#ffff44","secondary":"#4466ff"}'],
      ['NEON_RYU','Crimson Circuit','skin',800,'rare',
        'A battle-worn recolor from the underground circuits of Sector 7. Only fighters who survived wear red.',
        '{"primary":"#cc1100","secondary":"#440000"}'],

      // ── VHS VIPER (SHADOW) ────────────────────────────────────────────────
      ['VHS_VIPER','Ghost Signal','skin',300,'common',
        'The tape warped and rewound so many times it started decoding wrong. The result: a frequency that looks like absence.',
        '{"primary":"#ddddff","secondary":"#8888aa"}'],
      ['VHS_VIPER','Neon Corrupt','skin',800,'rare',
        'What happens when static meets a rift surge. Every frame of her past glitches into something unrecognizable — and dangerous.',
        '{"primary":"#ff44ff","secondary":"#220033"}'],

      // ── ARCADE TITAN (EARTH) ──────────────────────────────────────────────
      ['ARCADE_TITAN','Bronze Cabinet','skin',300,'common',
        'Cabinet Unit 3-UP\'s original casing, preserved beneath decades of pixel patina. Older than any arcade hall still standing.',
        '{"primary":"#8B7355","secondary":"#A0522D"}'],
      ['ARCADE_TITAN','Player 2','skin',800,'rare',
        'A second-player variant born when the rift split 3-UP\'s consciousness in two. The other one is still out there somewhere.',
        '{"primary":"#2244cc","secondary":"#ffdd00"}'],

      // ── TURBO KID (FIRE) ──────────────────────────────────────────────────
      ['TURBO_KID','Ember Rush','skin',300,'common',
        'The blaze from the Rift Colosseum qualifiers. He wore these colors the day he became legend — and the day he stopped being afraid.',
        '{"primary":"#FF6B35","secondary":"#FFD700"}'],
      ['TURBO_KID','Inferno King','skin',800,'rare',
        'What the crowd saw when he stopped holding back in the finals. The stadium still has scorch marks on the walls.',
        '{"primary":"#FF0000","secondary":"#8B0000"}'],

      // ── PIXEL PIRATE (WATER) ──────────────────────────────────────────────
      ['PIXEL_PIRATE','Deep Trench','skin',300,'common',
        'The deep-water hues of the Neon Seas trench where his ship, the Nullbyte, now rests. He doesn\'t mourn it. He dives.',
        '{"primary":"#000080","secondary":"#4169E1"}'],
      ['PIXEL_PIRATE','Golden Corsair','skin',800,'rare',
        'Looted from a rift-spawn merchant vessel. Captain Hex doesn\'t ask where treasure comes from — only where it\'s going.',
        '{"primary":"#cc9900","secondary":"#002244"}'],

      // ── SYNTH SAMURAI (WIND) ──────────────────────────────────────────────
      ['SYNTH_SAMURAI','Storm Grey','skin',300,'common',
        'The grey of static silence. He wore this on the night of his final concert — the one where the stage fell into a rift mid-set.',
        '{"primary":"#808080","secondary":"#C0C0C0"}'],
      ['SYNTH_SAMURAI','Blood Moon','skin',800,'rare',
        'The blade resonates differently under red light — lower, more patient. He only wears this when he intends to finish it.',
        '{"primary":"#880000","secondary":"#220000"}'],

      // ── GLITCH WITCH (TIME) ───────────────────────────────────────────────
      ['GLITCH_WITCH','Archive Corrupt','skin',300,'common',
        'A pre-rift color scheme recovered from corrupted archive data. No one knows whose it was. She claimed it anyway.',
        '{"primary":"#4B0082","secondary":"#8B008B"}'],
      ['GLITCH_WITCH','Neon Hex','skin',800,'rare',
        'Compiled from six overlapping rift signatures and a programmer\'s fever dream. The syntax errors are intentional.',
        '{"primary":"#ff44aa","secondary":"#220033"}'],

      // ── BIT CRUSHER (LIGHTNING) ───────────────────────────────────────────
      ['BIT_CRUSHER','Overdrive','skin',300,'common',
        'BC-7\'s emergency mode palette, activated when containment protocols fail. The orange means get clear. Immediately.',
        '{"primary":"#FF8C00","secondary":"#cc3300"}'],
      ['BIT_CRUSHER','Arctic Unit','skin',800,'rare',
        'A cold-weather variant built for rift patrols in the frozen zones. The targeting systems run 40% faster in the cold.',
        '{"primary":"#aaddff","secondary":"#ffffff"}'],

      // ── RETRO RANGER (LIGHT) ──────────────────────────────────────────────
      ['RETRO_RANGER','Solar Scout','skin',300,'common',
        'The colors of the old order. Rangers who came before wore this gold to signal allegiance — before the rift scattered them all.',
        '{"primary":"#FFD700","secondary":"#FFFACD"}'],
      ['RETRO_RANGER','Midnight Ranger','skin',800,'rare',
        'The last known Ranger went dark at 0200 hours and never checked back in. This is what the recovery team found at the site.',
        '{"primary":"#111133","secondary":"#aaaacc"}'],

      // ── VENOM VOODOO (NATURE) ─────────────────────────────────────────────
      ['VENOM_VOODOO','Acid Rain','skin',300,'common',
        'The green-black rot that spreads through the Thornwood when the rift bleeds into its roots. He wears it as a warning.',
        '{"primary":"#556B2F","secondary":"#8B4513"}'],
      ['VENOM_VOODOO','Crimson Curse','skin',800,'rare',
        'The Thornwood\'s final guardian mixed blood-red pigment with his war paint the day the last elder tree fell.',
        '{"primary":"#cc2200","secondary":"#ffaa00"}'],

      // ── FROST VALKYRIE (ICE) ──────────────────────────────────────────────
      ['FROST_VALKYRIE','Blizzard','skin',300,'common',
        'The exact shade she wore when she sealed her first rift tear with nothing but a spear and sheer contempt for the void.',
        '{"primary":"#ADD8E6","secondary":"#FFFFFF"}'],
      ['FROST_VALKYRIE','Frost Queen','skin',800,'rare',
        'Forged from glacial energy siphoned from the deepest trench of the Frost Realm. Reserved for royalty. She took it anyway.',
        '{"primary":"#00FFFF","secondary":"#E0FFFF"}'],

      // ── INFERNO BRAWLER (FIRE) ────────────────────────────────────────────
      ['INFERNO_BRAWLER','Ember Ash','skin',300,'common',
        'The grey-red of cooling magma. He trained in the volcanic belt for six years after his disappearance. Nobody followed him there.',
        '{"primary":"#8B0000","secondary":"#FF4500"}'],
      ['INFERNO_BRAWLER','Ice Brawler','skin',800,'rare',
        'A cold-burn recolor from the night he fought a Frost Valkyrie to a standstill. The arena froze from the inside out.',
        '{"primary":"#4499ff","secondary":"#aaddff"}'],

      // ── SHADOW BEAST (VOID) ───────────────────────────────────────────────
      ['SHADOW_BEAST','Void Surge','skin',300,'common',
        'The rift needed a face when it reached critical mass. This is the color it chose — pure, patient, absolute.',
        '{"primary":"#2F0A4B","secondary":"#6A0DAD"}'],
      ['SHADOW_BEAST','Blood Rift','skin',800,'rare',
        'When the void bleeds, this is what spills out. No one who has seen this form has lived to describe it accurately.',
        '{"primary":"#880011","secondary":"#440000"}'],

      // ── ALL CHARACTERS ────────────────────────────────────────────────────
      ['ALL','Rift Shard Trail','trail',500,'uncommon',
        'Crystallized remnants of collapsed rifts. Each shard hums with residual dimensional energy — beautiful, and dangerous to touch.',
        '{}'],
      ['ALL','Null Explosion','hiteffect',600,'uncommon',
        'A technique borrowed from the Void itself. Strike hard enough and the fabric between realities briefly gives way.',
        '{}'],
      ['ALL','Developer Aura','aura',0,'special',
        'Forged in the foundry of AMGProdZ. Wearing this means you helped build the world you\'re fighting to protect.',
        '{}'],
    ];
    for (const c of cosmetics) {
      await db.execute({
        sql: `INSERT INTO cosmetics (character_id,name,type,price,rarity,description,color_data,is_special) VALUES(?,?,?,?,?,?,?,?)`,
        args: [...c, c[4] === 'special' ? 1 : 0],
      });
    }
    console.log('[DB] Cosmetics seeded with correct character IDs');
  }

  // Seed initial season
  const seasonCount = await db.execute({ sql: 'SELECT COUNT(*) as c FROM seasons', args: [] });
  if (seasonCount.rows[0].c === 0) {
    await db.execute({
      sql: `INSERT INTO seasons (name, status) VALUES (?, ?)`,
      args: ['Season 1: The Awakening', 'active'],
    });
  }
}

// ─── USER QUERIES ─────────────────────────────────────────────────────────────
export async function createUser(username, passwordHash, email) {
  const r = await db.execute({
    sql: `INSERT INTO users (username, password_hash, email, email_verified) VALUES (?,?,?,1) RETURNING id`,
    args: [username, passwordHash, email],
  });
  const id = r.rows[0].id;
  await db.execute({ sql: 'INSERT INTO rankings (user_id) VALUES (?)', args: [id] });
  return id;
}

export async function getUserByUsername(username) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
  return r.rows[0] || null;
}

export async function getUserById(id) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
  return r.rows[0] || null;
}

export async function updateLastLogin(id) {
  await db.execute({ sql: `UPDATE users SET last_login=datetime('now') WHERE id=?`, args: [id] });
}

export async function updateCurrency(userId, amount) {
  await db.execute({ sql: 'UPDATE users SET currency = currency + ? WHERE id = ?', args: [amount, userId] });
}

export async function setCurrency(userId, amount) {
  await db.execute({ sql: 'UPDATE users SET currency = ? WHERE id = ?', args: [amount, userId] });
}

export async function banUser(userId, reason, expires) {
  await db.execute({
    sql: 'UPDATE users SET is_banned=1, ban_reason=?, ban_expires=? WHERE id=?',
    args: [reason, expires || null, userId],
  });
}

export async function unbanUser(userId) {
  await db.execute({ sql: 'UPDATE users SET is_banned=0, ban_reason=NULL, ban_expires=NULL WHERE id=?', args: [userId] });
}

export async function setUserRole(userId, role) {
  await db.execute({ sql: 'UPDATE users SET role=? WHERE id=?', args: [role, userId] });
}

export async function setCustomTitle(userId, title) {
  await db.execute({ sql: 'UPDATE users SET custom_title=? WHERE id=?', args: [title, userId] });
}

export async function getAllUsers(limit = 100, offset = 0) {
  const r = await db.execute({ sql: 'SELECT id,username,role,currency,is_banned,created_at,last_login,total_wins,total_losses FROM users LIMIT ? OFFSET ?', args: [limit, offset] });
  return r.rows;
}

export async function searchUsers(query) {
  const r = await db.execute({ sql: "SELECT id,username,role,currency,is_banned FROM users WHERE username LIKE ? LIMIT 20", args: [`%${query}%`] });
  return r.rows;
}

export async function deleteUser(userId) {
  await db.execute({ sql: 'DELETE FROM users WHERE id=?', args: [userId] });
}

export async function updateWinLoss(winnerId, loserId) {
  await db.execute({ sql: 'UPDATE users SET total_wins=total_wins+1,total_matches=total_matches+1 WHERE id=?', args: [winnerId] });
  await db.execute({ sql: 'UPDATE users SET total_losses=total_losses+1,total_matches=total_matches+1 WHERE id=?', args: [loserId] });
}

// ─── FRIEND QUERIES ───────────────────────────────────────────────────────────
export async function sendFriendRequest(userId, friendId) {
  await db.execute({ sql: 'INSERT OR IGNORE INTO friends (user_id,friend_id) VALUES (?,?)', args: [userId, friendId] });
}

export async function acceptFriend(userId, friendId) {
  await db.execute({ sql: "UPDATE friends SET status='accepted' WHERE user_id=? AND friend_id=?", args: [friendId, userId] });
  await db.execute({ sql: "INSERT OR IGNORE INTO friends (user_id,friend_id,status) VALUES (?,?,'accepted')", args: [userId, friendId] });
}

export async function removeFriend(userId, friendId) {
  await db.execute({ sql: 'DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)', args: [userId, friendId, friendId, userId] });
}

export async function getFriends(userId) {
  const r = await db.execute({
    sql: `SELECT u.id,u.username,u.custom_title,f.status FROM friends f
          JOIN users u ON u.id = f.friend_id
          WHERE f.user_id=? AND f.status='accepted'`,
    args: [userId],
  });
  return r.rows;
}

export async function getPendingRequests(userId) {
  const r = await db.execute({
    sql: `SELECT u.id,u.username FROM friends f JOIN users u ON u.id=f.user_id WHERE f.friend_id=? AND f.status='pending'`,
    args: [userId],
  });
  return r.rows;
}

// ─── PARTY QUERIES ────────────────────────────────────────────────────────────
export async function createParty(hostId, code, gameMode) {
  const r = await db.execute({
    sql: `INSERT INTO parties (host_id,code,game_mode) VALUES (?,?,?) RETURNING id`,
    args: [hostId, code, gameMode],
  });
  const partyId = r.rows[0].id;
  await db.execute({ sql: 'INSERT INTO party_members (party_id,user_id,ready) VALUES (?,?,1)', args: [partyId, hostId] });
  return partyId;
}

export async function getPartyByCode(code) {
  const r = await db.execute({ sql: 'SELECT * FROM parties WHERE code=?', args: [code] });
  return r.rows[0] || null;
}

export async function getPartyMembers(partyId) {
  const r = await db.execute({
    sql: `SELECT u.id,u.username,u.custom_title,pm.character_id,pm.ready FROM party_members pm
          JOIN users u ON u.id=pm.user_id WHERE pm.party_id=?`,
    args: [partyId],
  });
  return r.rows;
}

export async function joinParty(partyId, userId) {
  await db.execute({ sql: 'INSERT OR IGNORE INTO party_members (party_id,user_id) VALUES (?,?)', args: [partyId, userId] });
}

export async function leaveParty(partyId, userId) {
  await db.execute({ sql: 'DELETE FROM party_members WHERE party_id=? AND user_id=?', args: [partyId, userId] });
}

export async function setPartyReady(partyId, userId, character) {
  await db.execute({ sql: 'UPDATE party_members SET ready=1,character_id=? WHERE party_id=? AND user_id=?', args: [character, partyId, userId] });
}

export async function dissolveParty(partyId) {
  await db.execute({ sql: 'DELETE FROM parties WHERE id=?', args: [partyId] });
}

// ─── COSMETIC QUERIES ─────────────────────────────────────────────────────────
export async function getCosmetics(characterId) {
  const r = await db.execute({
    sql: characterId === 'ALL'
      ? 'SELECT * FROM cosmetics'
      : "SELECT * FROM cosmetics WHERE character_id=? OR character_id='ALL'",
    args: characterId === 'ALL' ? [] : [characterId],
  });
  return r.rows;
}

export async function getUserCosmetics(userId) {
  const r = await db.execute({
    sql: `SELECT c.*,uc.equipped,uc.purchased_at FROM user_cosmetics uc JOIN cosmetics c ON c.id=uc.cosmetic_id WHERE uc.user_id=?`,
    args: [userId],
  });
  return r.rows;
}

export async function purchaseCosmetic(userId, cosmeticId) {
  const cos = await db.execute({ sql: 'SELECT * FROM cosmetics WHERE id=?', args: [cosmeticId] });
  if (!cos.rows[0]) throw new Error('Cosmetic not found');
  const user = await getUserById(userId);
  if (user.currency < cos.rows[0].price) throw new Error('Insufficient Rift Shards');
  await db.execute({ sql: 'INSERT OR IGNORE INTO user_cosmetics (user_id,cosmetic_id) VALUES (?,?)', args: [userId, cosmeticId] });
  await updateCurrency(userId, -cos.rows[0].price);
  await db.execute({ sql: 'INSERT INTO transactions (user_id,amount,type,description) VALUES (?,?,?,?)', args: [userId, -cos.rows[0].price, 'purchase', `Bought: ${cos.rows[0].name}`] });
  return true;
}

export async function equipCosmetic(userId, cosmeticId) {
  const cos = await db.execute({ sql: 'SELECT type,character_id FROM cosmetics WHERE id=?', args: [cosmeticId] });
  if (!cos.rows[0]) throw new Error('Cosmetic not found');
  const { type, character_id } = cos.rows[0];
  await db.execute({
    sql: `UPDATE user_cosmetics SET equipped=0 WHERE user_id=? AND cosmetic_id IN
          (SELECT id FROM cosmetics WHERE type=? AND (character_id=? OR character_id='ALL'))`,
    args: [userId, type, character_id],
  });
  await db.execute({ sql: 'UPDATE user_cosmetics SET equipped=1 WHERE user_id=? AND cosmetic_id=?', args: [userId, cosmeticId] });
}

export async function grantCosmetic(userId, cosmeticId) {
  await db.execute({ sql: 'INSERT OR IGNORE INTO user_cosmetics (user_id,cosmetic_id) VALUES (?,?)', args: [userId, cosmeticId] });
}

export async function createCosmetic(characterId, name, type, price, rarity, description, colorData) {
  const r = await db.execute({
    sql: `INSERT INTO cosmetics (character_id,name,type,price,rarity,description,color_data) VALUES (?,?,?,?,?,?,?) RETURNING id`,
    args: [characterId, name, type, price, rarity, description, JSON.stringify(colorData)],
  });
  return r.rows[0].id;
}

// ─── MATCH QUERIES ────────────────────────────────────────────────────────────
export async function createMatch(p1, p2, char1, char2, stage, mode, ranked) {
  const r = await db.execute({
    sql: `INSERT INTO matches (player1_id,player2_id,character1,character2,stage,game_mode,is_ranked) VALUES (?,?,?,?,?,?,?) RETURNING id`,
    args: [p1, p2, char1, char2 || null, stage, mode, ranked ? 1 : 0],
  });
  return r.rows[0].id;
}

export async function finishMatch(matchId, winnerId, duration, replayData) {
  await db.execute({
    sql: 'UPDATE matches SET winner_id=?,duration=?,replay_data=? WHERE id=?',
    args: [winnerId, duration, replayData ? JSON.stringify(replayData) : null, matchId],
  });
}

export async function getMatchHistory(userId, limit = 20) {
  const r = await db.execute({
    sql: `SELECT m.*,u1.username as p1_name,u2.username as p2_name,w.username as winner_name
          FROM matches m
          LEFT JOIN users u1 ON u1.id=m.player1_id
          LEFT JOIN users u2 ON u2.id=m.player2_id
          LEFT JOIN users w ON w.id=m.winner_id
          WHERE m.player1_id=? OR m.player2_id=?
          ORDER BY m.created_at DESC LIMIT ?`,
    args: [userId, userId, limit],
  });
  return r.rows;
}

export async function voidMatch(matchId) {
  await db.execute({ sql: 'UPDATE matches SET is_voided=1 WHERE id=?', args: [matchId] });
}

// ─── RANKING QUERIES ──────────────────────────────────────────────────────────
export async function updateElo(userId, delta) {
  await db.execute({
    sql: `UPDATE rankings SET elo=MAX(0,elo+?), season_elo=MAX(0,season_elo+?),
          peak_elo=MAX(peak_elo,elo+?) WHERE user_id=?`,
    args: [delta, delta, delta, userId],
  });
  if (delta > 0) await db.execute({ sql: 'UPDATE rankings SET wins=wins+1 WHERE user_id=?', args: [userId] });
  else await db.execute({ sql: 'UPDATE rankings SET losses=losses+1 WHERE user_id=?', args: [userId] });
}

export async function getLeaderboard(limit = 50) {
  const r = await db.execute({
    sql: `SELECT u.username,u.custom_title,r.elo,r.wins,r.losses,r.peak_elo
          FROM rankings r JOIN users u ON u.id=r.user_id
          WHERE u.is_banned=0 ORDER BY r.elo DESC LIMIT ?`,
    args: [limit],
  });
  return r.rows;
}

export async function getRanking(userId) {
  const r = await db.execute({ sql: 'SELECT * FROM rankings WHERE user_id=?', args: [userId] });
  return r.rows[0] || null;
}

// ─── STORY QUERIES ────────────────────────────────────────────────────────────
export async function getStoryProgress(userId) {
  const r = await db.execute({ sql: 'SELECT * FROM story_progress WHERE user_id=?', args: [userId] });
  return r.rows;
}

export async function saveStoryProgress(userId, characterId, chapter, completed) {
  await db.execute({
    sql: `INSERT INTO story_progress (user_id,character_id,chapter,completed,completed_at)
          VALUES (?,?,?,?,CASE WHEN ? THEN datetime('now') ELSE NULL END)
          ON CONFLICT(user_id,character_id) DO UPDATE SET
          chapter=excluded.chapter, completed=excluded.completed,
          completed_at=CASE WHEN excluded.completed=1 THEN excluded.completed_at ELSE completed_at END`,
    args: [userId, characterId, chapter, completed ? 1 : 0, completed ? 1 : 0],
  });
}

// ─── ADMIN QUERIES ────────────────────────────────────────────────────────────
export async function logAdminAction(adminId, command, targetId, data) {
  await db.execute({
    sql: 'INSERT INTO admin_logs (admin_id,command,target_id,data) VALUES (?,?,?,?)',
    args: [adminId, command, targetId || null, data ? JSON.stringify(data) : null],
  });
}

export async function getAdminLogs(limit = 100) {
  const r = await db.execute({
    sql: `SELECT al.*,u.username as admin_name,t.username as target_name FROM admin_logs al
          LEFT JOIN users u ON u.id=al.admin_id LEFT JOIN users t ON t.id=al.target_id
          ORDER BY al.created_at DESC LIMIT ?`,
    args: [limit],
  });
  return r.rows;
}

export async function getServerStats() {
  const [users, matches, cosmetics, transactions, reports, tournaments] = await Promise.all([
    db.execute({ sql: 'SELECT COUNT(*) as total, SUM(is_banned) as banned FROM users', args: [] }),
    db.execute({ sql: 'SELECT COUNT(*) as total, SUM(is_ranked) as ranked FROM matches', args: [] }),
    db.execute({ sql: 'SELECT COUNT(*) as total FROM cosmetics', args: [] }),
    db.execute({ sql: 'SELECT COUNT(*) as total, SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as spent FROM transactions', args: [] }),
    db.execute({ sql: "SELECT COUNT(*) as total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending FROM reports", args: [] }),
    db.execute({ sql: 'SELECT COUNT(*) as total FROM tournaments', args: [] }),
  ]);
  return {
    users: users.rows[0],
    matches: matches.rows[0],
    cosmetics: cosmetics.rows[0],
    transactions: transactions.rows[0],
    reports: reports.rows[0],
    tournaments: tournaments.rows[0],
  };
}

export async function getEconomyStats() {
  const r = await db.execute({
    sql: `SELECT type, COUNT(*) as count, SUM(ABS(amount)) as total FROM transactions GROUP BY type`,
    args: [],
  });
  return r.rows;
}

// ─── REPORTS ──────────────────────────────────────────────────────────────────
export async function createReport(reporterId, reportedId, reason, description) {
  await db.execute({
    sql: 'INSERT INTO reports (reporter_id,reported_id,reason,description) VALUES (?,?,?,?)',
    args: [reporterId, reportedId, reason, description || null],
  });
}

export async function getReports(status) {
  const r = await db.execute({
    sql: `SELECT r.*,u1.username as reporter,u2.username as reported FROM reports r
          JOIN users u1 ON u1.id=r.reporter_id JOIN users u2 ON u2.id=r.reported_id
          WHERE (? IS NULL OR r.status=?) ORDER BY r.created_at DESC LIMIT 100`,
    args: [status || null, status || null],
  });
  return r.rows;
}

export async function resolveReport(reportId, adminId) {
  await db.execute({ sql: "UPDATE reports SET status='resolved',resolved_by=? WHERE id=?", args: [adminId, reportId] });
}

// ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
export async function createAnnouncement(title, content, creatorId, pin) {
  await db.execute({ sql: 'INSERT INTO announcements (title,content,creator_id,is_pinned) VALUES (?,?,?,?)', args: [title, content, creatorId, pin ? 1 : 0] });
}

export async function getAnnouncements() {
  const r = await db.execute({ sql: 'SELECT * FROM announcements ORDER BY is_pinned DESC, created_at DESC LIMIT 20', args: [] });
  return r.rows;
}

export async function deleteAnnouncement(id) {
  await db.execute({ sql: 'DELETE FROM announcements WHERE id=?', args: [id] });
}

// ─── TOURNAMENTS ──────────────────────────────────────────────────────────────
export async function createTournament(name, creatorId, maxPlayers, prize, rules, startsAt) {
  const r = await db.execute({
    sql: `INSERT INTO tournaments (name,creator_id,max_players,prize_currency,rules,starts_at) VALUES (?,?,?,?,?,?) RETURNING id`,
    args: [name, creatorId, maxPlayers, prize, JSON.stringify(rules), startsAt || null],
  });
  return r.rows[0].id;
}

export async function getTournaments() {
  const r = await db.execute({ sql: "SELECT * FROM tournaments WHERE status != 'ended' ORDER BY created_at DESC", args: [] });
  return r.rows;
}

export async function joinTournament(tournamentId, userId) {
  await db.execute({ sql: 'INSERT OR IGNORE INTO tournament_participants (tournament_id,user_id) VALUES (?,?)', args: [tournamentId, userId] });
}

// ─── BALANCE ──────────────────────────────────────────────────────────────────
export async function setBalanceOverride(characterId, statKey, value, adminId) {
  await db.execute({
    sql: `INSERT INTO balance_overrides (character_id,stat_key,value,set_by) VALUES (?,?,?,?)
          ON CONFLICT(character_id,stat_key) DO UPDATE SET value=excluded.value, set_by=excluded.set_by, created_at=datetime('now')`,
    args: [characterId, statKey, value, adminId],
  });
}

export async function getBalanceOverrides() {
  const r = await db.execute({ sql: 'SELECT * FROM balance_overrides', args: [] });
  return r.rows;
}

export async function revertBalance(characterId) {
  await db.execute({ sql: 'DELETE FROM balance_overrides WHERE character_id=?', args: [characterId] });
}

// ─── MOTD ─────────────────────────────────────────────────────────────────────
export async function setMotd(message, adminId) {
  await db.execute({ sql: 'DELETE FROM motd', args: [] });
  await db.execute({ sql: 'INSERT INTO motd (message,set_by) VALUES (?,?)', args: [message, adminId] });
}

export async function getMotd() {
  const r = await db.execute({ sql: 'SELECT * FROM motd ORDER BY created_at DESC LIMIT 1', args: [] });
  return r.rows[0] || null;
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
export async function logChat(userId, room, message) {
  await db.execute({ sql: 'INSERT INTO chat_logs (user_id,room,message) VALUES (?,?,?)', args: [userId, room, message] });
}

export async function deleteChatMessage(id) {
  await db.execute({ sql: 'UPDATE chat_logs SET is_deleted=1 WHERE id=?', args: [id] });
}

export async function clearRoomChat(room) {
  await db.execute({ sql: 'UPDATE chat_logs SET is_deleted=1 WHERE room=?', args: [room] });
}

export async function getChatLogs(room, limit = 100) {
  const r = await db.execute({
    sql: `SELECT cl.*,u.username FROM chat_logs cl JOIN users u ON u.id=cl.user_id
          WHERE cl.room=? ORDER BY cl.created_at DESC LIMIT ?`,
    args: [room, limit],
  });
  return r.rows;
}

// ─── SEASONS ──────────────────────────────────────────────────────────────────
export async function endSeason(seasonId, rewards) {
  await db.execute({ sql: "UPDATE seasons SET status='ended',ended_at=datetime('now'),rewards=? WHERE id=?", args: [JSON.stringify(rewards), seasonId] });
  await db.execute({ sql: 'UPDATE rankings SET season_elo=1000', args: [] });
}

export async function getActiveSeason() {
  const r = await db.execute({ sql: "SELECT * FROM seasons WHERE status='active' ORDER BY id DESC LIMIT 1", args: [] });
  return r.rows[0] || null;
}

// ─── TRANSACTIONS ─────────────────────────────────────────────────────────────
export async function logTransaction(userId, amount, type, description, adminId) {
  await db.execute({
    sql: 'INSERT INTO transactions (user_id,amount,type,description,admin_id) VALUES (?,?,?,?,?)',
    args: [userId, amount, type, description || null, adminId || null],
  });
}

export async function getPurchaseHistory(userId, limit = 50) {
  const r = await db.execute({
    sql: 'SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ?',
    args: [userId, limit],
  });
  return r.rows;
}

// ─── EMAIL VERIFICATION ────────────────────────────────────────────────────────
export async function setVerifyToken(userId, token, expiresMs) {
  await db.execute({
    sql: 'UPDATE users SET email_verify_token=?, email_verify_expires=? WHERE id=?',
    args: [token, expiresMs, userId],
  });
}

export async function getUserByVerifyToken(token) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE email_verify_token=?', args: [token] });
  return r.rows[0] || null;
}

export async function setEmailVerified(userId) {
  await db.execute({
    sql: 'UPDATE users SET email_verified=1, email_verify_token=NULL, email_verify_expires=NULL WHERE id=?',
    args: [userId],
  });
}

// ─── TWO-FACTOR AUTH ──────────────────────────────────────────────────────────
export async function set2FACode(userId, code, expiresMs) {
  await db.execute({
    sql: 'UPDATE users SET two_fa_code=?, two_fa_code_expires=? WHERE id=?',
    args: [code, expiresMs, userId],
  });
}

export async function clear2FACode(userId) {
  await db.execute({
    sql: 'UPDATE users SET two_fa_code=NULL, two_fa_code_expires=NULL WHERE id=?',
    args: [userId],
  });
}

export async function set2FAEnabled(userId, enabled) {
  await db.execute({
    sql: 'UPDATE users SET two_fa_enabled=?, two_fa_code=NULL, two_fa_code_expires=NULL WHERE id=?',
    args: [enabled ? 1 : 0, userId],
  });
}

// ─── BACKUP CODE ──────────────────────────────────────────────────────────────
export async function setBackupCode(userId, codeHash) {
  await db.execute({ sql: 'UPDATE users SET backup_code=? WHERE id=?', args: [codeHash, userId] });
}
