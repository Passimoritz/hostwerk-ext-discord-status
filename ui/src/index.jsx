import { useEffect, useState } from 'react';
import { MessageSquare, ExternalLink, ShieldCheck, Activity } from 'lucide-react';
import { put, useApi, openExternal } from '@hostwerk/api';
import { Btn, SettingRow, Switch, Callout, InfoTip, toast } from '@hostwerk/ui';
import './style.css';

/*
 * Discord status page: switch it on/off, choose whether running services are shown, own application id.
 * Texts are English; German comes from locales/de.json (translated automatically, also inside JSX).
 */
function Preview({ s }) {
  // A small look-alike of the Discord profile card, so people see what others will see
  return (
    <div className="discord-preview" aria-label="Preview">
      <div className="discord-preview-label">Playing a game</div>
      <div className="discord-preview-row">
        <div className="discord-preview-logo" aria-hidden="true">H</div>
        <div>
          <b>Hostwerk</b>
          <div className="small">{s.details === false ? 'Local development server' : 'Web servers · Databases · Minecraft'}</div>
          {s.details !== false && <div className="small muted">3 services running · 2 players online</div>}
        </div>
      </div>
    </div>
  );
}

function DiscordPage() {
  const st = useApi('/discord', []);
  const s = st.data || {};
  const [id, setId] = useState('');
  useEffect(() => { const t = setInterval(() => st.reload({ silent: true }), 5000); return () => clearInterval(t); }, [st.reload]);
  const save = async (patch) => { try { st.setData(await put('/discord/settings', patch)); } catch (e) { toast.error(e); } };
  const line = s.enabled === false ? 'Off'
    : !s.hasClientId ? 'Application id missing'
      : s.connected ? (s.user ? `Connected as ${s.user} – your status is shown` : 'Connected – your status is shown')
        : s.error ? `Error: ${s.error}` : 'Discord is not running – Hostwerk connects as soon as Discord is open';
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><MessageSquare /> Discord status</h1>
          <p>Shows “Playing Hostwerk” in your Discord profile – even when Hostwerk only runs in the tray.</p>
        </div>
        <div className="actions">
          <span className={`badge ${s.connected && s.enabled !== false ? 'ok' : ''}`}>{s.connected && s.enabled !== false ? 'Connected' : 'Not connected'}</span>
          <InfoTip title="What is shared?" icon={ShieldCheck}>Only kinds of services (for example web server · database) and how many are running. Never project, server or folder names.</InfoTip>
        </div>
      </div>
      {s.desktop === false && <Callout kind="info" dismissible={false}>This Hostwerk runs without a screen – Discord is not available here.</Callout>}
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head"><Activity size={16} /><h3>Settings</h3></div>
          <div className="card-body">
            <SettingRow title="Share status in Discord" text={line}><Switch checked={s.enabled !== false} onChange={(v) => save({ enabled: v })} /></SettingRow>
            <SettingRow title="Show running services" text="Off = only “Hostwerk” with the uptime."><Switch checked={s.details !== false} disabled={s.enabled === false} onChange={(v) => save({ details: v })} /></SettingRow>
            <SettingRow title="Discord application id" text={s.ownClientId ? 'Your own application.' : 'Leave empty = Hostwerk default.'}>
              <div className="row-tight">
                <input className="input sm" style={{ width: 190 }} inputMode="numeric" placeholder="e.g. 1234567890123456789" aria-label="Discord application id" value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ''))} />
                <Btn className="sm" disabled={id !== '' && !/^\d{15,22}$/.test(id)} onClick={() => save({ clientId: id }).then(() => { setId(''); toast.success('Saved'); })}>Save</Btn>
              </div>
            </SettingRow>
            <Btn className="sm ghost" style={{ marginTop: 6 }} icon={ExternalLink} onClick={() => openExternal('https://discord.com/developers/applications')}>Open the Discord developer portal</Btn>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><MessageSquare size={16} /><h3>How it looks</h3></div>
          <div className="card-body"><Preview s={s} /></div>
        </div>
      </div>
    </div>
  );
}

export default {
  pages: { main: DiscordPage },
  // Sidebar: green dot while Discord shows the status
  nav: {},
};
