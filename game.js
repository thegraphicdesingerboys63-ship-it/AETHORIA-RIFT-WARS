// AETHORIA: RIFT WARS — Game Engine
import { CHARACTERS, CHARACTER_LIST, STAGES, ELEMENTS, getElementalReaction } from './characters.js';

const CANVAS_W = 800, CANVAS_H = 600;
const GRAVITY = 0.65, MAX_FALL = 18, FRICTION = 0.82, AIR_FRICTION = 0.92;
const STOCK_COUNT = 3, BLAST_ZONE = 200;
const ULTIMATE_MAX = 100, PARRY_WINDOW = 8;

// ─── STATE ────────────────────────────────────────────────────────────────────
export const GameState = {
  MAIN_MENU: 'MAIN_MENU', CHARACTER_SELECT: 'CHARACTER_SELECT',
  GAME: 'GAME', STORY: 'STORY', RESULTS: 'RESULTS',
  ONLINE_LOBBY: 'ONLINE_LOBBY', TRAINING: 'TRAINING',
  SHOP: 'SHOP', LEADERBOARD: 'LEADERBOARD', ADMIN: 'ADMIN',
  SETTINGS: 'SETTINGS',
};

let canvas, ctx, state = GameState.MAIN_MENU;
let players = [], stage = null, frame = 0, gameMode = 'local';
let socket = null, localPlayerIndex = 0, roomId = null;
let storyState = null, menuState = null, shopState = null;
let tutorialState = null;
let balanceOverrides = {}, equippedCosmetics = {};
let globalFlags = { elementalReactions: true };
let elementalParticles = [], shakeTimer = 0, comboDisplays = [];
let token = null, currentUser = null;

// ─── INPUT ────────────────────────────────────────────────────────────────────
const Keys = {};
const JustPressed = {};
const JustReleased = {};
window.addEventListener('keydown', e => { if (!Keys[e.code]) JustPressed[e.code] = true; Keys[e.code] = true; e.preventDefault && ['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code) && e.preventDefault(); });
window.addEventListener('keyup', e => { JustReleased[e.code] = true; Keys[e.code] = false; });
function clearFrameInput() {
  for (const k in JustPressed)  delete JustPressed[k];
  for (const k in JustReleased) delete JustReleased[k];
  for (const k in TouchFired)   delete TouchFired[k];
  if (players[0]) players[0]._justHit = false;
}

const CONTROLS = [
  { left:'ArrowLeft', right:'ArrowRight', up:'ArrowUp', down:'ArrowDown', jump:'ArrowUp', jab:'KeyL', heavy:'KeyK', special:'KeyJ', shield:'KeyI', grab:'KeyO' },
  { left:'KeyA', right:'KeyD', up:'KeyW', down:'KeyS', jump:'KeyW', jab:'KeyG', heavy:'KeyF', special:'KeyH', shield:'KeyT', grab:'KeyY' },
];

// ─── GAMEPAD SUPPORT ─────────────────────────────────────────────────────────
const GpState = [{}, {}];
const GpPrev  = [{}, {}];
const GP_DEAD = 0.25;

function pollGamepads() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  for (let gi = 0; gi < 2; gi++) {
    const prev = GpPrev[gi]; const cur = GpState[gi];
    prev.left=cur.left; prev.right=cur.right; prev.up=cur.up; prev.down=cur.down;
    prev.jump=cur.jump; prev.jab=cur.jab; prev.heavy=cur.heavy;
    prev.special=cur.special; prev.shield=cur.shield; prev.grab=cur.grab;
    const gp = gps[gi];
    if (!gp || !gp.connected) { GpState[gi] = {}; continue; }
    const ax0 = gp.axes[0] || 0, ax1 = gp.axes[1] || 0;
    GpState[gi] = {
      left:    ax0 < -GP_DEAD || !!(gp.buttons[14]?.pressed),
      right:   ax0 >  GP_DEAD || !!(gp.buttons[15]?.pressed),
      up:      ax1 < -GP_DEAD || !!(gp.buttons[12]?.pressed),
      down:    ax1 >  GP_DEAD || !!(gp.buttons[13]?.pressed),
      jump:    !!(gp.buttons[0]?.pressed),   // A / Cross
      jab:     !!(gp.buttons[1]?.pressed),   // B / Circle
      heavy:   !!(gp.buttons[3]?.pressed),   // Y / Triangle
      special: !!(gp.buttons[2]?.pressed),   // X / Square
      shield:  !!(gp.buttons[4]?.pressed) || !!(gp.buttons[5]?.pressed),
      grab:    !!(gp.buttons[6]?.pressed) || !!(gp.buttons[7]?.pressed),
    };
  }
}
function gpJust(gi, btn) { return !!(GpState[gi]?.[btn]) && !(GpPrev[gi]?.[btn]); }

// ─── TOUCH INPUT ─────────────────────────────────────────────────────────────
const TouchHeld  = {};
const TouchFired = {};
window.touchPress   = (btn) => { TouchHeld[btn] = true;  TouchFired[btn] = true; };
window.touchRelease = (btn) => { delete TouchHeld[btn]; };

function getInput(pi) {
  const c  = CONTROLS[pi] || CONTROLS[0];
  const th = pi === 0 ? TouchHeld  : {};
  const tf = pi === 0 ? TouchFired : {};
  return {
    left:      !!(Keys[c.left]    || GpState[pi]?.left    || th.left),
    right:     !!(Keys[c.right]   || GpState[pi]?.right   || th.right),
    up:        !!(Keys[c.up]      || GpState[pi]?.up      || th.up),
    down:      !!(Keys[c.down]    || GpState[pi]?.down    || th.down),
    jump:      !!(JustPressed[c.jump]    || gpJust(pi,'jump')    || tf.jump),
    jab:       !!(JustPressed[c.jab]     || gpJust(pi,'jab')     || tf.jab),
    heavy:     !!(JustPressed[c.heavy]   || gpJust(pi,'heavy')   || tf.heavy),
    special:   !!(JustPressed[c.special] || gpJust(pi,'special') || tf.special),
    shield:    !!(Keys[c.shield]  || GpState[pi]?.shield  || th.shield),
    grab:      !!(JustPressed[c.grab]    || gpJust(pi,'grab')    || tf.grab),
    down_held: !!(Keys[c.down]    || GpState[pi]?.down    || th.down),
  };
}

// ─── PARTICLE SYSTEM ─────────────────────────────────────────────────────────
const particles = [];
function spawnParticles(x, y, color, count, spread, life, type = 'square') {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = (0.5 + Math.random() * 0.5) * spread;
    const sz = type === 'spark' ? (Math.random() < 0.5 ? 2 : 4) : (Math.random() < 0.6 ? 3 : 5);
    particles.push({ x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s - 1.5, life, maxLife: life, color, sz, type });
  }
}
function spawnImpactStarburst(x, y, color) {
  // 8-direction cross sparks for hit impact
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const s = 3 + Math.random() * 4;
    particles.push({ x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s, life: 18, maxLife: 18, color, sz: 4, type: 'spark' });
  }
  // Center flash pixel
  particles.push({ x: x-4, y: y-4, vx: 0, vy: 0, life: 8, maxLife: 8, color: '#FFFFFF', sz: 8, type: 'square' });
}
function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.18;
    p.vx *= 0.94; p.life--;
    if (p.life <= 0) particles.splice(i, 1);
  }
}
function drawParticles() {
  for (const p of particles) {
    const a = p.life / p.maxLife;
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    const sz = Math.ceil(p.sz * a);
    // Pixel squares — snap to grid
    ctx.fillRect(Math.round(p.x), Math.round(p.y), sz, sz);
  }
  ctx.globalAlpha = 1;
}

// ─── ELEMENTAL REACTION HANDLER ───────────────────────────────────────────────
function triggerReaction(el1, el2, x, y) {
  if (!globalFlags.elementalReactions) return;
  const r = getElementalReaction(el1, el2);
  if (!r) return;
  elementalParticles.push({ x, y, reaction: r, life: 60, maxLife: 60 });
  spawnParticles(x, y, r.color, 20, 5, 40);
  if (shakeTimer < 10) shakeTimer = 10;
  return r;
}

// ─── PLATFORM ────────────────────────────────────────────────────────────────
class Platform {
  constructor(x, y, w, h, passThrough = true) {
    this.x = x; this.y = y; this.w = w; this.h = h; this.passThrough = passThrough;
  }
  draw(element) {
    const el = element || 'EARTH';
    const TILE = {
      FIRE:      { base:'#3a1800', top:'#ff6600', accent:'#cc3300', glow:'#ff4500' },
      ICE:       { base:'#0a1828', top:'#a8d8f0', accent:'#4488bb', glow:'#88ccff' },
      EARTH:     { base:'#2a1e0a', top:'#6b5230', accent:'#8b6914', glow:'#a07840' },
      WIND:      { base:'#1a2030', top:'#99aabb', accent:'#7788aa', glow:'#ccddee' },
      LIGHT:     { base:'#1e1a00', top:'#eecc44', accent:'#cc9900', glow:'#ffd700' },
      SHADOW:    { base:'#080010', top:'#3a0060', accent:'#220040', glow:'#6600cc' },
      LIGHTNING: { base:'#181800', top:'#cccc00', accent:'#888800', glow:'#ffff00' },
      WATER:     { base:'#001428', top:'#2266bb', accent:'#114488', glow:'#1e90ff' },
      NATURE:    { base:'#0a1e0a', top:'#2d6e1e', accent:'#1a4a0a', glow:'#228b22' },
      TIME:      { base:'#100018', top:'#7040bb', accent:'#440088', glow:'#9370db' },
      VOID:      { base:'#020005', top:'#180030', accent:'#0a0018', glow:'#4b0082' },
      MAGMA:     { base:'#200800', top:'#883300', accent:'#552200', glow:'#cc4400' },
      AETHER:    { base:'#080812', top:'#aaaacc', accent:'#8888aa', glow:'#ffffff' },
    };
    const t = TILE[el] || TILE.EARTH;
    const TILE_W = 16, TILE_H = this.h;

    // Base fill
    ctx.fillStyle = t.base;
    ctx.fillRect(this.x, this.y, this.w, this.h);

    // Top edge (2px bright cap)
    ctx.fillStyle = t.top;
    ctx.fillRect(this.x, this.y, this.w, 3);

    // Pixel tiles pattern
    ctx.fillStyle = t.accent;
    for (let px = this.x; px < this.x + this.w; px += TILE_W) {
      ctx.fillRect(px, this.y + 3, 1, this.h - 3);          // tile separator
      ctx.fillRect(px + 4, this.y + 5, 6, 2);                // inner pixel detail
      ctx.fillRect(px + 2, this.y + 9, 4, 1);
    }

    // Bottom shadow strip
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(this.x, this.y + this.h - 2, this.w, 2);

    // Glow line under top cap
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = t.glow;
    ctx.fillRect(this.x, this.y + 3, this.w, 2);
    ctx.globalAlpha = 1;
  }
}

// ─── CHARACTER ────────────────────────────────────────────────────────────────
class Fighter {
  constructor(charData, x, y, playerIndex, isAI = false) {
    this.data = charData;
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.facing = playerIndex === 0 ? 1 : -1;
    this.w = 40; this.h = 56;
    this.damage = 0;
    this.stocks = STOCK_COUNT;
    this.onGround = false;
    this.jumpsLeft = 2;
    this.state = 'IDLE';
    this.stateTimer = 0;
    this.attackBox = null;
    this.hurtTimer = 0;
    this.shieldHP = 100;
    this.parryTimer = 0;
    this.ultimateMeter = 0;
    this.frozen = 0;
    this.stunned = 0;
    this.slowed = 0;
    this.rooted = 0;
    this.blinded = 0;
    this.invincible = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.playerIndex = playerIndex;
    this.isAI = isAI;
    this.animFrame = 0;
    this.animTimer = 0;
    this.chargeTimer = 0;
    this.isCharging = false;
    this.currentMove = null;
    this.timeLoopPos = null;
    this.overcharged = false;
    this.hitThisFrame = [];
    this.wet = false;
    this.wetTimer = 0;
    this.shieldActive = false;
    this.grabTarget = null;
    this.spawnProtect = 120;
  }

  get stats() {
    const base = {
      speed: this.data.speed,
      weight: this.data.weight,
      jumpStrength: this.data.jumpStrength,
      airSpeed: this.data.airSpeed,
      fallSpeed: this.data.fallSpeed,
    };
    // Apply balance overrides
    const ov = balanceOverrides[this.data.id] || {};
    for (const k in ov) if (base[k] !== undefined) base[k] = ov[k];
    return base;
  }

  get centerX() { return this.x + this.w / 2; }
  get centerY() { return this.y + this.h / 2; }
  get feet() { return this.y + this.h; }

  takeDamage(dmg, kbBase, kbScale, kbAngle, attackerX, attackerElement) {
    if (this.invincible > 0 || this.spawnProtect > 0) return false;
    if (this.shieldActive && this.shieldHP > 0) {
      this.shieldHP -= dmg * 1.5;
      if (this.shieldHP <= 0) this.shieldBreak();
      spawnParticles(this.centerX, this.centerY, '#8888FF', 8, 3, 20);
      return false;
    }
    if (this.parryTimer > 0 && this.hurtTimer === 0) {
      // Perfect parry — counter
      this.parryTimer = 0;
      this.invincible = 30;
      const counterDmg = dmg * 1.5;
      spawnParticles(this.centerX, this.centerY, '#FFFFFF', 15, 6, 30);
      return 'parry';
    }
    const mult = this.overcharged ? 2 : 1;
    this.damage += dmg * mult;
    this.hurtTimer = 20;
    const kb = (kbBase + this.damage * kbScale * 0.05) * (100 / this.stats.weight);
    const dir = attackerX < this.centerX ? 1 : -1;
    const rad = kbAngle * Math.PI / 180;
    this.vx = Math.cos(rad) * kb * dir;
    this.vy = -Math.abs(Math.sin(rad)) * kb;
    this.state = 'HURT';
    this.stateTimer = 20;
    this.overcharged = false;
    spawnParticles(this.centerX, this.centerY, ELEMENTS[attackerElement]?.color || '#FF4400', 12, 4, 25);
    // Update combo
    this.combo = 0;
    // Update ultimate meter
    this.ultimateMeter = Math.min(ULTIMATE_MAX, this.ultimateMeter + dmg * 0.5);
    return true;
  }

  shieldBreak() {
    this.shieldHP = 0; this.shieldActive = false;
    this.state = 'HURT'; this.stateTimer = 120;
    this.vx = 0; this.vy = -8;
    spawnParticles(this.centerX, this.centerY, '#8888FF', 25, 6, 40);
  }

