import { useEffect, useState } from 'react';
import { MessageSquare, ExternalLink, ShieldCheck, Activity, RotateCw, CloudOff, MousePointerClick, ChevronRight } from 'lucide-react';
import { get, put, useApi, openExternal, on } from '@hostwerk/api';
import { Btn, SettingRow, Switch, Callout, InfoTip, Loading, Empty, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import './style.css';

/*
 * Discord status page: switch it on/off, what is shown (services, players, server name, images, buttons), own application id.
 * Texts are English; German comes from locales/de.json (translated automatically, also inside JSX).
 *
 * No polling: the server sends { type: 'discord-status', status } whenever something visible changes. The last status is
 * kept here in the module, so the sidebar dot (nav.tip) shows it even while the page is closed.
 */
let last = null;
const subs = new Set();
const remember = (s) => { if (s && typeof s === 'object') { last = s; subs.forEach((f) => f(s)); } };
on('discord-status', (m) => remember(m && m.status));
get('/discord').then(remember).catch(() => { /* shown on the page */ });

function Preview({ s }) {
  // Small look-alike of the Discord profile card with the real status that others see right now
  const p = s.preview;
  if (!p) return <p className="small muted">Nothing is shown while sharing is off.</p>;
  const images = s.kindImages && p.assets && p.assets.large_image !== 'logo';
  return (
    <div className="discord-preview" aria-label="Preview">
      <div className="discord-preview-label">Playing a game</div>
      <div className="discord-preview-row">
        <div className="discord-preview-logo" aria-hidden="true">H</div>
        <div className="discord-preview-text">
          <b>Hostwerk</b>
          {p.details && <div className="small">{p.details}</div>}
          {p.state && <div className="small muted">{p.state}{p.party ? ` (${p.party.size[0]}/${p.party.size[1]})` : ''}</div>}
          {images && <div className="tiny muted">{t('Image: {name}', { name: p.assets.large_text })}</div>}
        </div>
      </div>
      {(p.buttons || []).map((b) => <div key={b.url} className="discord-preview-btn">{b.label}</div>)}
    </div>
  );
}

/** One own button under the status (label + web address). */
function OwnButton({ s, save }) {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  useEffect(() => { setLabel((s.button && s.button.label) || ''); setUrl((s.button && s.button.url) || ''); }, [s.button && s.button.label, s.button && s.button.url]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok = label.trim() && /^https?:\/\/[^\s/]+/i.test(url.trim());
  return (
    <SettingRow title="Own button" text="For example “Join the server” with a link to your website or Discord server.">
      <div className="discord-button-form">
        <input className="input sm" maxLength={32} placeholder="Label" aria-label="Button label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input className="input sm" placeholder="https://…" aria-label="Button address" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Btn className="sm" disabled={!ok} onClick={() => save({ button: { label: label.trim(), url: url.trim() } }, 'Saved')}>Save</Btn>
        {s.button && <Btn className="sm ghost" onClick={() => save({ button: null }, 'Button removed')}>Remove</Btn>}
      </div>
    </SettingRow>
  );
}

function DiscordPage() {
  // Loads once and on Hostwerk events; changes of the connection come as an event (no 5-second polling any more)
  const st = useApi('/discord', [], { poll: false });
  const { setData } = st;
  useEffect(() => { subs.add(setData); return () => { subs.delete(setData); }; }, [setData]);
  const [id, setId] = useState('');
  const [more, setMore] = useState(false);
  if (!st.data && st.error) {
    return <div className="page"><Empty icon={CloudOff} title="Could not load the Discord status" text={st.error} action={<Btn icon={RotateCw} onClick={() => st.reload()}>Try again</Btn>} /></div>;
  }
  if (!st.data) return <div className="page"><Loading /></div>;
  const s = st.data;
  const save = async (patch, done) => { try { const r = await put('/discord/settings', patch); setData(r); remember(r); if (done) toast.success(done); } catch (e) { toast.error(e); } };
  const line = s.enabled === false ? 'Off'
    : !s.hasClientId ? 'Application id missing'
      : s.connected ? (s.user ? `Connected as ${s.user} – your status is shown` : 'Connected – your status is shown')
        : s.error ? `Error: ${s.error}` : 'Discord is not running – Hostwerk connects as soon as Discord is open';
  const on2 = s.connected && s.enabled !== false;
  const off = s.enabled === false;
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><MessageSquare /> Discord status</h1>
          <p>Shows “Playing Hostwerk” in your Discord profile – even when Hostwerk only runs in the tray.</p>
        </div>
        <div className="actions">
          <span className={`badge ${on2 ? 'ok' : ''}`}>{on2 ? 'Connected' : 'Not connected'}</span>
          <InfoTip title="What is shared?" icon={ShieldCheck}>Only kinds of services (for example web server · database) and how many are running. Never project or folder names – a server name only if you switch it on.</InfoTip>
        </div>
      </div>
      {s.desktop === false && <Callout kind="info" dismissible={false}>This Hostwerk runs without a screen – Discord is not available here.</Callout>}
      <div className="grid grid-2 discord-grid">
        <div className="card">
          <div className="card-head"><Activity size={16} /><h3>Settings</h3></div>
          <div className="card-body">
            <SettingRow title="Share status in Discord" text={line}><Switch checked={!off} onChange={(v) => save({ enabled: v })} /></SettingRow>
            <SettingRow title="Show running services" text="Off = only “Hostwerk” with the uptime."><Switch checked={s.details !== false} disabled={off} onChange={(v) => save({ details: v })} /></SettingRow>
            <SettingRow title="Show player count" text="How many players are on your Minecraft servers."><Switch checked={s.players !== false} disabled={off || s.details === false} onChange={(v) => save({ players: v })} /></SettingRow>
            <SettingRow title="Show server name" text="Name of the Minecraft server with the most players – visible to everyone on Discord."><Switch checked={!!s.serverName} disabled={off || s.details === false} onChange={(v) => save({ serverName: v })} /></SettingRow>
            <SettingRow title="Button “View status”" text={s.statusLink ? 'Links to your public status page.' : 'Needs the public status page (Live → Status page) and remote access.'}>
              <Switch checked={!!s.statusButton} disabled={off} onChange={(v) => save({ statusButton: v })} />
            </SettingRow>
            {/* Selten gebraucht: eigener Knopf und eigene Discord-Anwendung – zugeklappt, damit die Vorschau im Bild bleibt */}
            <button type="button" className="btn ghost sm discord-more" aria-expanded={more} aria-controls="discord-more" onClick={() => setMore(!more)}>
              <ChevronRight size={14} className={more ? 'discord-rot' : ''} aria-hidden="true" />{t('Images, own button and application')}
            </button>
            {more && <div id="discord-more">
            <SettingRow title={<>One image per kind <InfoTip title="Images in Discord">Discord shows the image of the kind that runs most (web server, database, Minecraft …). The images have to be uploaded to the Discord application under the names kind-web, kind-db, kind-mail, kind-app, kind-mc and kind-ai (Rich Presence → Art Assets) – otherwise Discord shows none.</InfoTip></>} text="Large image for the main kind, small Hostwerk logo.">
              <Switch checked={!!s.kindImages} disabled={off || s.details === false} onChange={(v) => save({ kindImages: v })} />
            </SettingRow>
            <OwnButton s={s} save={save} />
            <SettingRow title="Discord application id" text={s.ownClientId ? 'Your own application.' : 'Hostwerk’s application is used.'}>
              <div className="row-tight">
                <input className="input sm discord-id" inputMode="numeric" placeholder="e.g. 1234567890123456789" aria-label="Discord application id" value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ''))} />
                <Btn className="sm" disabled={!/^\d{15,22}$/.test(id)} onClick={() => save({ clientId: id }, 'Saved').then(() => setId(''))}>Save</Btn>
                {s.ownClientId && <Btn className="sm ghost" onClick={() => save({ clientId: '' }, 'Hostwerk’s application is used again')}>Use default</Btn>}
              </div>
            </SettingRow>
            <Btn className="sm ghost discord-portal" icon={ExternalLink} onClick={() => openExternal('https://discord.com/developers/applications')}>Open the Discord developer portal</Btn>
            </div>}
          </div>
        </div>
        <div className="card discord-preview-card">
          <div className="card-head"><MousePointerClick size={16} /><h3>How it looks</h3></div>
          <div className="card-body"><Preview s={s} /></div>
        </div>
      </div>
    </div>
  );
}

