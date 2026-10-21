'use strict';
/*
 * Native part of the Discord status extension: runs inside Hostwerk (SDK 2.7, see the guide "Native extensions").
 *   GET /api/discord            → connection state
 *   PUT /api/discord/settings   → { enabled, details, players, serverName, kindImages, statusButton, button, clientId }
 * Changes reach the interface as the event { type: 'discord-status', status } (page and sidebar dot, no polling).
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
    // Opt-in server name: only name and player limit of the server, nothing else
    mcInfo: (id) => { try { const m = ctx.minecraft && ctx.minecraft.list().find((x) => x.id === id); return m ? { name: m.name, maxPlayers: ctx.minecraft.info(m).maxPlayers || null } : null; } catch { return null; } },
    // Button "View status": only the public link of the status page (Live → Status page), never the local one
    statusLink: () => { try { const p = ctx.statusPage; if (!p || !p.cfg.on) return null; const l = p.links(); return (l.public && l.public[0]) || null; } catch { return null; } },
    notify: (status) => host.broadcast({ type: 'discord-status', status }),
  });
  host.provide('discord', presence);
  host.router.get('/discord', (req, res) => res.json(presence.status()));
  host.router.put('/discord/settings', (req, res) => {
    try { res.json(presence.save(req.body || {})); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  host.on('shutdown', () => presence.stop());
  presence.start();
}

function deactivate() { if (presence) presence.stop(); presence = null; }

module.exports = { activate, deactivate };