  update(input, platforms, opponent) {
    if (this.spawnProtect > 0) this.spawnProtect--;
    if (this.frozen > 0) { this.frozen--; return; }
    if (this.stunned > 0) { this.stunned--; this.vx *= 0.9; return; }

    this.stateTimer = Math.max(0, this.stateTimer - 1);
    this.hurtTimer = Math.max(0, this.hurtTimer - 1);
    this.parryTimer = Math.max(0, this.parryTimer - 1);
    this.invincible = Math.max(0, this.invincible - 1);
    if (this.slowed > 0) this.slowed--;
    if (this.rooted > 0) this.rooted--;
    if (this.blinded > 0) this.blinded--;
    if (this.wetTimer > 0) { this.wetTimer--; if (this.wetTimer === 0) this.wet = false; }
    if (this.comboTimer > 0) { this.comboTimer--; if (this.comboTimer === 0) this.combo = 0; }
    if (this.shieldActive && !input.shield) this.shieldActive = false;
    if (this.shieldActive) { this.shieldHP = Math.min(100, this.shieldHP + 0.3); }
    else { this.shieldHP = Math.min(100, this.shieldHP + 0.1); }
    this.hitThisFrame = [];

    const speedMult = this.slowed > 0 ? 0.4 : 1;
    const s = this.stats;

    if (this.isAI) { this.updateAI(opponent, platforms); return; }
    if (this.stateTimer > 0 && ['ATTACK','HURT','SPECIAL','DEAD'].includes(this.state)) {
      this.applyPhysics(platforms, speedMult);
      return;
    }

    // Shield / Parry
    if (input.shield && this.onGround) {
      this.shieldActive = true;
      this.parryTimer = PARRY_WINDOW;
      this.state = 'SHIELD';
    }

    // Movement
    if (!this.rooted && this.state !== 'SHIELD') {
      if (input.left)  { this.vx -= (this.onGround ? s.speed*0.4 : s.airSpeed*0.25) * speedMult; this.facing = -1; }
      if (input.right) { this.vx += (this.onGround ? s.speed*0.4 : s.airSpeed*0.25) * speedMult; this.facing = 1; }
    }

    // Jump
    if (input.jump && this.jumpsLeft > 0) {
      this.vy = -s.jumpStrength;
      this.jumpsLeft--;
      this.onGround = false;
      if (this.jumpsLeft === 0) spawnParticles(this.centerX, this.feet, ELEMENTS[this.data.element]?.color || '#FFFFFF', 8, 3, 20);
    }

    // Drop through platform
    if (input.down_held && input.jump && this.onGround) {
      this.y += 5; this.onGround = false;
    }

    // Attacks
    if (this.state !== 'SHIELD') {
      let moveId = null;
      if (input.jab) moveId = 'jab';
      else if (input.heavy) {
        if (input.up) moveId = this.onGround ? 'usmash' : 'uair';
        else if (input.down_held) moveId = this.onGround ? 'dsmash' : 'dair';
        else moveId = this.onGround ? 'fsmash' : 'fair';
      }
      else if (input.special) {
        if (input.up) moveId = 'upB';
        else if (input.down_held) moveId = 'downB';
        else if (input.left || input.right) moveId = 'sideB';
        else moveId = 'neutralB';
      }
      // Tilts
      if (!input.heavy && !input.special && !input.jab && this.onGround) {
        if (Keys[CONTROLS[this.playerIndex]?.up] && !input.jump) moveId = 'utilt';
        else if (input.down_held && !input.jump) moveId = 'dtilt';
        else if ((input.left || input.right) && !input.jump && JustPressed[CONTROLS[this.playerIndex]?.jab]) moveId = 'ftilt';
      }
      if (!this.onGround && !input.heavy && !input.special && JustPressed[CONTROLS[this.playerIndex]?.jab]) moveId = 'nair';
      if (!this.onGround && JustPressed[CONTROLS[this.playerIndex]?.heavy]) {
        if (input.left || input.right) moveId = 'fair';
        else if (input.down_held) moveId = 'dair';
        else moveId = 'bair';
      }

      // Ultimate
      if (input.special && input.heavy && this.ultimateMeter >= ULTIMATE_MAX) {
        moveId = 'ultimate';
      }

      if (moveId && this.data.moves[moveId]) this.startAttack(moveId);
    }

    this.applyPhysics(platforms, speedMult);
    this.updateAnim();
  }

  startAttack(moveId) {
    const move = this.data.moves[moveId];
    if (!move) return;
    this.currentMove = moveId;
    this.state = moveId === 'ultimate' ? 'ULTIMATE' : 'ATTACK';
    this.stateTimer = move.startup + move.active + move.recovery;
    this.attackBox = null;

    if (moveId === 'ultimate' && this.ultimateMeter >= ULTIMATE_MAX) {
      this.ultimateMeter = 0;
      spawnParticles(this.centerX, this.centerY, ELEMENTS[this.data.element]?.color || '#FFFFFF', 40, 8, 60);
      shakeTimer = 25;
    }
    // GLITCH_WITCH: downB stores position for time-skip reversal, upB restores it
    if (moveId === 'downB' && this.data.id === 'GLITCH_WITCH') {
      this.timeLoopPos = { x: this.x, y: this.y, vx: this.vx, vy: this.vy, damage: this.damage };
    }
    if (moveId === 'sideB' && this.data.id === 'GLITCH_WITCH' && this.timeLoopPos) {
      const pos = this.timeLoopPos;
      this.x = pos.x; this.y = pos.y; this.vx = pos.vx; this.vy = pos.vy;
      this.damage = pos.damage;
      spawnParticles(this.centerX, this.centerY, '#cc44ff', 20, 5, 40);
      this.timeLoopPos = null;
    }
    // NEON_RYU: downB (Static Guard) grants brief invincible
    if (moveId === 'downB' && this.data.id === 'NEON_RYU') this.invincible = 30;
    // BIT_CRUSHER: downB fortress = invincible + rooted
    if (moveId === 'downB' && this.data.id === 'BIT_CRUSHER') {
      this.invincible = 120; this.rooted = 120;
    }
    // VHS_VIPER: sideB phase dash
    if (moveId === 'sideB' && this.data.id === 'VHS_VIPER') {
      this.x += this.facing * 120; this.invincible = 10;
    }
    // FROST_VALKYRIE: sideB valkyrie dash
    if (moveId === 'sideB' && this.data.id === 'FROST_VALKYRIE') {
      this.x += this.facing * 100; this.invincible = 8;
    }
    // PIXEL_PIRATE: upB geyser
    if (moveId === 'upB' && this.data.id === 'PIXEL_PIRATE') {
      this.invincible = 20;
    }
    // RETRO_RANGER: downB shield
    if (moveId === 'downB' && this.data.id === 'RETRO_RANGER') this.invincible = 30;

    // Schedule hitbox activation
    const activateAt = move.startup;
    setTimeout(() => {
      if (this.currentMove !== moveId) return;
      const cosmeticColor = this.getEquippedColor() || ELEMENTS[move.element]?.color || '#FFFFFF';
      this.attackBox = {
        x: this.x + (this.facing > 0 ? this.w : -50),
        y: this.y,
        w: move.type === 'projectile' ? 20 : 50,
        h: move.type === 'spike' ? 30 : (moveId.includes('u') ? 60 : 50),
        damage: move.damage,
        kb: move.kb,
        kbAngle: move.kbAngle,
        element: move.element,
        move: moveId,
        moveData: move,
        color: cosmeticColor,
        isProjectile: move.type === 'projectile',
        vx: move.type === 'projectile' ? this.facing * 8 : 0,
        vy: moveId === 'neutralB' && this.data.id === 'TERRA' ? 0 : 0,
        life: move.active * 16,
        owner: this.playerIndex,
      };
      if (move.type === 'projectile') projectiles.push({ ...this.attackBox });
      spawnParticles(this.attackBox.x + 25, this.attackBox.y + 25, cosmeticColor, 10, 4, 20);
    }, activateAt * 16);
  }

  getEquippedColor() {
    const cos = equippedCosmetics[this.data.id];
    if (!cos) return null;
    try { const d = JSON.parse(cos.color_data || '{}'); return d.primary || null; } catch { return null; }
  }

  applyPhysics(platforms, speedMult = 1) {
    if (this.onGround) {
      this.vx *= FRICTION;
    } else {
      this.vx *= AIR_FRICTION;
      this.vy += GRAVITY * (this.slowed ? 0.5 : 1);
      this.vy = Math.min(this.vy, MAX_FALL);
    }
    const maxSpeed = this.stats.speed * speedMult;
    this.vx = Math.max(-maxSpeed, Math.min(maxSpeed, this.vx));
    this.x += this.vx;
    this.y += this.vy;
    this.onGround = false;

    for (const p of platforms) {
      if (this.vy >= 0 && this.x + this.w > p.x && this.x < p.x + p.w &&
          this.feet > p.y && this.feet - this.vy <= p.y + 4) {
        this.y = p.y - this.h;
        this.vy = 0;
        this.onGround = true;
        this.jumpsLeft = 2;
      }
    }
    // Update state for anim
    if (this.state !== 'ATTACK' && this.state !== 'HURT' && this.state !== 'SPECIAL' && this.state !== 'ULTIMATE' && this.state !== 'SHIELD') {
      if (!this.onGround) this.state = this.vy < 0 ? 'JUMP' : 'FALL';
      else if (Math.abs(this.vx) > 0.5) this.state = 'WALK';
      else this.state = 'IDLE';
    }
  }

  updateAnim() {
    this.animTimer++;
    if (this.animTimer > 8) { this.animTimer = 0; this.animFrame = (this.animFrame + 1) % 2; }
  }

  // ─── AI ──────────────────────────────────────────────────────────────────
  updateAI(opponent, platforms) {
    if (!opponent) return;
    const dx = opponent.centerX - this.centerX;
    const dy = opponent.centerY - this.centerY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const fakeInput = { left: false, right: false, jump: false, jab: false, heavy: false, special: false, shield: false };

    if (Math.abs(dx) > 60) {
      if (dx > 0) { fakeInput.right = true; this.facing = 1; }
      else { fakeInput.left = true; this.facing = -1; }
    }
    if (dist < 100 && frame % 20 === 0) {
      if (Math.random() < 0.6) fakeInput.jab = true;
      else if (Math.random() < 0.3) fakeInput.heavy = true;
    }
    if (dist < 200 && frame % 45 === 0 && Math.random() < 0.3) fakeInput.special = true;
    if (this.onGround && dy < -80 && Math.random() < 0.4) fakeInput.jump = true;
    if (!this.onGround && dy < 0) fakeInput.jump = true;
    if (this.damage > 80 && Math.random() < 0.2) fakeInput.shield = true;
    // Jump off stage recovery
    if (this.x < 80 || this.x > CANVAS_W - 80) {
      fakeInput.jump = true;
      if (this.x < 80) { fakeInput.right = true; this.facing = 1; }
      else { fakeInput.left = true; this.facing = -1; }
    }

    this.applyPhysics(platforms, 1);
    if (fakeInput.left) this.vx -= this.stats.speed * 0.3;
    if (fakeInput.right) this.vx += this.stats.speed * 0.3;
    if (fakeInput.jump && this.jumpsLeft > 0) { this.vy = -this.stats.jumpStrength; this.jumpsLeft--; this.onGround = false; }
    if ((fakeInput.jab || fakeInput.heavy || fakeInput.special) && this.stateTimer === 0) {
      const moves = ['jab','ftilt','fsmash','neutralB','sideB'];
      const pick = moves[Math.floor(Math.random() * moves.length)];
      this.startAttack(pick);
    }
    this.updateAnim();
  }

  checkBlastZone() {
    return this.x + this.w < -BLAST_ZONE || this.x > CANVAS_W + BLAST_ZONE ||
           this.y + this.h < -BLAST_ZONE || this.y > CANVAS_H + BLAST_ZONE;
  }

  respawn() {
    this.x = this.playerIndex === 0 ? 200 : 560;
    this.y = 100;
    this.vx = 0; this.vy = 0;
    this.damage = 0;
    this.state = 'IDLE';
    this.attackBox = null;
    this.currentMove = null;
    this.frozen = 0; this.stunned = 0; this.rooted = 0;
    this.invincible = 180;
    this.spawnProtect = 120;
    this.shieldHP = 100;
    this.overcharged = false;
    this.jumpsLeft = 2;
  }

  draw() {
    if (this.state === 'DEAD') return;
    const cosColor = this.getEquippedColor();
    const elColor = ELEMENTS[this.data.element]?.color || '#FF4400';
    const primaryColor = cosColor || elColor;
    const secondaryColor = this.data.palette?.[1] || '#888888';

    ctx.save();
    if (this.invincible > 0 && Math.floor(frame / 4) % 2 === 0) ctx.globalAlpha = 0.5;
    if (this.hurtTimer > 0) ctx.globalAlpha = 0.7;

    const bobY = this.state === 'IDLE' ? Math.sin(frame * 0.08) * 1.5 : 0;
    const drawX = Math.round(this.x);
    const drawY = Math.round(this.y + bobY);

    // Shadow
    if (this.onGround) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(drawX + this.w/2, this.feet + 2, this.w/2, 4, 0, 0, Math.PI*2);
      ctx.fill();
    }

    ctx.translate(drawX + this.w/2, drawY + this.h/2);
    if (this.facing < 0) ctx.scale(-1, 1);

    // Draw retro pixel character
    this.drawPixelChar(primaryColor, secondaryColor);

    // Shield bubble
    if (this.shieldActive) {
      const shieldAlpha = 0.3 + (this.shieldHP / 100) * 0.5;
      ctx.globalAlpha = shieldAlpha;
      ctx.strokeStyle = '#8888FF';
      ctx.lineWidth = 3;
      const sr = 24 + (1 - this.shieldHP/100) * 8;
      ctx.beginPath();
      ctx.arc(0, 0, sr, 0, Math.PI*2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(100,100,255,0.2)';
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // Element aura
    if (this.state === 'ULTIMATE') {
      ctx.save();
      ctx.globalAlpha = 0.4 + Math.sin(frame * 0.2) * 0.2;
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(this.centerX, this.centerY, 32 + Math.sin(frame * 0.15) * 6, 0, Math.PI*2);
      ctx.stroke();
      ctx.restore();
    }

    // Hitbox overlay (training mode)
    if (gameMode === 'training' && this.attackBox && !this.attackBox.isProjectile) {
      ctx.save();
      ctx.strokeStyle = '#FF0000';
      ctx.lineWidth = 2;
      ctx.strokeRect(this.attackBox.x - this.x + drawX, this.attackBox.y - this.y + drawY, this.attackBox.w, this.attackBox.h);
      ctx.restore();
    }
  }

  drawPixelChar(primary, secondary) {
    const SCALE = 3;
    const d = this.data;
    const pal = d.palette || [];
    const el = ELEMENTS[d.element]?.color || primary;
    // Full 16-color palette. I=black always. A-H, J-P = pal[0]-pal[14]
    const COLORS = {
      A: pal[0]  || primary,    B: pal[1]  || secondary,
      C: pal[2]  || '#e8c090',  D: pal[3]  || '#aa7744',
      E: pal[4]  || el,         F: pal[5]  || '#ffffff',
      G: pal[6]  || '#888888',  H: pal[7]  || '#444444',
      J: pal[8]  || el,         K: pal[9]  || '#222222',
      L: pal[10] || '#cccccc',  M: pal[11] || '#cc3300',
      N: pal[12] || '#dddddd',  O: pal[13] || '#555555',
      P: pal[14] || '#333333',  I: '#000000',
    };

    // Developer palette override: red + gold for AMGProdZ / developer role
    const isDevPlayer = (currentUser?.role === 'developer' || currentUser?.username === 'AMGProdZ')
      && this.playerIndex === localPlayerIndex;
    if (isDevPlayer) {
      COLORS.A = '#cc1100'; COLORS.B = '#ffaa00'; COLORS.C = '#ffd060';
      COLORS.D = '#cc7700'; COLORS.E = '#ff3300'; COLORS.F = '#ffe080';
      COLORS.J = '#ff6600'; COLORS.L = '#ffdd88'; COLORS.N = '#ffcc44';
    }

    const sprite = d.sprite?.idle;
    if (sprite && sprite.length > 0) {
      const rows = sprite;
      const cols = rows[0].length;
      const offX = -Math.round((cols * SCALE) / 2);
      const offY = -Math.round((rows.length * SCALE) / 2);
      // Single-pass render — outlines are baked into sprite using 'I'
      for (let row = 0; row < rows.length; row++) {
        for (let col = 0; col < rows[row].length; col++) {
          const ch = rows[row][col];
          if (ch === '.' || ch === ' ') continue;
          const color = COLORS[ch];
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(offX + col * SCALE, offY + row * SCALE, SCALE, SCALE);
        }
      }
    } else {
      this.drawProceduralChar(primary, secondary);
    }

    // Per-character aura details drawn on top
    this.drawCharAura(primary);

    // Hurt flash
    if (this.hurtTimer > 0 && Math.floor(frame / 2) % 2 === 0) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#FFFFFF';
      const rows = sprite || [];
      const cols = rows[0]?.length || 14;
      const hw = Math.round(cols * SCALE / 2), hh = Math.round(rows.length * SCALE / 2);
      ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
      ctx.globalAlpha = 1;
    }
  }

