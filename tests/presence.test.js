'use strict';
/*
 * Discord status: protocol (handshake, SET_ACTIVITY, ping), content without project names, German texts, switching off,
 * reconnecting. Uses its own fake pipe – never connects to the real Discord.
 *   node --test tests/*.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const pipe = process.platform === 'win32' ? `\\\\?\\pipe\\hw-discord-ext-test-${process.pid}` : path.join(os.tmpdir(), `hw-discord-ext-test-${process.pid}`);
process.env.HW_DISCORD_PIPE = pipe;
process.env.HW_TEST_DISCORD = '1';
const { DiscordPresence, encode } = require('../server/presence');
const de = require('../locales/de.json');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Discord status end to end with a fake Discord', async () => {
  const frames = [];
  let client = null;
  const server = net.createServer((s) => {
    client = s;
    let buf = Buffer.alloc(0);
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0); const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        const msg = JSON.parse(buf.slice(8, 8 + len).toString());
        buf = buf.slice(8 + len);
        frames.push({ op, msg });
        if (op === 0) s.write(encode(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { username: 'tester', global_name: 'Testi' } } }));
      }
    });
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(pipe, r));

  const S = { general: { language: 'de', discord: { clientId: '123456789012345678' } } };
  const settings = { get: () => S, save: () => {} };
  const registry = new Map([
    ['apache', { id: 'apache', state: 'running', extra: {} }],
    ['mariadb', { id: 'mariadb', state: 'running', extra: {} }],
    ['mc:x', { id: 'mc:x', state: 'running', extra: { players: ['a', 'b'] } }],
  ]);
  const bus = new EventEmitter();
  const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s);
  const t = (s, v) => fill(S.general.language === 'de' && de[s] ? de[s] : s, v);
  const d = new DiscordPresence({ settings, registry, bus, webIds: () => ['apache'], dbIds: () => ['mariadb'], version: () => '9.9.9', t, desktop: true });
  d.start();
  await wait(400);
  const last = () => [...frames].reverse().find((f) => f.msg.cmd === 'SET_ACTIVITY');

  assert.strictEqual(frames[0].op, 0, 'handshake first');
  assert.strictEqual(frames[0].msg.client_id, '123456789012345678');
  assert.ok(d.status().connected && d.status().user === 'Testi');
  let a = last();
  const act = a.msg.args.activity;
  assert.strictEqual(a.msg.args.pid, process.pid);
  assert.strictEqual(act.details, 'Webserver · Datenbank · Minecraft');
  assert.match(act.state, /3 Dienste laufen · 2 Spieler online/);
  assert.ok(!JSON.stringify(frames).includes('apache'), 'no service ids or names are shared');
  assert.strictEqual(act.assets.large_text, 'Hostwerk 9.9.9');

  // English
  S.general.language = 'en';
  d.lastSent = ''; d.update(); await wait(50);
  assert.strictEqual(last().msg.args.activity.details, 'Web servers · Databases · Minecraft');
  assert.match(last().msg.args.activity.state, /3 services running · 2 players online/);
  S.general.language = 'de';

  // Changes are bundled
  const n = frames.length;
  registry.get('apache').state = 'stopped'; registry.get('mc:x').state = 'stopped';
  bus.emit('broadcast', { type: 'status' }); bus.emit('broadcast', { type: 'status' });
  await wait(3500);
  const upd = frames.slice(n).filter((f) => f.msg.cmd === 'SET_ACTIVITY');
  assert.strictEqual(upd.length, 1);
  assert.strictEqual(upd[0].msg.args.activity.details, 'Datenbank');

  // Settings through save(): only known fields, applied at once
  d.save({ details: false, bogus: 1 });
  await wait(200);
  assert.strictEqual(S.general.discord.bogus, undefined);
  a = last();
  assert.strictEqual(a.msg.args.activity.details, 'Lokaler Entwicklungsserver');
  d.save({ enabled: false });
  await wait(200);
  assert.strictEqual(last().msg.args.activity, null, 'switched off → status cleared');

  client.write(encode(3, { x: 1 })); await wait(200);
  assert.ok(frames.some((f) => f.op === 4), 'ping → pong');

  d.save({ enabled: true });
  client.destroy(); await wait(200);
  assert.ok(!d.status().connected, 'Discord closed → disconnected');
  await d.connect(); await wait(400);
  assert.ok(d.status().connected, 'Discord open again → reconnected');

  // Discord refuses (e.g. an invalid application id): error on the page, connection closed, retried later
  client.write(encode(2, { code: 4000, message: 'Invalid Client ID' })); await wait(200);
  assert.ok(!d.status().connected);
  assert.strictEqual(d.status().error, 'Invalid Client ID');
  await d.connect(); await wait(400);
  assert.ok(d.status().connected && d.status().error === null, 'next connection clears the error');

  d.stop(); await wait(200);
  assert.strictEqual(last().msg.args.activity, null, 'cleared on shutdown');
  server.close();
});

test('every German text has a value', () => {
  for (const [k, v] of Object.entries(de)) if (k !== '$patterns') assert.ok(typeof v === 'string' && v.trim(), k);
});
