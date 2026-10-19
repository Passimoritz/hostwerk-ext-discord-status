'use strict';
/*
 * Native part of the Discord status extension: runs inside Hostwerk (SDK 2.7, see the guide "Native extensions").
 *   GET /api/discord            → connection state
 *   PUT /api/discord/settings   → { enabled, details, clientId }
 */
const { DiscordPresence } = require('./presence');

let presence = null;

function activate(host) {
  const { ctx } = host;
  const { bus } = host.core('events');
  const { registry } = host.core('proc');
  presence = new DiscordPresence({
    settings: ctx.settings,
    registry,
    bus,
    webIds: () => (ctx.web ? ctx.web.list() : []).map((i) => i.id),
    dbIds: () => (ctx.dbm ? ctx.dbm.list() : []).map((i) => i.id),
    version: () => (ctx.system && ctx.system.version) || '',
    t: host.t,
    desktop: host.core('platform').HAS_DESKTOP,
  });
  host.provide('discord', presence);
  host.router.get('/discord', (req, res) => res.json(presence.status()));
  host.router.put('/discord/settings', (req, res) => res.json(presence.save(req.body || {})));
  host.on('shutdown', () => presence.stop());
  presence.start();
}

function deactivate() { if (presence) presence.stop(); presence = null; }

module.exports = { activate, deactivate };