  drawProceduralChar(primary, secondary) {
    const S = 3; // pixel scale
    const p = primary, s = secondary;
    const elC = ELEMENTS[this.data.element]?.color || '#FFFFFF';
    const skin = this.data.palette?.[5] || '#FFDBA4';
    const dark = this.data.palette?.[3] || '#333333';

    // walk cycle leg offset
    const legOff = this.state === 'WALK' ? (Math.floor(frame/6)%2===0 ? 2 : -2) : 0;
    const attacking = this.state === 'ATTACK' || this.state === 'ULTIMATE';

    // — Legs (2 pixel columns each)
    ctx.fillStyle = s;
    ctx.fillRect(-9*S/3, 9*S/3, 2*S, 5*S + legOff);
    ctx.fillRect(-3*S/3, 9*S/3, 2*S, 5*S - legOff);

    // — Feet
    ctx.fillStyle = dark;
    ctx.fillRect(-10*S/3, 14*S/3 + legOff, 3*S, S);
    ctx.fillRect(-4*S/3, 14*S/3 - legOff, 3*S, S);

    // — Body
    ctx.fillStyle = p;
    ctx.fillRect(-4*S, 1*S, 8*S, 8*S);

    // — Chest accent (element color)
    ctx.fillStyle = elC;
    ctx.fillRect(-2*S, 2*S, 4*S, 3*S);

    // — Arms
    ctx.fillStyle = p;
    if (attacking) {
      // Extended attack arm
      ctx.fillRect(4*S, 2*S, 5*S, 2*S);
      ctx.fillStyle = elC;
      ctx.fillRect(8*S, S, 3*S, 4*S);
    } else {
      ctx.fillRect(4*S, 2*S, 2*S, 3*S);
      ctx.fillRect(-6*S, 2*S, 2*S, 3*S);
    }

    // — Neck
    ctx.fillStyle = skin;
    ctx.fillRect(-S, -S, 2*S, 2*S);

    // — Head
    ctx.fillStyle = skin;
    ctx.fillRect(-3*S, -5*S, 6*S, 4*S);

    // — Eyes
    ctx.fillStyle = '#000000';
    ctx.fillRect(-2*S, -4*S, S, S);
    ctx.fillRect(S, -4*S, S, S);

    // — Outline (dark border pixels)
    ctx.fillStyle = '#000000';
    ctx.fillRect(-4*S - S, 0, S, 10*S); // left body edge
    ctx.fillRect(4*S, 0, S, 10*S);      // right body edge
    ctx.fillRect(-3*S - S, -6*S, S, 5*S); // left head edge
    ctx.fillRect(3*S, -6*S, S, 5*S);    // right head edge
  }

  drawCharAura(primary) {
    const id = this.data.id;
    const elC = ELEMENTS[this.data.element]?.color || primary;
    const t = frame;

    if (id === 'NEON_RYU') {
      // Lightning orbs orbiting fists
      ctx.fillStyle = '#ffff44';
      for (let i = 0; i < 2; i++) {
        const ang = (t * 0.08 + i * Math.PI);
        const ox = Math.round(Math.cos(ang) * 20);
        const oy = Math.round(Math.sin(ang) * 8) + 4;
        ctx.fillRect(ox, oy, 5, 5);
        ctx.fillStyle = '#aaaaff';
        ctx.fillRect(ox+1, oy+1, 3, 3);
        ctx.fillStyle = '#ffff44';
      }
    } else if (id === 'VHS_VIPER') {
      // Pixel static lines
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ff00ff';
      for (let i = 0; i < 3; i++) {
        const sy = -20 + i * 14 + ((t * 2 + i * 7) % 10);
        ctx.fillRect(-22, sy, 44, 2);
      }
      ctx.globalAlpha = 1;
    } else if (id === 'ARCADE_TITAN') {
      // Score display on chest
      ctx.fillStyle = '#ffdd00';
      ctx.font = '5px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('1UP', 0, -2);
      ctx.textAlign = 'left';
    } else if (id === 'TURBO_KID') {
      // Flame trail behind (wake pixels)
      const fColors = ['#FF4500','#FF8C00','#FFD700'];
      for (let i = 0; i < 3; i++) {
        const fx = -12 - i*5;
        const fy = 18 + (Math.sin(t*0.15 + i) * 2 | 0);
        ctx.fillStyle = fColors[i];
        ctx.fillRect(fx, fy, 4, 5 - i);
        ctx.fillRect(fx+1, fy-2, 2, 2);
      }
    } else if (id === 'PIXEL_PIRATE') {
      // Pixel water splash from cannon arm
      ctx.fillStyle = '#1e90ff';
      for (let i = 0; i < 3; i++) {
        const ang = (t * 0.05 + i * 2.09);
        const ox = Math.round(Math.cos(ang) * 18);
        const oy = Math.round(Math.sin(ang) * 6) + 6;
        ctx.fillRect(ox, oy, 4, 4);
      }
    } else if (id === 'SYNTH_SAMURAI') {
      // Katana glow (long pixel bar to the right)
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = '#88ccff';
      ctx.fillRect(6, -16, 3, 32);
      ctx.fillRect(7, -18, 2, 36);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(7, -18, 1, 36);
      ctx.globalAlpha = 1;
    } else if (id === 'GLITCH_WITCH') {
      // Pixel glitch scanlines across body
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#cc44ff';
      for (let i = 0; i < 4; i++) {
        const gy = -20 + i * 12 + ((t * 3 + i * 5) % 8);
        ctx.fillRect(-18, gy, 36, 2);
      }
      ctx.globalAlpha = 1;
    } else if (id === 'BIT_CRUSHER') {
      // Red glowing eye sensors
      ctx.fillStyle = '#ff4444';
      ctx.fillRect(-6, -12, 4, 4);
      ctx.fillRect(2, -12, 4, 4);
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(-8, -14, 8, 8);
      ctx.fillRect(0, -14, 8, 8);
      ctx.globalAlpha = 1;
    } else if (id === 'RETRO_RANGER') {
      // Visor light stripe + antenna
      ctx.fillStyle = '#ffdd00';
      ctx.fillRect(-10, -16, 20, 3);
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#ffdd00';
      ctx.fillRect(-9, -15, 18, 1);
      ctx.globalAlpha = 1;
      // antenna
      ctx.fillStyle = '#aaaaaa';
      ctx.fillRect(4, -34, 2, 8);
      ctx.fillStyle = '#ff4444';
      ctx.fillRect(3, -36, 4, 4);
    } else if (id === 'VENOM_VOODOO') {
      // Green toxic wisps floating up
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 4; i++) {
        const wx = -10 + i * 7;
        const wy = -30 - ((t * 0.5 + i * 12) % 20);
        ctx.fillStyle = i % 2 === 0 ? '#44cc44' : '#88ff44';
        ctx.fillRect(Math.round(wx + Math.sin(t*0.07+i)*3), Math.round(wy), 3, 4);
      }
      ctx.globalAlpha = 1;
    } else if (id === 'FROST_VALKYRIE') {
      // Ice crystal crown
      ctx.fillStyle = '#a8d8f0';
      for (let i = -8; i <= 8; i += 5) {
        ctx.fillRect(i, -34, 2, 8);
        ctx.fillRect(i+1, -37, 1, 4);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-1, -38, 2, 4);
    } else if (id === 'INFERNO_BRAWLER') {
      // Body fire aura (pixel flame columns)
      const fC = ['#FF4500','#FF8C00','#FFD700'];
      for (let i = 0; i < 5; i++) {
        const fx = -14 + i * 7;
        const fy = -28 - (Math.sin(t * 0.1 + i) * 4 | 0);
        ctx.fillStyle = fC[i % 3];
        ctx.fillRect(fx, fy, 3, 6);
        ctx.fillRect(fx+1, fy-3, 2, 3);
      }
      // Shoulder flames
      ctx.fillStyle = '#FF4500';
      ctx.fillRect(-20, -4, 5, 8);
      ctx.fillRect(15, -4, 5, 8);
    } else if (id === 'SHADOW_BEAST') {
      // Void tendrils radiating out
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = '#8800ff';
      for (let i = 0; i < 6; i++) {
        const ang = t * 0.03 + i * Math.PI / 3;
        const tx2 = Math.round(Math.cos(ang) * 26);
        const ty2 = Math.round(Math.sin(ang) * 18);
        ctx.fillRect(tx2, ty2, 4, 4);
        ctx.fillRect(tx2 + Math.round(Math.cos(ang)*8), ty2 + Math.round(Math.sin(ang)*6), 3, 3);
      }
      ctx.globalAlpha = 1;
      // Red eyes
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(-6, -8, 5, 5);
      ctx.fillRect(1, -8, 5, 5);
      ctx.fillStyle = '#ff8888';
      ctx.fillRect(-5, -7, 3, 3);
      ctx.fillRect(2, -7, 3, 3);
    }

    // ── Developer overlay (AMGProdZ / developer role) ──────────────────────
    const isDevAura = (currentUser?.role === 'developer' || currentUser?.username === 'AMGProdZ')
      && this.playerIndex === localPlayerIndex;
    if (isDevAura) {
      // Pulsing gold outer glow ring
      const pulse = 0.18 + Math.sin(t * 0.09) * 0.10;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#ffaa00';
      for (let rx = -26; rx <= 26; rx += 4) {
        ctx.fillRect(rx, -36, 4, 4);
        ctx.fillRect(rx, 22, 4, 4);
      }
      for (let ry = -32; ry <= 18; ry += 4) {
        ctx.fillRect(-28, ry, 4, 4);
        ctx.fillRect(24, ry, 4, 4);
      }
      ctx.globalAlpha = 1;

      // Gold pixel crown above head
      const crownY = -44;
      // base bar
      ctx.fillStyle = '#ffaa00';
      ctx.fillRect(-12, crownY + 8, 24, 4);
      // 5 crown points
      const pts = [-10, -5, 0, 5, 10];
      for (const px of pts) {
        const h = (Math.abs(px) === 0) ? 10 : (Math.abs(px) === 5 ? 7 : 5);
        ctx.fillRect(px - 2, crownY + 8 - h, 4, h);
      }
      // Gold gem at top center
      ctx.fillStyle = '#ff2200';
      ctx.fillRect(-3, crownY - 3, 6, 6);
      ctx.fillStyle = '#ff8888';
      ctx.fillRect(-2, crownY - 2, 3, 3);
      // Gold trim outline on crown
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#ffe066';
      ctx.fillRect(-12, crownY + 8, 24, 2);
      ctx.globalAlpha = 1;

      // Red + gold orbiting sparks (3 pairs)
      for (let i = 0; i < 6; i++) {
        const ang = t * 0.05 + i * (Math.PI / 3);
        const ox = Math.round(Math.cos(ang) * 28);
        const oy = Math.round(Math.sin(ang) * 20);
        ctx.fillStyle = i % 2 === 0 ? '#ff2200' : '#ffaa00';
        ctx.fillRect(ox - 2, oy - 2, 5, 5);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = i % 2 === 0 ? '#ff8866' : '#ffe066';
        ctx.fillRect(ox - 1, oy - 1, 3, 3);
        ctx.globalAlpha = 1;
      }

      // "DEV" micro badge next to head
      ctx.fillStyle = '#cc1100';
      ctx.fillRect(18, -30, 22, 10);
      ctx.fillStyle = '#ffe066';
      ctx.font = '6px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('DEV', 29, -23);
      ctx.textAlign = 'left';

      // Gold shoulder epaulettes
      ctx.fillStyle = '#ffaa00';
      ctx.fillRect(-24, -8, 6, 4);
      ctx.fillRect(18, -8, 6, 4);
      ctx.fillStyle = '#ff2200';
      ctx.fillRect(-24, -10, 6, 3);
      ctx.fillRect(18, -10, 6, 3);
    }
  }
}