export default {
  pages: { main: DiscordPage },
  slots: {
    // Seit Hostwerk 3.0 (SDK 3.2) ohne eigenen Seitenleisten-Eintrag ("nav": false) – die ganze Seite als Reiter im passenden Bereich;
    // Hostwerk blendet dabei ihren Titel aus (Reiter + Herkunftszeile sagen schon, was es ist), die Knöpfe bleiben
    // Eigener Reiter in Hostwerks Einstellungen (SDK 3.8, Steckplatz settings.tabs): der Status gehört zu deinem Profil, nicht
    // zum Livebetrieb – die Discord-Steuerung (Bot) bleibt unter Livebetrieb → Betrieb
    'settings.tabs': [{ id: 'discord-status', title: 'Discord status', icon: MessageSquare, Component: DiscordPage, order: 60 }],
  },
  // Sidebar: green dot while Discord shows the status, grey when off or Discord is closed, red on an error
  nav: {
    tip: () => {
      const s = last;
      if (!s) return null;
      const state = s.enabled === false ? 'stopped' : s.connected ? 'running' : s.error ? 'error' : 'stopped';
      const text = s.enabled === false ? t('Off') : s.connected ? (s.user ? t('Connected as {user}', { user: s.user }) : t('Connected')) : s.error ? t('Error: {error}', { error: s.error }) : t('Discord is not running');
      return { text: t('Shows “Playing Hostwerk” in your Discord profile.'), lines: [{ name: 'Discord', state, text }] };
    },
  },
};
