'use strict';
/*
 * Discord status ("Playing Hostwerk"): shows in Discord that Hostwerk is running and which kinds of services are active.
 * Talks directly to the local Discord client over its IPC pipe – no extra package, no internet.
 * If Discord is not running (or starts later), it quietly retries every 20 seconds.
 *
 * Privacy: only kinds of services and counts are shared (e.g. "Web servers · Databases · Minecraft"),
 * never project, server or path names. With "show services" off only "Hostwerk" with the uptime appears.
 */
const net = require('net');
const path = require('path');

// Discord application "Hostwerk" (name and logo shown by Discord). Can be overridden in the settings.
const DEFAULT_CLIENT_ID = process.env.HW_DISCORD_CLIENT_ID || '1560000407449632918';
const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function pipePaths() {
  if (process.env.HW_DISCORD_PIPE) return [process.env.HW_DISCORD_PIPE]; // tests: own fake pipe
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const bases = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp'].filter(Boolean);
  const dirs = [];
  // Regular Discord plus the Flatpak and Snap variants
  for (const b of bases) dirs.push(b, path.join(b, 'app/com.discordapp.Discord'), path.join(b, 'snap.discord'), path.join(b, '.flatpak/com.discordapp.Discord/xdg-run'));
  const out = [];
  for (const d of [...new Set(dirs)]) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
  return out;
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

// Grouped by kind of service – this order is the display order
const KINDS = [['web', 'Web servers'], ['db', 'Databases'], ['mail', 'Mail'], ['app', 'Apps'], ['mc', 'Minecraft'], ['ai', 'AI helper']];

/*
 * Images per kind of service (switch "One image per kind"): Discord shows images that are uploaded to the Discord
 * application under exactly these names (Developer Portal → Rich Presence → Art Assets) –
 * otherwise Discord shows no picture. That is why the switch is off by default.
 */
const KIND_IMAGES = { web: 'kind-web', db: 'kind-db', mail: 'kind-mail', app: 'kind-app', mc: 'kind-mc', ai: 'kind-ai' };

// Buttons under the status: Discord allows two, label up to 32 characters, only web addresses
const BUTTON_LABEL_MAX = 32;
const isWebUrl = (u) => { try { const x = new URL(String(u)); return (x.protocol === 'https:' || x.protocol === 'http:') && !!x.hostname; } catch { return false; } };

/** Clean up a button from the settings (or null if it is not usable). */
function cleanButton(b) {
  if (!b || typeof b !== 'object') return null;
  const label = String(b.label || '').trim().slice(0, BUTTON_LABEL_MAX);
  const url = String(b.url || '').trim();
  return label && isWebUrl(url) && url.length <= 512 ? { label, url } : null;
}

/**
 * deps: { settings, registry (running processes), bus (Hostwerk events), webIds(), dbIds(), version(), t(text, vars), desktop,
 *         mcInfo(id) → { name, maxPlayers } (optional), statusLink() → public status page or null (optional),
 *         notify(status) (optional: tells the interface that something changed) }
 * Kept free of Hostwerk internals so the tests can drive it with plain objects.
 */
class DiscordPresence {
  constructor(deps) {
    this.d = deps;
    this.sock = null;
    this.ready = false;
    this.connecting = false;
    this.startedAt = Date.now();
    this.lastSent = '';
    this.lastError = null;
    this.user = null;
    this.timer = null;
    this.retry = null;
    this.nonce = 0;
    this.closed = false;
    this.onBus = (m) => { if (m.type === 'status' || m.type === 'settings') this.schedule(); };
  }

  /** Stored where it always was (settings.general.discord) – nothing is lost when moving out of the core. */
  raw() { const g = this.d.settings.get().general || {}; return g.discord || {}; }
  cfg() {
    const d = this.raw();
    return {
      enabled: d.enabled !== false,
      details: d.details !== false,
      clientId: /^\d{15,22}$/.test(d.clientId || '') ? d.clientId : DEFAULT_CLIENT_ID,
      // Player count stays on like before; the server name is opt-in (it is a name others can see)
      players: d.players !== false,
      serverName: d.serverName === true,
      kindImages: d.kindImages === true,
      statusButton: d.statusButton === true,
      button: cleanButton(d.button),
    };
  }

  /** Buttons under the status: public status page (if switched on and reachable) and one own button. */
  buttons() {
    const c = this.cfg();
    const out = [];
    const link = c.statusButton && this.d.statusLink ? this.d.statusLink() : null;
    if (link && isWebUrl(link)) out.push({ label: this.d.t('View status'), url: link });
    if (c.button) out.push(c.button);
    return out.slice(0, 2);
  }

  start() {
    if (process.env.HW_TEST && !process.env.HW_TEST_DISCORD) return; // never connect to the real Discord in tests
    if (this.d.desktop === false) return; // server without a screen: no Discord client there
    this.started = true;
    this.d.bus.on('broadcast', this.onBus);
    this.retry = setInterval(() => { if (!this.sock && !this.connecting) this.connect(); }, 20000);
    if (this.retry.unref) this.retry.unref();
    this.connect();
  }

  status() {
    const c = this.cfg();
    let preview = null;
    // What others see right now – the page shows this instead of an example
    try { preview = c.enabled ? this.activity() : null; } catch { preview = null; }
    return {
      enabled: c.enabled, details: c.details, players: c.players, serverName: c.serverName, kindImages: c.kindImages, statusButton: c.statusButton, button: c.button,
      hasClientId: !!c.clientId, ownClientId: c.clientId !== DEFAULT_CLIENT_ID, connected: this.ready, user: this.user, error: this.lastError,
      desktop: this.d.desktop !== false, statusLink: !!(this.d.statusLink && this.d.statusLink()), preview,
    };
  }

  /** Tell the interface (page and sidebar dot) – only when something visible changed. */
  notify() {
    if (!this.d.notify) return;
    const s = this.status();
    const key = JSON.stringify(s);
    if (key === this.lastNotified) return;
    this.lastNotified = key;
    try { this.d.notify(s); } catch { /* the interface is optional */ }
  }

  /**
   * Save settings (only known fields) and apply them right away.
   * clientId: '' = back to the Hostwerk application (the page has its own "Use default" button for it).
   */
  save(b) {
    const s = this.d.settings.get();
    s.general = s.general || {};
    const d = { ...(s.general.discord || {}) };
    for (const k of ['enabled', 'details', 'players', 'serverName', 'kindImages', 'statusButton']) if (typeof b[k] === 'boolean') d[k] = b[k];
    if (typeof b.clientId === 'string' && /^(\d{15,22})?$/.test(b.clientId.trim())) d.clientId = b.clientId.trim();
    if (b.button === null) delete d.button;
    else if (b.button !== undefined) {
      const btn = cleanButton(b.button);
      if (!btn) throw Object.assign(new Error(this.d.t('A button needs a label and a web address (https://…).')), { status: 400 });
      d.button = btn;
    }
    s.general.discord = d;
    this.d.settings.save();
    this.reconfigure();
    this.notify();
    return this.status();
  }

  // Settings changed: reconnect (different application id) or clear the status right away
  reconfigure() {
    if (this.sock && this.sock.clientId !== this.cfg().clientId) this.disconnect();
    if (!this.cfg().enabled) { this.clear(); return; }
    if (!this.started) return; // not running (tests, no screen): only the settings change
    if (!this.sock) this.connect();
    else this.schedule(0);
  }

  async connect() {
    const c = this.cfg();
    if (!this.started || this.closed || !c.enabled || !c.clientId || this.connecting || this.sock) return;
    this.connecting = true;
    try {
      for (const p of pipePaths()) {
        const sock = await new Promise((resolve) => {
          const s = net.createConnection(p);
          const fail = () => { s.destroy(); resolve(null); };
          s.once('error', fail);
          s.setTimeout(1500, fail);
          s.once('connect', () => { s.removeListener('error', fail); s.setTimeout(0); resolve(s); });
        });
        if (!sock) continue;
        this.attach(sock, c.clientId);
        return;
      }
      this.lastError = null; // Discord simply is not running – not an error
    } finally { this.connecting = false; }
  }

  attach(sock, clientId) {
    this.sock = sock;
    sock.clientId = clientId;
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        let msg = null;
        try { msg = JSON.parse(buf.slice(8, 8 + len).toString('utf8')); } catch { /* broken frame */ }
        buf = buf.slice(8 + len);
        this.onMessage(op, msg);
      }
    });
    const gone = () => { if (this.sock === sock) { this.sock = null; this.ready = false; this.user = null; this.lastSent = ''; this.notify(); } };
    sock.on('error', (e) => { this.lastError = e.message; gone(); });
    sock.on('close', gone);
    sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: clientId }));
  }

  onMessage(op, msg) {
    if (op === OP.PING) { if (this.sock) this.sock.write(encode(OP.PONG, msg)); return; }
    if (op === OP.CLOSE) {
      // e.g. an invalid application id
      this.lastError = (msg && msg.message) || this.d.t('Discord refused the connection');
      this.disconnect();
      this.notify();
      return;
    }
    if (!msg) return;
    if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
      this.ready = true;
      this.lastError = null;
      this.user = msg.data && msg.data.user ? (msg.data.user.global_name || msg.data.user.username) : null;
      this.schedule(0);
      this.notify();
    } else if (msg.evt === 'ERROR') {
      this.lastError = (msg.data && msg.data.message) || this.d.t('Discord error');
      this.notify();
    }
  }

  disconnect() {
    const s = this.sock;
    this.sock = null; this.ready = false; this.user = null; this.lastSent = '';
    if (s) { try { s.end(encode(OP.CLOSE, {})); } catch { /* ignore */ } s.destroy(); }
  }

  // Discord allows only a few updates per minute → bundle them
  schedule(ms = 3000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(), ms);
    if (this.timer.unref) this.timer.unref();
  }

  activity() {
    const { t } = this.d;
    const c = this.cfg();
    const kinds = new Map();
    const webIds = new Set(this.d.webIds());
    const dbIds = new Set(this.d.dbIds());
    let players = 0;
    let top = null; // Minecraft server with the most players (for the opt-in server name)
    for (const p of this.d.registry.values()) {
      if (p.state !== 'running') continue;
      const id = p.id;
      let k = null;
      if (id.startsWith('mc:')) {
        k = 'mc';
        const n = (p.extra && p.extra.players && p.extra.players.length) || 0;
        players += n;
        if (!top || n > top.n) top = { id: id.slice(3), n };
      } else if (id.startsWith('app:')) k = 'app';
      else if (id === 'ai') k = 'ai';
      else if (id === 'mail' || id.startsWith('mailserver')) k = 'mail';
      else if (webIds.has(id)) k = 'web';
      else if (dbIds.has(id)) k = 'db';
      if (k) kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    const total = [...kinds.values()].reduce((a, b) => a + b, 0);
    const version = this.d.version() || '';
    const hostwerk = `Hostwerk${version ? ` ${version}` : ''}`;
    const act = {
      timestamps: { start: Math.floor(this.startedAt / 1000) },
      assets: { large_image: 'logo', large_text: hostwerk },
      instance: false,
    };
    if (c.details) {
      const names = KINDS.filter(([k]) => kinds.has(k)).map(([k, name]) => { const n = kinds.get(k); return `${t(name)}${n > 1 && k !== 'mail' ? ` ×${n}` : ''}`; });
      act.details = total ? names.join(' · ') : t('All services stopped');
      const parts = [];
      // Opt-in: name of the Minecraft server with the most players – the only name that ever leaves this PC
      const info = c.serverName && top && this.d.mcInfo ? this.d.mcInfo(top.id) : null;
      if (info && info.name) parts.push(String(info.name).slice(0, 60));
      else if (total) parts.push(t(total === 1 ? '{n} service running' : '{n} services running', { n: total }));
      if (c.players && players) parts.push(t(players === 1 ? '{n} player online' : '{n} players online', { n: players }));
      act.state = parts.length ? parts.join(' · ') : t('Local development server');
      // Party size shows "2 of 20" in Discord – only together with the player count
      if (c.players && info && info.maxPlayers && top.n) act.party = { id: `hostwerk-${top.id}`.slice(0, 60), size: [top.n, info.maxPlayers] };
      if (total && c.kindImages) {
        // Large image = the kind with the most running services (Minecraft first on a tie), small image = Hostwerk
        const main = KINDS.map(([k, name]) => [k, name, kinds.get(k) || 0]).filter((x) => x[2]).sort((a, b) => b[2] - a[2] || (b[0] === 'mc') - (a[0] === 'mc'))[0];
        act.assets = { large_image: KIND_IMAGES[main[0]], large_text: t(main[1]), small_image: 'logo', small_text: hostwerk };
      } else if (total) { act.assets.small_image = 'running'; act.assets.small_text = t('Running'); }
    } else {
      act.details = t('Local development server');
    }
    const buttons = this.buttons();
    if (buttons.length) act.buttons = buttons;
    return act;
  }

  send(activity) {
    if (!this.sock || !this.ready) return;
    this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: String(++this.nonce) }));
  }

  update() {
    this.notify(); // the page shows the current status even while Discord is closed
    if (!this.ready) return;
    if (!this.cfg().enabled) { this.clear(); return; }
    let act;
    try { act = this.activity(); } catch (e) { this.lastError = e.message; return; }
    const key = JSON.stringify(act);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.send(act);
  }

  clear() {
    this.lastSent = '';
    if (this.ready) this.send(null);
  }

  stop() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.retry);
    this.d.bus.removeListener('broadcast', this.onBus);
    if (this.ready) { try { this.send(null); } catch { /* ignore */ } }
    this.disconnect();
  }
}

module.exports = { DiscordPresence, pipePaths, encode, cleanButton, DEFAULT_CLIENT_ID, KINDS, KIND_IMAGES };