// ─── PROJECTILES ──────────────────────────────────────────────────────────────
const projectiles = [];
function updateProjectiles(fighterArr) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.x += pr.vx; pr.y += pr.vy; pr.life -= 16;
    if (pr.life <= 0 || pr.x < -100 || pr.x > CANVAS_W+100) { projectiles.splice(i, 1); continue; }
    for (const f of fighterArr) {
      if (f.playerIndex === pr.owner || f.stocks <= 0) continue;
      if (pr.x < f.x+f.w && pr.x+pr.w > f.x && pr.y < f.y+f.h && pr.y+pr.h > f.y) {
        const res = f.takeDamage(pr.damage, pr.kb, 0.6, pr.kbAngle, pr.x, pr.element);
        if (res && res !== false) {
          const attacker = fighterArr.find(ff => ff.playerIndex === pr.owner);
          if (attacker) {
            attacker.ultimateMeter = Math.min(ULTIMATE_MAX, attacker.ultimateMeter + pr.damage * 0.4);
            attacker.combo++;
            attacker.comboTimer = 90;
            if (attacker.combo >= 3) comboDisplays.push({ x: f.centerX, y: f.y - 20, combo: attacker.combo, life: 60 });
            if (pr.element && f.data.element) {
              const rx = (pr.x + f.centerX) / 2, ry = (pr.y + f.centerY) / 2;
              triggerReaction(pr.element, f.data.element, rx, ry);
            }
          }
          projectiles.splice(i, 1);
        }
        break;
      }
    }
  }
}
function drawProjectiles() {
  for (const pr of projectiles) {
    const cx = Math.round(pr.x + pr.w/2);
    const cy = Math.round(pr.y + pr.h/2);
    const elC = ELEMENTS[pr.element]?.color || '#FFFFFF';
    const el = pr.element;

    if (el === 'FIRE' || el === 'MAGMA') {
      // Pixel fireball: 3x3 core + spark pixels
      ctx.fillStyle = '#FFD700'; ctx.fillRect(cx-2, cy-2, 4, 4);
      ctx.fillStyle = elC;       ctx.fillRect(cx-4, cy-4, 8, 8);
      ctx.fillStyle = '#FF8C00'; ctx.fillRect(cx-6, cy-2, 3, 4); ctx.fillRect(cx+3, cy-2, 3, 4);
      ctx.fillStyle = '#FF4500'; ctx.fillRect(cx-2, cy-6, 4, 3); ctx.fillRect(cx-2, cy+3, 4, 3);
    } else if (el === 'ICE') {
      // Pixel arrow/shard: pointed right-moving shape
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(cx-2, cy-2, 4, 4);
      ctx.fillStyle = elC;       ctx.fillRect(cx-6, cy-1, 8, 2);
      ctx.fillStyle = '#4488bb'; ctx.fillRect(cx+2, cy-3, 2, 6);
      ctx.fillStyle = '#88ccff'; ctx.fillRect(cx-8, cy-1, 3, 2);
    } else if (el === 'LIGHTNING') {
      // Pixel lightning bolt
      ctx.fillStyle = elC;
      ctx.fillRect(cx+2, cy-6, 3, 4);
      ctx.fillRect(cx-1, cy-2, 5, 3);
      ctx.fillRect(cx+1, cy+1, 3, 4);
      ctx.globalAlpha = 0.5; ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(cx+2, cy-6, 2, 10); ctx.globalAlpha = 1;
    } else if (el === 'WATER') {
      // Pixel droplet
      ctx.fillStyle = elC;       ctx.fillRect(cx-3, cy-2, 6, 5);
      ctx.fillStyle = '#88ccff'; ctx.fillRect(cx-2, cy-4, 4, 2);
      ctx.fillStyle = '#1e90ff'; ctx.fillRect(cx-1, cy-5, 2, 1);
      ctx.fillStyle = 'rgba(30,144,255,0.4)';
      ctx.fillRect(cx-5, cy-3, 10, 8);
    } else if (el === 'SHADOW' || el === 'VOID') {
      // Pixel void orb (cross shape)
      ctx.fillStyle = elC;
      ctx.fillRect(cx-2, cy-6, 4, 12);
      ctx.fillRect(cx-6, cy-2, 12, 4);
      ctx.globalAlpha = 0.5; ctx.fillStyle = '#000000';
      ctx.fillRect(cx-4, cy-4, 8, 8); ctx.globalAlpha = 1;
      ctx.fillStyle = elC; ctx.fillRect(cx-2, cy-2, 4, 4);
    } else if (el === 'NATURE') {
      // Pixel leaf
      ctx.fillStyle = elC;       ctx.fillRect(cx-3, cy-3, 6, 6);
      ctx.fillStyle = '#44cc44'; ctx.fillRect(cx-5, cy-1, 4, 3);
      ctx.fillStyle = '#005500'; ctx.fillRect(cx, cy, 2, 4);
    } else if (el === 'WIND') {
      // Pixel wind slash
      ctx.fillStyle = elC;
      ctx.fillRect(cx-8, cy-1, 16, 2);
      ctx.fillRect(cx-6, cy-3, 12, 2);
      ctx.fillRect(cx-4, cy+1, 8, 2);
    } else if (el === 'LIGHT') {
      // Pixel cross/star
      ctx.fillStyle = elC;
      ctx.fillRect(cx-1, cy-8, 2, 16);
      ctx.fillRect(cx-8, cy-1, 16, 2);
      ctx.globalAlpha = 0.4; ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(cx-5, cy-5, 10, 10); ctx.globalAlpha = 1;
    } else if (el === 'TIME') {
      // Pixel clock gear shape
      ctx.fillStyle = elC;
      ctx.fillRect(cx-4, cy-4, 8, 8);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(cx-1, cy-6, 2, 2);
      ctx.fillRect(cx-1, cy+4, 2, 2);
      ctx.fillRect(cx+4, cy-1, 2, 2);
      ctx.fillRect(cx-6, cy-1, 2, 2);
    } else {
      // Generic pixel orb
      ctx.fillStyle = '#000000'; ctx.fillRect(cx-5, cy-5, 10, 10);
      ctx.fillStyle = elC;       ctx.fillRect(cx-4, cy-4, 8, 8);
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(cx-2, cy-4, 2, 2);
    }
  }
}

// ─── HUD HELPERS ─────────────────────────────────────────────────────────────
function drawPixelBorder(x, y, w, h, elColor) {
  // NES-style 3-layer pixel border
  ctx.fillStyle = '#000000';
  ctx.fillRect(x-2, y-2, w+4, h+4);
  ctx.fillStyle = elColor;
  ctx.fillRect(x-1, y-1, w+2, h+2);
  ctx.fillStyle = '#000000';
  ctx.fillRect(x, y, w, h);
  // Top-left highlight pixel
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(x-1, y-1, w+2, 1);
  ctx.fillRect(x-1, y-1, 1, h+2);
  // Bottom-right shadow pixel
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x-1, y+h, w+2, 1);
  ctx.fillRect(x+w, y-1, 1, h+2);
}

function drawPixelStockIcon(cx, cy, size, filled, color) {
  // Square pixel stock icon (NES style — solid square with border)
  ctx.fillStyle = '#000000';
  ctx.fillRect(cx - size - 1, cy - size - 1, size*2 + 2, size*2 + 2);
  ctx.fillStyle = filled ? color : '#1a1a2a';
  ctx.fillRect(cx - size, cy - size, size*2, size*2);
  if (filled) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(cx - size, cy - size, size*2, 2);
    ctx.fillRect(cx - size, cy - size, 2, size*2);
  }
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function drawHUD() {
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const isRight = i === 1;
    const bx = isRight ? CANVAS_W - 236 : 8;
    const by = CANVAS_H - 82;
    const panelW = 220, panelH = 74;
    const elColor = ELEMENTS[p.data.element]?.color || '#FFFFFF';
    const isDevHUD = i === localPlayerIndex
      && (currentUser?.role === 'developer' || currentUser?.username === 'AMGProdZ');
    const hudColor = isDevHUD ? '#ffaa00' : elColor;

    // NES panel background + pixel border
    ctx.fillStyle = isDevHUD ? 'rgba(20,4,0,0.92)' : 'rgba(2,2,10,0.88)';
    ctx.fillRect(bx, by, panelW, panelH);
    drawPixelBorder(bx, by, panelW, panelH, hudColor);
    if (isDevHUD) {
      // Second inner border in red
      drawPixelBorder(bx + 2, by + 2, panelW - 4, panelH - 4, '#cc1100');
    }

    // Element color accent bar on top
    ctx.fillStyle = hudColor;
    ctx.fillRect(bx, by, panelW, 3);
    if (isDevHUD) {
      ctx.fillStyle = '#cc1100';
      ctx.fillRect(bx, by + 3, panelW, 2);
    }

    // Character name (pixel font via canvas — use small rects for "pixel text" feel)
    ctx.fillStyle = isDevHUD ? (frame % 20 < 10 ? '#ffdd44' : '#ffaa00') : elColor;
    ctx.font = '7px "Press Start 2P", monospace';
    ctx.textAlign = isRight ? 'right' : 'left';
    const nameX = isRight ? bx + panelW - 8 : bx + 8;
    ctx.fillText(p.data.name.toUpperCase(), nameX, by + 16);
    ctx.textAlign = 'left';

    // Damage % — large pixel number
    const dmgColor = p.damage > 120 ? '#ff2222' : p.damage > 80 ? '#ff8800' : p.damage > 50 ? '#ffcc00' : '#44ff88';
    ctx.fillStyle = dmgColor;
    ctx.font = '22px "Press Start 2P", monospace';
    ctx.textAlign = isRight ? 'right' : 'left';
    const dmgX = isRight ? bx + 110 : bx + 8;
    ctx.fillText(Math.round(p.damage) + '%', dmgX, by + 48);
    ctx.textAlign = 'left';

    // Stock icons (pixel squares)
    for (let s = 0; s < STOCK_COUNT; s++) {
      const sx = isRight ? bx + panelW - 16 - s * 18 : bx + panelW - 60 + s * 18;
      drawPixelStockIcon(sx, by + 35, 6, s < p.stocks, hudColor);
    }

    // Ultimate meter bar (segmented, NES style)
    const meterX = bx + 8, meterY = by + panelH - 14, meterW = panelW - 16, meterH = 8;
    const segCount = 10;
    const segW = Math.floor(meterW / segCount) - 1;
    const filledSegs = Math.floor((p.ultimateMeter / ULTIMATE_MAX) * segCount);
    const ulFull = p.ultimateMeter >= ULTIMATE_MAX;

    for (let seg = 0; seg < segCount; seg++) {
      const sx = meterX + seg * (segW + 1);
      ctx.fillStyle = '#000000';
      ctx.fillRect(sx - 1, meterY - 1, segW + 2, meterH + 2);
      if (seg < filledSegs) {
        const segColor = ulFull ? (frame % 12 < 6 ? '#FFD700' : '#FFFFFF') : hudColor;
        ctx.fillStyle = segColor;
        ctx.fillRect(sx, meterY, segW, meterH);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillRect(sx, meterY, segW, 2);
      } else {
        ctx.fillStyle = '#0a0a18';
        ctx.fillRect(sx, meterY, segW, meterH);
      }
    }

    // "RIFT" label above meter
    ctx.fillStyle = ulFull ? (frame % 12 < 6 ? '#FFD700' : '#FFFFFF') : '#3a3a6a';
    ctx.font = '5px "Press Start 2P", monospace';
    ctx.textAlign = isRight ? 'right' : 'left';
    ctx.fillText(ulFull ? 'RIFT READY!' : 'RIFT METER', nameX, by + panelH - 16);
    ctx.textAlign = 'left';
  }

  // ─── Center timer ─────────────────────────────────────────────────────────
  const secs = Math.max(0, 480 - Math.floor(frame / 60));
  const timerStr = secs.toString().padStart(2, '0');
  const tx = CANVAS_W / 2 - 28, ty = 6;
  ctx.fillStyle = 'rgba(2,2,10,0.88)';
  ctx.fillRect(tx, ty, 56, 28);
  drawPixelBorder(tx, ty, 56, 28, secs < 30 ? '#ff3333' : '#333366');
  ctx.fillStyle = secs < 30 ? '#ff4444' : '#aaaacc';
  ctx.font = '14px "Press Start 2P", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(timerStr, CANVAS_W / 2, ty + 20);
  ctx.textAlign = 'left';

  // ─── Combo displays ───────────────────────────────────────────────────────
  for (let i = comboDisplays.length - 1; i >= 0; i--) {
    const cd = comboDisplays[i];
    cd.y -= 0.6; cd.life--;
    if (cd.life <= 0) { comboDisplays.splice(i, 1); continue; }
    const ca = cd.life / 60;
    ctx.globalAlpha = ca;
    // Pixel text shadow
    ctx.fillStyle = '#000000';
    ctx.font = '9px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${cd.combo} HIT!`, cd.x + 2, cd.y + 2);
    ctx.fillStyle = cd.combo >= 8 ? '#ff2244' : cd.combo >= 5 ? '#ff8800' : '#FFD700';
    ctx.fillText(`${cd.combo} HIT!`, cd.x, cd.y);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  // ─── Training mode label ───────────────────────────────────────────────────
  if (gameMode === 'training') {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(CANVAS_W/2 - 90, 40, 180, 18);
    drawPixelBorder(CANVAS_W/2 - 90, 40, 180, 18, '#00cc44');
    ctx.fillStyle = '#00ff66';
    ctx.font = '6px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('TRAINING — ESC TO EXIT', CANVAS_W/2, 53);
    ctx.textAlign = 'left';
  }
}

// ─── STAGE ────────────────────────────────────────────────────────────────────
function buildStage(stageName) {
  const sd = STAGES[stageName] || STAGES.VERDANT_THRONE;
  return {
    name: sd.name,
    element: sd.element,
    bgColor: sd.bgColor,
    platforms: sd.platforms.map((p, i) => new Platform(p.x, p.y, p.w, p.h, i !== 0)),
    hazards: sd.hazards || [],
  };
}

// Parallax BG config per stage element
const STAGE_BG = {
  FIRE:  { sky:['#1a0500','#2d0a00','#3a1000'], stars:'#ff6600', starAlpha:0.4, mist:'#ff3300', mistAlpha:0.06 },
  ICE:   { sky:['#000d1a','#001428','#001e3a'], stars:'#88ccff', starAlpha:0.7, mist:'#44aaff', mistAlpha:0.05 },
  EARTH: { sky:['#050d00','#0a1600','#0f1e00'], stars:'#88aa44', starAlpha:0.4, mist:'#336600', mistAlpha:0.07 },
  WIND:  { sky:['#080e18','#0d1628','#121e38'], stars:'#ccddee', starAlpha:0.6, mist:'#6688bb', mistAlpha:0.06 },
  LIGHT: { sky:['#0a0800','#14100a','#1e1800'], stars:'#ffd700', starAlpha:0.9, mist:'#ffcc00', mistAlpha:0.08 },
  SHADOW:{ sky:['#010005','#05000f','#08001a'], stars:'#8800ff', starAlpha:0.5, mist:'#4400aa', mistAlpha:0.08 },
  LIGHTNING:{ sky:['#050500','#0f0f00','#1a1a00'], stars:'#ffff44', starAlpha:0.8, mist:'#cccc00', mistAlpha:0.06 },
  WATER: { sky:['#000a18','#001428','#001e3a'], stars:'#1e90ff', starAlpha:0.5, mist:'#0055cc', mistAlpha:0.07 },
  NATURE:{ sky:['#010800','#040f00','#071500'], stars:'#44ff66', starAlpha:0.4, mist:'#00aa22', mistAlpha:0.07 },
  TIME:  { sky:['#05000e','#0a0018','#100025'], stars:'#bb88ff', starAlpha:0.7, mist:'#8840cc', mistAlpha:0.07 },
  VOID:  { sky:['#000000','#020004','#050008'], stars:'#440088', starAlpha:0.5, mist:'#220044', mistAlpha:0.09 },
  MAGMA: { sky:['#0f0300','#1a0500','#280800'], stars:'#ff6600', starAlpha:0.5, mist:'#dd3300', mistAlpha:0.08 },
  AETHER:{ sky:['#02020a','#050512','#09091e'], stars:'#ffffff', starAlpha:0.9, mist:'#aaaaff', mistAlpha:0.05 },
};

