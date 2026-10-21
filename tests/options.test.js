'use strict';
/*
 * Discord status without a Discord connection: what the page previews, privacy of the opt-in fields, buttons, images per kind,
 * going back to the default application and the change events for the interface.
 *   node --test tests/*.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { DiscordPresence, cleanButton, DEFAULT_CLIENT_ID, KIND_IMAGES } = require('../server/presence');

function make(discord = {}, extra = {}) {
  const S = { general: { language: 'en', discord: { ...discord } } };
  const registry = new Map([
    ['apache', { id: 'apache', state: 'running', extra: {} }],
    ['mc:lobby', { id: 'mc:lobby', state: 'running', extra: { players: ['a'] } }],
    ['mc:survival', { id: 'mc:survival', state: 'running', extra: { players: ['b', 'c'] } }],
  ]);
  const sent = [];
  const d = new DiscordPresence({
    settings: { get: () => S, save: () => {} }, registry, bus: new EventEmitter(),
    webIds: () => ['apache'], dbIds: () => [], version: () => '2.11.0', t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s), desktop: true,
    mcInfo: (id) => ({ lobby: { name: 'Lobby', maxPlayers: 10 }, survival: { name: 'Survival world', maxPlayers: 20 } }[id] || null),
    notify: (s) => sent.push(s),
    ...extra,
  });
  return { d, S, registry, sent };
}

test('the page previews the real status, not an example', () => {
  const { d } = make();
  const p = d.status().preview;
  assert.strictEqual(p.details, 'Web servers · Minecraft ×2');
  assert.strictEqual(p.state, '3 services running · 3 players online');
  assert.ok(!JSON.stringify(p).includes('Survival'), 'no server name without opt-in');
  assert.ok(!JSON.stringify(p).includes('apache'), 'no service ids');
});

test('player count can be switched off, server name is opt-in', () => {
  const { d } = make({ players: false });
  assert.strictEqual(d.activity().state, '3 services running');
  const b = make({ serverName: true }).d.activity();
  assert.strictEqual(b.state, 'Survival world · 3 players online', 'server with the most players');
  assert.deepStrictEqual(b.party.size, [2, 20]);
  const c = make({ serverName: true, players: false }).d.activity();
  assert.strictEqual(c.state, 'Survival world');
  assert.strictEqual(c.party, undefined, 'no party size without the player count');
  const off = make({ serverName: true, details: false }).d.activity();
  assert.strictEqual(off.details, 'Local development server');
  assert.ok(!JSON.stringify(off).includes('Survival'), 'details off hides the server name too');
});

test('one image per kind: large = main kind, small = Hostwerk', () => {
  const a = make({ kindImages: true }).d.activity();
  assert.strictEqual(a.assets.large_image, KIND_IMAGES.mc);
  assert.strictEqual(a.assets.small_image, 'logo');
  assert.strictEqual(a.assets.small_text, 'Hostwerk 2.11.0');
  const b = make().d.activity();
  assert.strictEqual(b.assets.large_image, 'logo');
  assert.strictEqual(b.assets.small_image, 'running');
});

test('buttons: status page link only when public, own button checked', () => {
  assert.strictEqual(cleanButton({ label: 'Join', url: 'javascript:alert(1)' }), null);
  assert.strictEqual(cleanButton({ label: '', url: 'https://x.example' }), null);
  assert.strictEqual(cleanButton({ label: 'x'.repeat(50), url: 'https://x.example' }).label.length, 32);

  const none = make({ statusButton: true }, { statusLink: () => null }).d.activity();
  assert.strictEqual(none.buttons, undefined, 'no public status page → no button');
  const both = make({ statusButton: true, button: { label: 'Join the server', url: 'https://example.org/join' } }, { statusLink: () => 'https://home.example.org/status/abc' }).d.activity();
  assert.deepStrictEqual(both.buttons, [{ label: 'View status', url: 'https://home.example.org/status/abc' }, { label: 'Join the server', url: 'https://example.org/join' }]);

  const { d, S } = make();
  assert.throws(() => d.save({ button: { label: 'Bad', url: 'file:///c:/x' } }), /web address/);
  d.save({ button: { label: 'Website', url: 'https://example.org' } });
  assert.deepStrictEqual(S.general.discord.button, { label: 'Website', url: 'https://example.org' });
  d.save({ button: null });
  assert.strictEqual(S.general.discord.button, undefined);
});

test('own application id and "Use default"', () => {
  const { d, S } = make();
  d.save({ clientId: '123456789012345678' });
  assert.strictEqual(d.cfg().clientId, '123456789012345678');
  assert.ok(d.status().ownClientId);
  d.save({ clientId: 'abc' }); // invalid → ignored
  assert.strictEqual(S.general.discord.clientId, '123456789012345678');
  d.save({ clientId: '' });
  assert.strictEqual(d.cfg().clientId, DEFAULT_CLIENT_ID);
  assert.ok(!d.status().ownClientId);
});

test('interface events only when something visible changed', () => {
  const { d, sent, registry } = make();
  d.notify(); d.notify();
  assert.strictEqual(sent.length, 1);
  registry.get('apache').state = 'stopped';
  d.update(); // not connected – still tells the page
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].preview.details, 'Minecraft ×2');
  d.save({ enabled: false });
  assert.strictEqual(sent[sent.length - 1].preview, null, 'off → nothing to preview');
});