function drawStage(stageObj) {
  const cfg = STAGE_BG[stageObj.element] || STAGE_BG.EARTH;

  // Layer 0: sky gradient (3-strip pixel gradient)
  const stripH = CANVAS_H / 3;
  ctx.fillStyle = cfg.sky[0]; ctx.fillRect(0, 0, CANVAS_W, stripH);
  ctx.fillStyle = cfg.sky[1]; ctx.fillRect(0, stripH, CANVAS_W, stripH);
  ctx.fillStyle = cfg.sky[2]; ctx.fillRect(0, stripH*2, CANVAS_W, CANVAS_H - stripH*2);

  // Layer 1: distant stars / specks (parallax speed 0.2)
  ctx.fillStyle = cfg.stars;
  for (let i = 0; i < 48; i++) {
    const sx = Math.round(((i * 137.5 + frame * 0.2) % CANVAS_W));
    const sy = Math.round(((i * 91.3) % (CANVAS_H - 150)));
    const bright = (i % 3 === 0);
    ctx.globalAlpha = cfg.starAlpha * (bright ? 1 : 0.4);
    ctx.fillRect(sx, sy, bright ? 2 : 1, bright ? 2 : 1);
  }
  ctx.globalAlpha = 1;

  // Layer 2: mid-distance silhouette columns (parallax speed 0.5)
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = cfg.stars;
  for (let i = 0; i < 12; i++) {
    const bx = Math.round(((i * 80 - frame * 0.5) % (CANVAS_W + 80) + CANVAS_W + 80) % (CANVAS_W + 80)) - 40;
    const bh = 60 + (i * 43 % 80);
    // Pixel-block silhouette
    ctx.fillRect(bx, CANVAS_H - 140 - bh, 8, bh);
    ctx.fillRect(bx + 10, CANVAS_H - 140 - bh + 16, 6, bh - 16);
    ctx.fillRect(bx + 18, CANVAS_H - 140 - bh + 8, 6, bh - 8);
  }
  ctx.globalAlpha = 1;

  // Layer 3: ground mist
  ctx.globalAlpha = cfg.mistAlpha;
  ctx.fillStyle = cfg.mist;
  ctx.fillRect(0, CANVAS_H - 160, CANVAS_W, 160);
  ctx.globalAlpha = 1;

  // Element-specific detail
  if (stageObj.element === 'FIRE' || stageObj.element === 'MAGMA') {
    // Lava drips (pixel-square drops)
    for (let i = 0; i < 6; i++) {
      const dx = (i * 137 + 60) % CANVAS_W;
      const dy = ((frame * 0.8 + i * 90) % 120) + 40;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ff4400';
      ctx.fillRect(Math.round(dx), Math.round(dy), 3, 6);
      ctx.fillRect(Math.round(dx) + 1, Math.round(dy) + 6, 1, 3);
      ctx.globalAlpha = 1;
    }
  } else if (stageObj.element === 'ICE') {
    // Snowflakes
    for (let i = 0; i < 20; i++) {
      const sx = ((i * 113 + frame * 0.6) % CANVAS_W);
      const sy = ((frame * 0.4 + i * 70) % (CANVAS_H - 120));
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(sx), Math.round(sy), 2, 2);
      ctx.globalAlpha = 1;
    }
  } else if (stageObj.element === 'LIGHTNING') {
    // Occasional pixel lightning streak
    if (frame % 80 < 4) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffff44';
      const lx = (frame * 83) % (CANVAS_W - 10);
      for (let y = 0; y < 120; y += 8) {
        ctx.fillRect(lx + (y % 16 < 8 ? 0 : 3), y, 2, 6);
      }
      ctx.globalAlpha = 1;
    }
  } else if (stageObj.element === 'VOID') {
    // Void rifts — pulsing pixel rectangles
    for (let i = 0; i < 3; i++) {
      const vx = 80 + i * 280;
      const vy = 80 + (Math.sin(frame * 0.03 + i) * 20);
      ctx.globalAlpha = 0.15 + Math.sin(frame * 0.04 + i) * 0.05;
      ctx.fillStyle = '#8800ff';
      ctx.fillRect(Math.round(vx), Math.round(vy), 6, 40);
      ctx.fillRect(Math.round(vx) - 2, Math.round(vy) + 10, 10, 4);
      ctx.globalAlpha = 1;
    }
  }

  // Draw platforms with element-themed tiles
  for (const pl of stageObj.platforms) pl.draw(stageObj.element);
}

// ─── ELEMENTAL REACTION RENDERING ─────────────────────────────────────────────
function drawElementalReactions() {
  for (let i = elementalParticles.length - 1; i >= 0; i--) {
    const ep = elementalParticles[i];
    ep.life--;
    if (ep.life <= 0) { elementalParticles.splice(i, 1); continue; }
    const alpha = ep.life / ep.maxLife;
    const rise = (ep.maxLife - ep.life) * 0.6;
    const px = Math.round(ep.x);
    const py = Math.round(ep.y - rise);

    ctx.globalAlpha = alpha;

    // Pixel box background
    ctx.fillStyle = '#000000';
    ctx.fillRect(px - 38, py - 14, 76, 18);
    ctx.fillStyle = ep.reaction.color;
    ctx.fillRect(px - 37, py - 13, 74, 16);
    ctx.fillStyle = '#000000';
    ctx.fillRect(px - 36, py - 12, 72, 14);

    // Reaction name in pixel font
    ctx.fillStyle = ep.reaction.color;
    ctx.font = '6px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(ep.reaction.name.toUpperCase(), px, py);

    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }
}

// ─── TUTORIAL SYSTEM ─────────────────────────────────────────────────────────
const TUTORIAL_STEPS = [
  {
    id: 'welcome',
    title: 'WELCOME TO AETHORIA',
    body: 'You\'re about to learn everything you need to fight in the Rift. The training bot won\'t attack yet. Press NEXT when ready.',
    task: null,
    botPassive: true,
  },
  {
    id: 'move',
    title: 'MOVEMENT',
    body: 'Move left and right with ← → (P2) or A/D (P1).\nWalk all the way to the left blast zone edge and back.',
    task: (p) => p.x < 80 && p._tutReachedLeft,
    hint: 'Walk left to the edge of the stage!',
    onFrame: (p) => { if (p.x < 80) p._tutReachedLeft = true; },
    botPassive: true,
  },
  {
    id: 'jump',
    title: 'JUMPING',
    body: 'Press Jump (↑ or W) to jump. Press it again in mid-air for a DOUBLE JUMP.\nPerform a double jump now.',
    task: (p) => p._tutDoubleJumped,
    hint: 'Jump, then jump again mid-air!',
    onFrame: (p) => { if (!p.onGround && p.jumpsLeft === 0) p._tutDoubleJumped = true; },
    botPassive: true,
  },
  {
    id: 'fall',
    title: 'DROP THROUGH PLATFORMS',
    body: 'Hold ↓ (or S) and press Jump while standing on a platform to fall through it.',
    task: (p) => p._tutDropped,
    hint: 'Stand on a platform above the ground, then hold down + jump.',
    onFrame: (p, platforms) => {
      // Mark if player just dropped through a platform (was on platform, now falling through)
      if (!p.onGround && p.vy > 2 && p._wasOnPlatform) p._tutDropped = true;
      p._wasOnPlatform = p.onGround && platforms.some(pl => pl.passThrough && Math.abs((p.y + p.h) - pl.y) < 5 && p.x + p.w > pl.x && p.x < pl.x + pl.w);
    },
    botPassive: true,
  },
  {
    id: 'jab',
    title: 'JAB ATTACK',
    body: 'The Jab is your fastest attack. Press Jab (G for P1, L for P2) to land a quick hit.\nHit the bot 3 times with jabs.',
    task: (p) => (p._tutJabHits || 0) >= 3,
    hint: 'Get close and press Jab!',
    trackHit: 'jab',
    botPassive: true,
  },
  {
    id: 'smash',
    title: 'SMASH ATTACKS',
    body: 'Hold Heavy (F/K) for a powerful Smash. Directional input changes it:\n• Neutral = Forward Smash\n• Up+Heavy = Up Smash\n• Down+Heavy = Down Smash\nLand any smash attack on the bot.',
    task: (p) => p._tutSmashHit,
    hint: 'Press Heavy (F or K) while near the bot!',
    trackHit: 'smash',
    botPassive: true,
  },
  {
    id: 'aerial',
    title: 'AERIAL ATTACKS',
    body: 'Attack while airborne for aerials. Each direction gives a different move.\nLand an aerial attack on the bot.',
    task: (p) => p._tutAerialHit,
    hint: 'Jump and press Jab or Heavy while in the air!',
    trackHit: 'aerial',
    botPassive: true,
  },
  {
    id: 'special',
    title: 'SPECIAL MOVES',
    body: 'Press Special (H/J) for unique elemental moves:\n• Neutral Special = ranged attack\n• Side Special = dash/charge\n• Up Special = recovery move\n• Down Special = unique effect\nUse any special move.',
    task: (p) => p._tutSpecialUsed,
    hint: 'Press Special (H or J)!',
    onFrame: (p) => { if (p.state === 'ATTACK' && p._lastMove?.includes('B')) p._tutSpecialUsed = true; },
    botPassive: true,
  },
  {
    id: 'shield',
    title: 'SHIELD & PARRY',
    body: 'Hold Shield (T/I) to block attacks. The shield shrinks over time — don\'t hold too long!\nBONUS: Press Shield the instant an attack hits for a PARRY counter.\nHold shield for 2 seconds.',
    task: (p) => (p._tutShieldTime || 0) >= 120,
    hint: 'Hold Shield (T or I)!',
    onFrame: (p) => { if (p.shieldActive) p._tutShieldTime = (p._tutShieldTime || 0) + 1; },
    botPassive: false, // bot will attack gently during shield step
  },
  {
    id: 'grab',
    title: 'GRABBING',
    body: 'Grabs bypass shields! Press Grab (Y/O) near an opponent to grab them.\nGrab the bot.',
    task: (p) => p._tutGrabbed,
    hint: 'Get close and press Grab (Y or O)!',
    onFrame: (p) => { if (p.state === 'GRAB') p._tutGrabbed = true; },
    botPassive: true,
  },
  {
    id: 'ultimate',
    title: 'RIFT METER & ULTIMATE',
    body: 'The segmented bar at the bottom of your HUD is the RIFT METER.\nIt fills as you deal and take damage.\nWhen FULL, press Heavy + Special simultaneously for your ULTIMATE — a devastating move unique to each character.\nFill your meter and use your Ultimate!',
    task: (p) => p._tutUltimateUsed,
    hint: 'Deal damage to fill the meter, then press Heavy+Special at once!',
    onFrame: (p) => { if (p.state === 'ULTIMATE') p._tutUltimateUsed = true; },
    botPassive: false,
  },
  {
    id: 'elements',
    title: 'ELEMENTAL REACTIONS',
    body: 'Every fighter has an element. When two different elements collide, they trigger a REACTION:\n• Fire + Ice = STEAM BURST (area damage)\n• Lightning + Water = SHOCK FLOOD\n• Wind + Fire = INFERNO TORNADO\n...and many more!\nHit the bot to trigger an elemental reaction.',
    task: (p) => p._tutReactionTriggered,
    hint: 'Just keep attacking — the reaction triggers automatically!',
    botPassive: false,
  },
  {
    id: 'stocks',
    title: 'STOCKS & KNOCKBACK',
    body: 'Each player has 3 stocks (lives). Your damage % is shown in the HUD — higher % = farther knockback.\nKnock the bot off the stage to take a stock!\nThe bot is now set to 150% damage — one good hit will send it flying.',
    task: (p, bot) => bot && bot.stocks < 3,
    hint: 'Hit the bot hard to launch it off the stage!',
    onStart: (bot) => { if (bot) bot.damage = 150; },
    botPassive: false,
  },
  {
    id: 'done',
    title: 'TUTORIAL COMPLETE!',
    body: 'You know everything. Movement, attacks, aerials, specials, shield, grab, ultimate, elements, and stocks.\nNow go fight for real. Press FINISH to return to the menu.',
    task: null,
    botPassive: true,
  },
];

function startTutorial() {
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('game-canvas').style.display = 'block';
  // Use NEON_RYU vs ARCADE_TITAN so we get lightning vs earth = reaction
  startGame(['NEON_RYU', 'ARCADE_TITAN'], 'VERDANT_THRONE', 'tutorial');
  players[1].isAI = true;
  players[1].stocks = 99; // bot won't run out of lives
  tutorialState = {
    step: 0,
    stepFrame: 0,
    msgAlpha: 0,
    nextPressed: false,
    acknowledged: false,
  };
  // Freeze bot during first passive steps
  _applyTutorialBotBehavior();
}

function _applyTutorialBotBehavior() {
  if (!tutorialState || !players[1]) return;
  const step = TUTORIAL_STEPS[tutorialState.step];
  players[1].isAI = !step.botPassive;
  if (step.botPassive) {
    // Stand still and reset bot damage
    players[1].vx = 0; players[1].vy = 0;
  }
  if (step.onStart) step.onStart(players[1]);
}

function advanceTutorial() {
  if (!tutorialState) return;
  const next = tutorialState.step + 1;
  if (next >= TUTORIAL_STEPS.length) {
    tutorialState = null;
    renderMenu();
    return;
  }
  tutorialState.step = next;
  tutorialState.stepFrame = 0;
  tutorialState.acknowledged = false;
  // Reset bot state
  if (players[1]) {
    players[1].damage = 0;
    players[1].vx = 0; players[1].vy = 0;
    players[1].x = 560; players[1].y = 300;
  }
  _applyTutorialBotBehavior();
}

function drawTutorialHUD() {
  if (!tutorialState) return;
  const ts = tutorialState;
  const step = TUTORIAL_STEPS[ts.step];
  ts.stepFrame++;

  // Run per-frame task tracking
  if (step.onFrame && players[0]) {
    step.onFrame(players[0], stage?.platforms || []);
  }

  // Track hit types
  if (step.trackHit && players[0]) {
    const p = players[0];
    if (p.attackBox && p._justHit) {
      if (step.trackHit === 'jab' && p.attackBox.moveId === 'jab') {
        p._tutJabHits = (p._tutJabHits || 0) + 1;
      }
      if (step.trackHit === 'smash' && ['fsmash','usmash','dsmash'].includes(p.attackBox.moveId)) {
        p._tutSmashHit = true;
      }
      if (step.trackHit === 'aerial' && ['nair','fair','bair','uair','dair'].includes(p.attackBox.moveId)) {
        p._tutAerialHit = true;
      }
    }
  }

  // Track reaction
  if (step.id === 'elements' && elementalParticles.length > 0) {
    players[0]._tutReactionTriggered = true;
  }

  // Check task completion
  const taskDone = step.task ? step.task(players[0], players[1]) : false;
  const isInfo = step.task === null;

  // Fade in
  if (ts.msgAlpha < 1) ts.msgAlpha = Math.min(1, ts.msgAlpha + 0.05);

  // ── Tutorial panel (bottom center, above HUD) ─────────────────────────
  const panelW = 560, panelH = 130;
  const panelX = (CANVAS_W - panelW) / 2;
  const panelY = CANVAS_H - panelH - 86; // sits above the HUD

  ctx.save();
  ctx.globalAlpha = ts.msgAlpha * 0.96;

  // Panel bg
  ctx.fillStyle = '#060618';
  ctx.fillRect(panelX, panelY, panelW, panelH);
  drawPixelBorder(panelX, panelY, panelW, panelH, taskDone ? '#44ff88' : '#7744ff');

  // Accent bar top
  ctx.fillStyle = taskDone ? '#44ff88' : '#7744ff';
  ctx.fillRect(panelX, panelY, panelW, 3);

  // Step progress dots
  const dotCount = TUTORIAL_STEPS.length;
  const dotSpacing = Math.min(18, (panelW - 20) / dotCount);
  for (let i = 0; i < dotCount; i++) {
    const dx = panelX + 10 + i * dotSpacing;
    ctx.fillStyle = i < ts.step ? '#44ff88' : i === ts.step ? '#ffffff' : '#333355';
    ctx.fillRect(dx, panelY + 8, 8, 3);
  }

  // Title
  ctx.fillStyle = taskDone ? '#44ff88' : '#aa88ff';
  ctx.font = '8px "Press Start 2P", monospace';
  ctx.textAlign = 'left';
  ctx.fillText(step.title, panelX + 12, panelY + 28);

  // Body text (word wrap manually)
  ctx.fillStyle = '#ccccee';
  ctx.font = '6px "Press Start 2P", monospace';
  const lines = step.body.split('\n');
  let lineY = panelY + 44;
  for (const line of lines) {
    ctx.fillText(line, panelX + 12, lineY);
    lineY += 14;
  }

  // Task status / hint
  if (!isInfo) {
    if (taskDone) {
      ctx.fillStyle = '#44ff88';
      ctx.font = '7px "Press Start 2P", monospace';
      ctx.fillText('✓ DONE! Press NEXT →', panelX + 12, panelY + panelH - 14);
    } else {
      // Blinking hint
      if (Math.floor(ts.stepFrame / 30) % 2 === 0) {
        ctx.fillStyle = '#ffcc44';
        ctx.font = '5px "Press Start 2P", monospace';
        ctx.fillText('▶ ' + step.hint, panelX + 12, panelY + panelH - 14);
      }
    }
  } else {
    ctx.fillStyle = '#aa88ff';
    ctx.font = '6px "Press Start 2P", monospace';
    const btnLabel = ts.step === TUTORIAL_STEPS.length - 1 ? 'FINISH →' : 'NEXT →';
    ctx.fillText(`Press N or click NEXT to continue (${btnLabel})`, panelX + 12, panelY + panelH - 14);
  }

  // NEXT button on canvas (right side of panel)
  const canAdvance = isInfo || taskDone;
  const btnW = 80, btnH = 22;
  const btnX = panelX + panelW - btnW - 10;
  const btnY = panelY + panelH - btnH - 8;
  ctx.fillStyle = canAdvance ? (ts.step === TUTORIAL_STEPS.length-1 ? '#ff4444' : '#4444ff') : '#222233';
  ctx.fillRect(btnX, btnY, btnW, btnH);
  drawPixelBorder(btnX, btnY, btnW, btnH, canAdvance ? '#ffffff' : '#333355');
  ctx.fillStyle = canAdvance ? '#ffffff' : '#555566';
  ctx.font = '6px "Press Start 2P", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(ts.step === TUTORIAL_STEPS.length-1 ? 'FINISH' : 'NEXT', btnX + btnW/2, btnY + 14);
  ctx.textAlign = 'left';

  ctx.globalAlpha = 1;
  ctx.restore();

  // Store button bounds for click detection
  ts._btnBounds = { x: btnX, y: btnY, w: btnW, h: btnH, canAdvance };

  // Keyboard: N key advances
  if (canAdvance && JustPressed['KeyN']) advanceTutorial();
}

// Tutorial click handler
function handleTutorialClick(e) {
  if (!tutorialState || !tutorialState._btnBounds) return;
  const b = tutorialState._btnBounds;
  if (!b.canAdvance) return;
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS_W / rect.width;
  const scaleY = CANVAS_H / rect.height;
  const cx = (e.clientX - rect.left) * scaleX;
  const cy = (e.clientY - rect.top) * scaleY;
  if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
    advanceTutorial();
  }
}

// ─── GAME LOOP ────────────────────────────────────────────────────────────────
function startGame(charIds, stageId, mode) {
  projectiles.length = 0; particles.length = 0; elementalParticles.length = 0;
  comboDisplays.length = 0; frame = 0;
  gameMode = mode || 'local';
  stage = buildStage(stageId || 'VERDANT_THRONE');
  players = [];
  const c1 = CHARACTERS[charIds[0]] || CHARACTER_LIST[0];
  const c2 = CHARACTERS[charIds[1]] || CHARACTER_LIST[1];
  players.push(new Fighter(c1, 180, 300, 0, mode === 'cpu'));
  players.push(new Fighter(c2, 560, 300, 1, mode === 'cpu' || mode === 'vs_cpu'));
  if (mode === 'vs_cpu') players[1].isAI = true;
  state = GameState.GAME;
  // Show mobile controls on touch devices
  const mc = document.getElementById('mobile-controls');
  if (mc) mc.style.display = ('ontouchstart' in window || navigator.maxTouchPoints > 0) ? 'flex' : 'none';
}

function hideMobileControls() {
  const mc = document.getElementById('mobile-controls');
  if (mc) mc.style.display = 'none';
}

function gameLoop() {
  try {
  frame++;
  pollGamepads();
  if (shakeTimer > 0) { shakeTimer--; }

  ctx.save();
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  if (shakeTimer > 0) ctx.translate(Math.random()*4-2, Math.random()*4-2);

  if (stage) drawStage(stage);

  updateParticles();
  drawParticles();
  drawElementalReactions();

  if (state === GameState.GAME) {
    updateProjectiles(players);
    drawProjectiles();

    // Online input sync
    const myInput = gameMode === 'online' ? getInput(0) : null;
    if (socket && myInput && roomId) {
      socket.emit('game_input', { roomId, input: myInput, frame });
    }

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const inp = (gameMode === 'online' && i !== localPlayerIndex) ? p.lastInput || {} : getInput(i);
      p.update(inp, stage.platforms, players[1 - i]);

      // Attack collision (melee)
      if (p.attackBox && !p.attackBox.isProjectile) {
        const opp = players[1 - i];
        if (opp.stocks > 0 && !p.hitThisFrame.includes(opp.playerIndex)) {
          const ab = p.attackBox;
          if (ab.x < opp.x+opp.w && ab.x+ab.w > opp.x && ab.y < opp.y+opp.h && ab.y+ab.h > opp.y) {
            const result = opp.takeDamage(ab.damage, ab.kb, 0.6, ab.kbAngle, p.centerX, ab.element);
            if (result && result !== false) {
              p.hitThisFrame.push(opp.playerIndex);
              p._justHit = true; // used by tutorial tracking
              p.ultimateMeter = Math.min(ULTIMATE_MAX, p.ultimateMeter + ab.damage * 0.3);
              p.combo++; p.comboTimer = 90;
              if (p.combo >= 3) comboDisplays.push({ x: opp.centerX, y: opp.y - 20, combo: p.combo, life: 60 });
              if (ab.element && opp.data.element) triggerReaction(ab.element, opp.data.element, (p.centerX+opp.centerX)/2, (p.centerY+opp.centerY)/2);
              if (result === 'parry') {
                opp.startAttack('jab');
                spawnParticles(opp.centerX, opp.centerY, '#FFFFFF', 20, 6, 30);
              }
            }
          }
        }
      }

      p.draw();

      // Blast zone check
      if (p.checkBlastZone() && p.state !== 'DEAD') {
        p.stocks--;
        spawnParticles(p.centerX, p.centerY, ELEMENTS[p.data.element]?.color || '#FF4400', 30, 8, 50);
        if (p.stocks > 0) { p.state = 'DEAD'; setTimeout(() => p.respawn(), 2000); }
        else { p.state = 'DEAD'; }
      }
    }

    drawHUD();
    if (gameMode === 'tutorial') drawTutorialHUD();

    // Check win condition (skip in tutorial)
    if (gameMode !== 'tutorial') {
      const alivePlayers = players.filter(p => p.stocks > 0);
      const timeUp = frame >= 480 * 60;
      if (alivePlayers.length <= 1 || timeUp) {
        const winner = alivePlayers[0] || players.reduce((a, b) => a.damage < b.damage ? a : b);
        setTimeout(() => showResults(winner), 500);
      }
    } else if (players[0] && players[0].stocks <= 0) {
      // Player died in tutorial — respawn them
      players[0].stocks = 3;
      players[0].damage = 0;
      setTimeout(() => players[0].respawn(), 500);
    }
  }

  ctx.restore();
  } catch(e) { console.error('[GameLoop]', e); }
  clearFrameInput();
  requestAnimationFrame(gameLoop);
}

function showResults(winner) {
  state = GameState.RESULTS;
  hideMobileControls();
  document.getElementById('results-screen').style.display = 'flex';
  document.getElementById('results-winner').textContent = `${winner.data.name} WINS!`;
  document.getElementById('results-winner').style.color = ELEMENTS[winner.data.element]?.color || '#FFFFFF';
  // Award currency via server
  if (token && gameMode === 'vs_cpu') {
    fetch('/api/story/save', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
      body: JSON.stringify({ characterId: winner.data.id, chapter: 0, completed: false }),
    });
  }
}

// ─── STORY MODE ───────────────────────────────────────────────────────────────
function startStory(charId, chapter = 0) {
  const char = CHARACTERS[charId];
  if (!char || !char.story) return;
  storyState = { char, chapter, phase: 'intro', textIndex: 0, text: '', targetText: '', typeTimer: 0 };
  state = GameState.STORY;
  document.getElementById('game-canvas').style.display = 'none';
  document.getElementById('story-screen').style.display = 'flex';
  renderStoryFrame();
}

function renderStoryFrame() {
  if (!storyState) return;
  const { char, chapter, phase } = storyState;
  const story = char.story;
  const screen = document.getElementById('story-screen');

  let title, text, speaker;
  if (phase === 'intro') {
    title = `${char.name}: ${char.title}`;
    text = story.intro;
    speaker = char.name;
  } else if (phase === 'chapter') {
    const ch = story.chapters[chapter];
    title = `Chapter ${chapter + 1}: ${ch.title}`;
    text = ch.text;
    speaker = char.name;
  } else if (phase === 'fight') {
    title = 'BATTLE!';
    text = `Face your opponent and prove your worth.`;
    speaker = 'NARRATOR';
  } else if (phase === 'ending') {
    title = 'Epilogue';
    text = story.ending;
    speaker = char.name;
  }

  document.getElementById('story-title').textContent = title;
  document.getElementById('story-speaker').textContent = speaker;
  document.getElementById('story-text').textContent = text;
  document.getElementById('story-char-name').textContent = char.name;
  document.getElementById('story-char-element').textContent = char.element;
  document.getElementById('story-portrait').style.background = ELEMENTS[char.element]?.color || '#888';
  document.getElementById('story-char-lore').textContent = char.lore.slice(0, 150) + '...';

  const isLast = chapter >= story.chapters.length - 1;
  document.getElementById('story-next-btn').textContent =
    phase === 'ending' ? 'Complete Story' :
    phase === 'fight' ? 'Start Battle' :
    phase === 'chapter' && isLast ? 'Final Battle' : 'Next';
}

function advanceStory() {
  if (!storyState) return;
  const { char, chapter } = storyState;
  const story = char.story;

  if (storyState.phase === 'intro') {
    storyState.phase = 'chapter';
    storyState.chapter = 0;
  } else if (storyState.phase === 'chapter') {
    if (storyState.chapter < story.chapters.length - 1) {
      storyState.chapter++;
    } else {
      storyState.phase = 'fight';
    }
  } else if (storyState.phase === 'fight') {
    // Launch battle vs opponent
    document.getElementById('story-screen').style.display = 'none';
    document.getElementById('game-canvas').style.display = 'block';
    const oppId = story.opponent || 'SHADOW_BEAST';
    startGame([char.id, oppId], 'VOID_RIFT', 'vs_cpu');
    // After game, show ending
    const checkWin = setInterval(() => {
      if (state === GameState.RESULTS) {
        clearInterval(checkWin);
        setTimeout(() => {
          document.getElementById('results-screen').style.display = 'none';
          storyState.phase = 'ending';
          document.getElementById('game-canvas').style.display = 'none';
          document.getElementById('story-screen').style.display = 'flex';
          renderStoryFrame();
        }, 2000);
      }
    }, 500);
    return;
  } else if (storyState.phase === 'ending') {
    // Save progress
    if (token) {
      fetch('/api/story/save', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','Authorization':`Bearer ${token}` },
        body: JSON.stringify({ characterId: char.id, chapter: story.chapters.length, completed: true }),
      });
    }
    document.getElementById('story-screen').style.display = 'none';
    document.getElementById('game-canvas').style.display = 'block';
    state = GameState.MAIN_MENU;
    renderMenu();
    return;
  }
  renderStoryFrame();
}

// ─── MENU SYSTEM ──────────────────────────────────────────────────────────────
function renderMenu() {
  state = GameState.MAIN_MENU;
  document.getElementById('main-menu').style.display = 'flex';
  document.getElementById('game-canvas').style.display = 'none';
  document.getElementById('char-select').style.display = 'none';
  document.getElementById('story-screen').style.display = 'none';
  document.getElementById('results-screen').style.display = 'none';
  document.getElementById('online-screen').style.display = 'none';
  document.getElementById('shop-screen').style.display = 'none';
  document.getElementById('leaderboard-screen').style.display = 'none';
  document.getElementById('admin-panel').style.display = 'none';
  hideMobileControls();
}

function renderSpriteToCanvas(charData, destCanvas, skinColors = null) {
  const SCALE = 3;
  const d = charData;
  const pal = d.palette || [];
  const el = ELEMENTS[d.element]?.color || '#888888';
  const primary = pal[0] || el;
  const secondary = pal[1] || el;
  const COLORS = {
    A: pal[0]  || primary,    B: pal[1]  || secondary,
    C: pal[2]  || '#e8c090',  D: pal[3]  || '#aa7744',
    E: pal[4]  || el,         F: pal[5]  || '#ffffff',
    G: pal[6]  || '#888888',  H: pal[7]  || '#444444',
    J: pal[8]  || el,         K: pal[9]  || '#222222',
    L: pal[10] || '#cccccc',  M: pal[11] || '#cc3300',
    N: pal[12] || '#dddddd',  O: pal[13] || '#555555',
    P: pal[14] || '#333333',  I: '#000000',
  };

  const sprite = d.sprite?.idle;
  if (!sprite || sprite.length === 0) return;

  const rows = sprite;
  const cols = Math.max(...rows.map(r => r.length));
  // Size canvas to fit sprite at SCALE, then letterbox into destCanvas
  const sprW = cols * SCALE, sprH = rows.length * SCALE;
  const dW = destCanvas.width, dH = destCanvas.height;
  const fit = Math.min(dW / sprW, dH / sprH) * 0.9;
  const drawW = sprW * fit, drawH = sprH * fit;
  const pxSize = Math.max(1, Math.round(SCALE * fit));
  const startX = Math.round((dW - drawW) / 2);
  const startY = Math.round((dH - drawH) / 2);

  // Skin color override (shop preview)
  if (skinColors?.primary) {
    COLORS.A = skinColors.primary;
    COLORS.B = skinColors.secondary || skinColors.primary;
    COLORS.E = skinColors.primary;
    COLORS.J = skinColors.secondary || skinColors.primary;
  }
  // Developer portrait palette override (takes priority over skin in portraits)
  if (!skinColors && (currentUser?.role === 'developer' || currentUser?.username === 'AMGProdZ')) {
    COLORS.A = '#cc1100'; COLORS.B = '#ffaa00'; COLORS.C = '#ffd060';
    COLORS.D = '#cc7700'; COLORS.E = '#ff3300'; COLORS.F = '#ffe080';
    COLORS.J = '#ff6600'; COLORS.L = '#ffdd88'; COLORS.N = '#ffcc44';
  }

  const c = destCanvas.getContext('2d');
  c.clearRect(0, 0, dW, dH);

  // BG gradient — gold tint for dev
  const devPortrait = currentUser?.role === 'developer' || currentUser?.username === 'AMGProdZ';
  c.fillStyle = devPortrait ? '#ff220018' : `${el}18`;
  c.fillRect(0, 0, dW, dH);

  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < rows[row].length; col++) {
      const ch = rows[row][col];
      if (ch === '.' || ch === ' ') continue;
      const color = COLORS[ch];
      if (!color) continue;
      c.fillStyle = color;
      c.fillRect(
        startX + Math.round(col * drawW / cols),
        startY + Math.round(row * drawH / rows.length),
        pxSize, pxSize
      );
    }
  }
}

function renderCharSelect(mode) {
  state = GameState.CHARACTER_SELECT;
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('char-select').style.display = 'flex';
  document.getElementById('cs-mode-label').textContent = mode.toUpperCase().replace('_',' ');
  const grid = document.getElementById('char-grid');
  grid.innerHTML = '';
  for (const char of CHARACTER_LIST) {
    const locked = char.unlockCondition !== 'default';
    const elColor = ELEMENTS[char.element]?.color || '#888';
    const isDev = !locked && (currentUser?.role === 'developer' || currentUser?.username === 'AMGProdZ');
    const card = document.createElement('div');
    card.className = 'char-card' + (locked ? ' locked' : '') + (isDev ? ' dev-char' : '');
    card.style.setProperty('--el-color', isDev ? '#ffaa00' : elColor);

    const portraitDiv = document.createElement('div');
    portraitDiv.className = 'char-portrait';
    portraitDiv.style.background = isDev ? '#ff220018' : elColor + '18';

    if (locked) {
      portraitDiv.innerHTML = `<div class="char-lock-icon">?</div>`;
    } else {
      const cvs = document.createElement('canvas');
      cvs.className = 'char-portrait-canvas';
      cvs.width = 100; cvs.height = 110;
      portraitDiv.appendChild(cvs);
      // Render after append so it's in DOM
      requestAnimationFrame(() => renderSpriteToCanvas(char, cvs));
    }

    const badge = document.createElement('div');
    badge.className = 'char-element-badge';
    badge.textContent = char.element;
    portraitDiv.appendChild(badge);

    // Developer crown badge on portrait
    if (!locked && (currentUser?.role === 'developer' || currentUser?.username === 'AMGProdZ')) {
      const devBadge = document.createElement('div');
      devBadge.className = 'char-dev-badge';
      devBadge.textContent = '♛ DEV';
      portraitDiv.appendChild(devBadge);
    }

    const info = document.createElement('div');
    info.className = 'char-info';
    const loreSnippet = char.lore ? char.lore.trim().split('\n')[0].trim() : '';
    info.innerHTML = `
      <div class="char-name">${locked ? '???' : char.name}</div>
      <div class="char-title">${locked ? 'LOCKED' : char.title}</div>
      ${!locked && loreSnippet ? `<div class="char-lore-snippet">${loreSnippet}</div>` : ''}`;
    if (!locked && char.lore) {
      const tooltip = document.createElement('div');
      tooltip.className = 'char-lore-tooltip';
      tooltip.textContent = char.lore.trim();
      card.appendChild(tooltip);
    }

    card.appendChild(portraitDiv);
    card.appendChild(info);
    if (!locked) card.addEventListener('click', (e) => selectChar(char.id, mode, e.currentTarget));
    grid.appendChild(card);
  }
}

let p1Select = null;
function selectChar(charId, mode, cardEl) {
  if (!p1Select) {
    p1Select = charId;
    document.querySelectorAll('.char-card').forEach(c => c.classList.remove('selected'));
    if (cardEl) cardEl.classList.add('selected');
    document.getElementById('cs-hint').textContent = mode === 'story' ? 'Story starting...' : 'Select P2 character (or same for mirror)';
    if (mode === 'story') {
      p1Select = null;
      document.getElementById('char-select').style.display = 'none';
      document.getElementById('game-canvas').style.display = 'none';
      startStory(charId);
    }
  } else {
    const p2 = charId;
    const p1 = p1Select;
    p1Select = null;
    document.getElementById('char-select').style.display = 'none';
    document.getElementById('game-canvas').style.display = 'block';
    startGame([p1, p2], 'VERDANT_THRONE', mode);
  }
}

// ─── ONLINE SCREEN ────────────────────────────────────────────────────────────
async function loadOnlineScreen() {
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('online-screen').style.display = 'flex';
  if (!socket) initSocket(); // only connect when user actually opens online mode
  if (!token) {
    document.getElementById('online-auth-section').style.display = 'flex';
    document.getElementById('online-lobby-section').style.display = 'none';
    return;
  }
  document.getElementById('online-auth-section').style.display = 'none';
  document.getElementById('online-lobby-section').style.display = 'flex';
  await loadFriendsList();
  await loadAnnouncements();
}

async function loadFriendsList() {
  if (!token) return;
  let data;
  try { const res = await fetch('/api/friends', { headers: { Authorization: `Bearer ${token}` } }); data = await res.json(); } catch(e) { return; }
  const list = document.getElementById('friends-list');
  list.innerHTML = '';
  for (const f of data.friends) {
    const li = document.createElement('div');
    li.className = 'friend-item';
    li.innerHTML = `<span class="friend-name">${f.username}</span>${f.custom_title ? `<span class="friend-title">[${f.custom_title}]</span>` : ''}<button onclick="inviteFriend(${f.id})">Invite</button>`;
    list.appendChild(li);
  }
  for (const r of data.pending) {
    const li = document.createElement('div');
    li.className = 'friend-item pending';
    li.innerHTML = `<span>${r.username} wants to be friends</span><button onclick="acceptFriend(${r.id})">Accept</button>`;
    list.appendChild(li);
  }
}

async function loadAnnouncements() {
  let data;
  try { const res = await fetch('/api/announcements'); data = await res.json(); } catch(e) { return; }
  const el = document.getElementById('announcements-list');
  el.innerHTML = '';
  if (data.motd) {
    const motd = document.createElement('div');
    motd.className = 'motd';
    motd.textContent = '📢 ' + data.motd.message;
    el.appendChild(motd);
  }
  for (const a of data.announcements) {
    const item = document.createElement('div');
    item.className = 'announcement-item' + (a.is_pinned ? ' pinned' : '');
    item.innerHTML = `<strong>${a.title}</strong><p>${a.content}</p>`;
    el.appendChild(item);
  }
}

// ─── SHOP ─────────────────────────────────────────────────────────────────────
async function loadShop() {
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('shop-screen').style.display = 'flex';
  if (!token) { document.getElementById('shop-login-msg').style.display = 'block'; return; }
  const res = await fetch('/api/cosmetics', { headers: { Authorization: `Bearer ${token}` } });
  const cosmetics = await res.json();
  const grid = document.getElementById('shop-grid');
  grid.innerHTML = '';
  for (const c of cosmetics) {
    if (c.is_special && (!currentUser || currentUser.role !== 'developer')) continue;
    const item = document.createElement('div');
    item.className = `shop-item rarity-${c.rarity} ${c.owned ? 'owned' : ''}`;
    const charData = CHARACTERS[c.character_id];
    const elColor = ELEMENTS[charData?.element]?.color || '#8866ff';
    item.innerHTML = `
      <div class="shop-item-preview" style="--el:${elColor}">
        <canvas class="shop-item-canvas" width="80" height="80" data-char="${c.character_id}" data-type="${c.type}" data-color='${c.color_data || "{}"}'></canvas>
        <div class="shop-item-type-badge">${c.type.toUpperCase()}</div>
      </div>
      <div class="shop-item-name">${c.name}</div>
      <div class="shop-item-char">${c.character_id === 'ALL' ? 'All Characters' : (charData?.name || c.character_id)}</div>
      ${c.description ? `<div class="shop-item-desc">${c.description}</div>` : ''}
      <div class="shop-item-price">${c.owned ? '✓ OWNED' : `${c.price} ◆`}</div>
      ${c.owned ? `<button onclick="equipCosmetic(${c.id})">EQUIP</button>` : `<button onclick="buyCosmetic(${c.id})">BUY</button>`}`;
    grid.appendChild(item);
  }
  // Render sprite previews on each shop canvas
  requestAnimationFrame(() => {
    document.querySelectorAll('.shop-item-canvas').forEach(cvs => {
      const charId = cvs.dataset.char;
      const type   = cvs.dataset.type;
      const char   = CHARACTERS[charId];
      const elColor = ELEMENTS[char?.element]?.color || '#8866ff';
      let skinColors = null;
      try { skinColors = JSON.parse(cvs.dataset.color || '{}'); } catch(e) {}
      const c = cvs.getContext('2d');
      c.clearRect(0, 0, 80, 80);
      c.fillStyle = (skinColors?.primary || elColor) + '22';
      c.fillRect(0, 0, 80, 80);
      if (char && type === 'skin' && skinColors?.primary) {
        renderSpriteToCanvas(char, cvs, skinColors);
      } else if (char) {
        renderSpriteToCanvas(char, cvs);
      } else {
        drawCosmeticIcon(c, type, skinColors?.primary || elColor, 80, 80);
      }
    });
  });

  const user = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  const me = await user.json();
  document.getElementById('shop-currency').textContent = `${me.currency} ◆ SHARDS`;
}

function drawCosmeticIcon(c, type, color, w, h) {
  const S = 3; // pixel size
  c.clearRect(0, 0, w, h);

  // BG gradient feel
  c.fillStyle = color + '18';
  c.fillRect(0, 0, w, h);

  const px = (x, y, col, sz = S) => { c.fillStyle = col; c.fillRect(x, y, sz, sz); };

  if (type === 'skin') {
    // Mini character silhouette — head, body, arms, legs in two-tone
    const x0 = w/2 - 10, y0 = 10;
    const dark = color, light = '#ffffff';
    // head
    for (let row = 0; row < 4; row++) {
      const mask = [0b00111100,0b01111110,0b01111110,0b00111100][row];
      for (let col = 0; col < 8; col++) {
        if (mask & (1 << (7 - col))) px(x0 + col*S, y0 + row*S, row===0||col===0||col===7 ? dark : light);
      }
    }
    // body
    for (let row = 0; row < 5; row++) {
      const mask = [0b01111110,0b11111111,0b11111111,0b01111110,0b01111110][row];
      for (let col = 0; col < 8; col++) {
        if (mask & (1 << (7 - col))) px(x0 + col*S, y0 + 14 + row*S, row<2 ? color : dark);
      }
    }
    // legs
    [[2,3],[4,5]].forEach(([a,b]) => {
      for (let row = 0; row < 4; row++) px(x0 + a*S, y0 + 30 + row*S, color);
      for (let row = 0; row < 4; row++) px(x0 + b*S, y0 + 30 + row*S, dark);
    });

  } else if (type === 'trail') {
    // Sparkle trail — diagonal dotted path with star bursts
    const trail = [[12,60],[20,50],[30,40],[42,28],[56,16]];
    trail.forEach(([tx,ty], i) => {
      const alpha = 0.4 + i * 0.15;
      c.globalAlpha = alpha;
      px(tx,   ty,   color, S*2);
      px(tx-S, ty-S, '#ffffff', S);
      px(tx+S, ty+S, color, S);
    });
    c.globalAlpha = 1;
    // Star burst at tip
    const [sx, sy] = [56, 16];
    [[0,-8],[0,4],[-7,-2],[5,-2],[-5,-6],[4,-6]].forEach(([dx,dy]) => px(sx+dx, sy+dy, '#ffffff', S));
    px(sx-S, sy-S, color, S*3);

  } else if (type === 'hiteffect') {
    // Pixel explosion starburst — 8 rays + center flash
    const cx2 = w/2, cy2 = h/2;
    const rays = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
    const rayColors = [color, '#ffffff', color, '#ffdd44', color, '#ffffff', color, '#ffdd44'];
    rays.forEach(([dx,dy], i) => {
      for (let d = 1; d <= 5; d++) {
        const alpha = 1 - d * 0.15;
        c.globalAlpha = alpha;
        px(cx2 + dx*d*S*1.8, cy2 + dy*d*S*1.8, d===1 ? '#ffffff' : rayColors[i], d < 2 ? S*2 : S);
      }
    });
    c.globalAlpha = 1;
    // center flash
    px(cx2-S, cy2-S, '#ffffff', S*3);
    px(cx2-S+1, cy2-S+1, color, S*2);

  } else if (type === 'aura') {
    // Concentric pixel rings
    const rings = [
      { r: 28, col: color + 'cc', thick: 3 },
      { r: 20, col: '#ffffff66', thick: 2 },
      { r: 12, col: color,        thick: 3 },
    ];
    const cx2 = w/2, cy2 = h/2;
    rings.forEach(({ r, col, thick }) => {
      for (let a = 0; a < 360; a += 8) {
        const rad = a * Math.PI / 180;
        const rx = Math.round(cx2 + Math.cos(rad) * r);
        const ry = Math.round(cy2 + Math.sin(rad) * r);
        c.fillStyle = col;
        c.fillRect(rx, ry, thick, thick);
      }
    });
    // Center glow dot
    px(cx2-S, cy2-S, '#ffffff', S*3);
    c.globalAlpha = 0.5;
    px(cx2-S*2, cy2-S*2, color, S*5);
    c.globalAlpha = 1;

  } else {
    // Default diamond
    const cx2 = w/2, cy2 = h/2;
    [[0,-4],[3,-1],[0,3],[-3,-1]].forEach(([dx,dy]) => px(cx2+dx*S, cy2+dy*S, color, S*2));
    px(cx2-S, cy2-S, '#ffffff', S*3);
  }
}

async function buyCosmetic(id) {
  const res = await fetch('/api/cosmetics/buy', {
    method: 'POST',
    headers: { 'Content-Type':'application/json','Authorization':`Bearer ${token}` },
    body: JSON.stringify({ cosmeticId: id }),
  });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  document.getElementById('shop-currency').textContent = `Rift Shards: ${data.currency}`;
  loadShop();
}

async function equipCosmetic(id) {
  await fetch('/api/cosmetics/equip', {
    method: 'POST',
    headers: { 'Content-Type':'application/json','Authorization':`Bearer ${token}` },
    body: JSON.stringify({ cosmeticId: id }),
  });
  loadShop();
}

// ─── ADMIN PANEL ─────────────────────────────────────────────────────────────
async function adminExec(command, params = {}) {
  const res = await fetch('/api/admin/command', {
    method: 'POST',
    headers: { 'Content-Type':'application/json','Authorization':`Bearer ${token}` },
    body: JSON.stringify({ command, params }),
  });
  return res.json();
}

async function loadAdminPanel() {
  if (!currentUser || !['admin','moderator','developer'].includes(currentUser.role)) {
    alert('Access denied'); return;
  }
  // Hide all screens
  ['main-menu','char-select','online-screen','shop-screen','leaderboard-screen'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  document.getElementById('admin-panel').style.display = 'flex';

  // Role badge + username
  document.getElementById('admin-role-badge').textContent = (currentUser.role || 'ADMIN').toUpperCase();
  const udisp = document.getElementById('admin-username-display');
  if (udisp) udisp.textContent = currentUser.username;

  // Load commands list
  const res = await fetch('/api/admin/commands', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const cmdList = document.getElementById('admin-cmd-list');
  cmdList.innerHTML = '';
  for (const cmd of (data.commands || [])) {
    const btn = document.createElement('button');
    btn.className = 'admin-cmd-btn'; btn.textContent = cmd;
    btn.addEventListener('click', () => openAdminCommand(cmd));
    cmdList.appendChild(btn);
  }
  const countEl = document.getElementById('admin-cmd-count');
  if (countEl) countEl.textContent = `${data.total || 0} commands`;

  // Fun developer quick-actions panel
  if (currentUser.role === 'developer') {
    const devTabBtn = document.getElementById('admin-tab-devfun-btn');
    if (devTabBtn) devTabBtn.style.display = '';
    const devPanel = document.getElementById('admin-dev-fun');
    if (devPanel) {
      const FUN_CMDS = [
        { cmd: 'chaos_mode',           label: '⚡ CHAOS MODE ON',      params: { enabled: true },  desc: 'Scramble all character stats ±30%' },
        { cmd: 'chaos_mode',           label: '✅ CHAOS MODE OFF',     params: { enabled: false }, desc: 'Restore all stats to normal' },
        { cmd: 'give_everyone_currency',label: '💎 RAIN SHARDS (500)', params: { amount: 500 },    desc: 'Give every player 500 shards' },
        { cmd: 'give_everyone_currency',label: '💎 RAIN SHARDS (5K)',  params: { amount: 5000 },   desc: 'Give every player 5000 shards' },
        { cmd: 'summon_rift_event',    label: '☄️ METEOR SHOWER',      params: { type: 'meteor' }, desc: 'Trigger meteor event for all players' },
        { cmd: 'summon_rift_event',    label: '✨ GOLDEN HOUR',        params: { type: 'golden' }, desc: '3x currency for 10 minutes' },
        { cmd: 'summon_rift_event',    label: '💨 SPEED RUSH',         params: { type: 'speed' },  desc: 'Everyone moves 2x faster' },
        { cmd: 'summon_rift_event',    label: '🌑 BLACKOUT',           params: { type: 'blackout'},desc: 'Lights out event' },
        { cmd: 'flip_gravity',         label: '🙃 FLIP GRAVITY',       params: {},                 desc: 'Toggle upside-down gravity' },
        { cmd: 'unlock_all_for_everyone',label:'🎁 UNLOCK ALL SKINS',  params: {},                 desc: 'Give every player all cosmetics' },
        { cmd: 'wipe_all_bans',        label: '🕊️ WIPE ALL BANS',     params: {},                 desc: 'Unban every banned player' },
        { cmd: 'spawn_coins_rain',     label: '🌧️ COIN RAIN (10K)',    params: { amount: 10000 },  desc: 'Split 10,000 shards among all players' },
        { cmd: 'server_status_full',   label: '📊 FULL STATUS',        params: {},                 desc: 'Deep server diagnostics' },
        { cmd: 'godmode_self',         label: '👑 GODMODE (ME)',        params: {},                 desc: 'Make yourself invincible' },
        { cmd: 'set_all_titles',       label: '🏆 TITLE: RIFT LEGEND', params: { title: 'RIFT LEGEND' }, desc: 'Give everyone the Rift Legend title' },
        { cmd: 'reset_all_rankings',   label: '🔄 RESET RANKINGS',     params: {},                 desc: 'Wipe all ELO and season stats' },
      ];
      devPanel.innerHTML = '';
      for (const fc of FUN_CMDS) {
        const btn = document.createElement('button');
        btn.className = 'dev-fun-btn';
        btn.innerHTML = `<span class="dev-fun-label">${fc.label}</span><span class="dev-fun-desc">${fc.desc}</span>`;
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.style.opacity = '0.5';
          const result = await adminExec(fc.cmd, fc.params);
          btn.disabled = false;
          btn.style.opacity = '1';
          document.getElementById('admin-cmd-result').textContent = JSON.stringify(result, null, 2);
          switchAdminTab('commands');
        });
        devPanel.appendChild(btn);
      }
    }
  }

  // Load overview stats
  await refreshAdminOverview();
  switchAdminTab('overview');
}

async function refreshAdminOverview() {
  const stats = await adminExec('view_server_stats');
  const cards = document.getElementById('admin-stat-cards');
  if (!cards) return;
  const defs = [
    { label:'TOTAL USERS',     value: stats.users?.total     || 0, color:'var(--accent2)' },
    { label:'BANNED',          value: stats.users?.banned    || 0, color:'var(--red)'     },
    { label:'TOTAL MATCHES',   value: stats.matches?.total   || 0, color:'var(--cyan)'    },
    { label:'RANKED MATCHES',  value: stats.matches?.ranked  || 0, color:'var(--gold)'    },
    { label:'COSMETICS',       value: stats.cosmetics?.total || 0, color:'var(--green)'   },
    { label:'PENDING REPORTS', value: stats.reports?.pending || 0, color:'var(--red)'     },
  ];
  cards.innerHTML = defs.map(d => `
    <div class="admin-stat-card">
      <div class="asc-value" style="color:${d.color}">${d.value}</div>
      <div class="asc-label">${d.label}</div>
    </div>`).join('');
  const log = document.getElementById('admin-result');
  if (log) log.textContent = JSON.stringify(stats, null, 2);
}

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-nav-btn').forEach(b => b.classList.remove('active'));
  const tabEl = document.getElementById(`admin-tab-${tab}`);
  if (tabEl) tabEl.classList.add('active');
  const navBtn = document.querySelector(`.admin-nav-btn[data-tab="${tab}"]`);
  if (navBtn) navBtn.classList.add('active');
}

function openAdminCommand(cmd) {
  switchAdminTab('commands');
  document.getElementById('admin-selected-cmd').textContent = cmd;
  document.getElementById('admin-params').value = '{}';
  document.getElementById('admin-execute-section').style.display = 'flex';
  document.getElementById('admin-cmd-result').textContent = '';
}

async function executeAdminCommand() {
  const cmd = document.getElementById('admin-selected-cmd').textContent;
  let params;
  try { params = JSON.parse(document.getElementById('admin-params').value || '{}'); }
  catch { alert('Invalid JSON params'); return; }
  const result = await adminExec(cmd, params);
  document.getElementById('admin-cmd-result').textContent = JSON.stringify(result, null, 2);
}

async function adminUserLookup() {
  const username = document.getElementById('admin-user-search').value.trim();
  if (!username) return;
  const result = await adminExec('view_user', { username });
  const el = document.getElementById('admin-user-result');
  if (result.error) { el.textContent = result.error; el.className = 'admin-result-box error'; return; }
  el.className = 'admin-result-box';
  el.innerHTML = `
    <div class="admin-user-row"><span>Username</span><strong>${result.username || '—'}</strong></div>
    <div class="admin-user-row"><span>Role</span><strong style="color:var(--gold)">${result.role || '—'}</strong></div>
    <div class="admin-user-row"><span>Currency</span><strong>${result.currency ?? '—'} shards</strong></div>
    <div class="admin-user-row"><span>ELO</span><strong>${result.elo ?? '—'}</strong></div>
    <div class="admin-user-row"><span>Banned</span><strong style="color:${result.banned ? 'var(--red)' : 'var(--green)'}">${result.banned ? 'YES' : 'NO'}</strong></div>
    <div class="admin-user-row"><span>Created</span><strong>${result.created_at ? new Date(result.created_at).toLocaleDateString() : '—'}</strong></div>`;
}

async function adminBanUser() {
  const username = document.getElementById('admin-mod-target').value.trim();
  const reason   = document.getElementById('admin-mod-reason').value;
  const duration = parseInt(document.getElementById('admin-mod-duration').value) || 0;
  if (!username) return;
  const result = await adminExec('ban_user', { username, reason, duration_days: duration });
  const el = document.getElementById('admin-mod-output');
  el.textContent = JSON.stringify(result, null, 2);
  el.style.display = 'block';
}

async function adminGrantCurrency() {
  const username = document.getElementById('admin-econ-user').value.trim();
  const amount   = parseInt(document.getElementById('admin-econ-amount').value) || 0;
  if (!username || !amount) return;
  const result = await adminExec('grant_currency', { username, amount });
  const el = document.getElementById('admin-econ-output');
  el.textContent = JSON.stringify(result, null, 2);
  el.style.display = 'block';
}

async function adminBroadcast() {
  const message = document.getElementById('admin-broadcast-msg').value.trim();
  if (!message) return;
  const result = await adminExec('broadcast', { message });
  const el = document.getElementById('admin-broadcast-output');
  el.textContent = JSON.stringify(result, null, 2);
  el.style.display = 'block';
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function showAuthError(formId, msg) {
  const el = document.getElementById(formId);
  if (!el) return;
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function onLoginSuccess(data) {
  token = data.token; currentUser = data.user;
  localStorage.setItem('rift_token', token);
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('auth-section').style.display = 'none';
  document.getElementById('user-info').style.display = 'flex';
  const roleColors = { admin:'#ff4444', developer:'#ff8800', moderator:'#ffcc00' };
  const rColor = roleColors[currentUser.role] || 'var(--accent2)';
  document.getElementById('user-avatar-badge').textContent = (currentUser.username[0] || '?').toUpperCase();
  document.getElementById('user-avatar-badge').style.borderColor = rColor;
  document.getElementById('user-display').textContent = currentUser.username + (currentUser.custom_title ? ` [${currentUser.custom_title}]` : '');
  document.getElementById('user-currency').textContent = `${currentUser.currency || 0} ◆ SHARDS`;
  if (['admin','developer','moderator'].includes(currentUser.role)) {
    document.getElementById('admin-btn').style.display = 'block';
  }
  // Only show menu on fresh auto-login — never override an active screen
  if (state === GameState.MAIN_MENU) renderMenu();
}

async function login(username, password) {
  let data;
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ username, password }),
    });
    data = await res.json();
  } catch(e) { showAuthError('auth-login-error', 'Server unreachable. Try again.'); return; }
  if (data.error) { showAuthError('auth-login-error', data.error); return; }
  onLoginSuccess(data);
}

async function register(username, password, email) {
  let data;
  try {
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ username, password, email }),
    });
    data = await res.json();
  } catch(e) { showAuthError('auth-reg-error', 'Server unreachable. Try again.'); return; }
  if (data.error) { showAuthError('auth-reg-error', data.error); return; }
  onLoginSuccess(data);
}

function playAsGuest() {
  document.getElementById('auth-screen').style.display = 'none';
  renderMenu();
}

// ─── SOCKET INIT ──────────────────────────────────────────────────────────────
function initSocket() {
  if (!token || socket) return;
  // Verify socket.io is reachable before injecting the script
  fetch('/socket.io/socket.io.js', { method: 'HEAD' }).then(r => {
    if (!r.ok) { console.warn('[Socket] socket.io unavailable'); return; }
    const script = document.createElement('script');
    script.src = '/socket.io/socket.io.js';
    script.onerror = () => console.warn('[Socket] socket.io load failed');
    script.onload = () => {
    socket = window.io({ auth: { token } });
    socket.on('match_found', (data) => {
      roomId = data.roomId;
      localPlayerIndex = data.playerIndex;
      document.getElementById('online-screen').style.display = 'none';
      document.getElementById('game-canvas').style.display = 'block';
      startGame([currentUser.selectedChar || 'NEON_RYU', 'NEON_RYU'], 'VERDANT_THRONE', 'online');
    });
    socket.on('opponent_input', (data) => {
      if (players[1 - localPlayerIndex]) players[1 - localPlayerIndex].lastInput = data.input;
    });
    socket.on('match_complete', (data) => {
      document.getElementById('match-result-banner').textContent =
        data.result === 'win' ? `WIN! +${data.eloChange} ELO, +${data.currencyEarned} Shards` : `LOSS. ${data.eloChange} ELO, +${data.currencyEarned} Shards`;
      document.getElementById('match-result-banner').style.display = 'block';
      document.getElementById('user-currency').textContent = `${(currentUser.currency || 0) + data.currencyEarned} Shards`;
    });
    socket.on('broadcast', (data) => {
      const banner = document.getElementById('server-broadcast');
      banner.textContent = `[SERVER] ${data.message}`;
      banner.style.display = 'block';
      setTimeout(() => banner.style.display = 'none', 8000);
    });
    socket.on('friend_request', (data) => {
      const notif = document.getElementById('friend-notif');
      notif.textContent = `${data.from} sent you a friend request!`;
      notif.style.display = 'block';
      setTimeout(() => notif.style.display = 'none', 5000);
    });
    socket.on('banned', (data) => { alert(`You have been banned: ${data.reason}`); localStorage.removeItem('rift_token'); location.reload(); });
    socket.on('warning', (data) => { alert(`Warning from admin: ${data.message}`); });
    socket.on('world_event', (data) => {
      document.getElementById('event-banner').textContent = `EVENT: ${data.eventType}`;
      document.getElementById('event-banner').style.display = 'block';
      if (data.duration) setTimeout(() => document.getElementById('event-banner').style.display = 'none', data.duration);
    });
    socket.on('flag_update', (flags) => { Object.assign(globalFlags, flags); });
    socket.on('balance_update', ({ characterId, statKey, value }) => {
      if (!balanceOverrides[characterId]) balanceOverrides[characterId] = {};
      balanceOverrides[characterId][statKey] = value;
    });
    };
    document.head.appendChild(script);
  }).catch(() => console.warn('[Socket] socket.io preflight failed'));
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
async function loadLeaderboard() {
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('leaderboard-screen').style.display = 'flex';
  const res = await fetch('/api/leaderboard');
  const data = await res.json();
  const list = document.getElementById('lb-list');
  list.innerHTML = '<div class="lb-header"><span>#</span><span>Player</span><span>ELO</span><span>W/L</span></div>';
  data.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (i < 3 ? ` lb-top${i+1}` : '');
    row.innerHTML = `<span>${i+1}</span><span>${entry.username}${entry.custom_title?` [${entry.custom_title}]`:''}</span><span>${entry.elo}</span><span>${entry.wins}/${entry.losses}</span>`;
    list.appendChild(row);
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
export function init() {
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;

  // Try auto-login
  const savedToken = localStorage.getItem('rift_token');
  if (savedToken) {
    token = savedToken;
    fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || data.error) { localStorage.removeItem('rift_token'); token = null; return; }
        onLoginSuccess({ token, user: data });
        if (data.cosmetics) {
          for (const cos of data.cosmetics) {
            if (cos.equipped) equippedCosmetics[cos.character_id] = cos;
          }
        }
      })
      .catch(() => { localStorage.removeItem('rift_token'); token = null; });
  }

  // Expose functions to window for HTML event handlers
  window.gameAPI = {
    login, register, playAsGuest, renderMenu, renderCharSelect, startGame, startStory, advanceStory, startTutorial,
    loadOnlineScreen, loadShop, loadLeaderboard, loadAdminPanel,
    buyCosmetic, equipCosmetic, executeAdminCommand, openAdminCommand,
    switchAdminTab, adminUserLookup, adminBanUser, adminGrantCurrency, adminBroadcast,
    joinMatchmaking: (charId) => {
      currentUser.selectedChar = charId;
      if (socket) socket.emit('join_matchmaking', { character: charId, ranked: true });
    },
    createParty: async (mode) => {
      const res = await fetch('/api/party/create', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','Authorization':`Bearer ${token}` },
        body: JSON.stringify({ gameMode: mode }),
      });
      const data = await res.json();
      document.getElementById('party-code-display').textContent = `Party Code: ${data.code}`;
      if (socket) socket.emit('join_party', data.partyId);
    },
    joinParty: async (code) => {
      const res = await fetch('/api/party/join', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','Authorization':`Bearer ${token}` },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (data.error) { alert(data.error); return; }
      if (socket) socket.emit('join_party', data.partyId);
      document.getElementById('party-status').textContent = 'Joined party!';
    },
    addFriend: async (username) => {
      const res = await fetch('/api/friends/request', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','Authorization':`Bearer ${token}` },
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      alert(data.error || 'Friend request sent!');
    },
    acceptFriend: async (friendId) => {
      await fetch('/api/friends/accept', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','Authorization':`Bearer ${token}` },
        body: JSON.stringify({ friendId }),
      });
      loadFriendsList();
    },
    report: async (username, reason) => {
      await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','Authorization':`Bearer ${token}` },
        body: JSON.stringify({ reportedUsername: username, reason, description: '' }),
      });
      alert('Report submitted.');
    },
  };
  window.acceptFriend = (id) => window.gameAPI.acceptFriend(id);
  window.inviteFriend = (id) => alert('Party invite sent! (requires party to be created first)');
  window.buyCosmetic = buyCosmetic;
  window.equipCosmetic = equipCosmetic;

  canvas.addEventListener('click', handleTutorialClick);

  requestAnimationFrame(gameLoop);
}
