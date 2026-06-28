import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  Archive,
  BrainCircuit,
  CalendarDays,
  CheckCircle2,
  Cloud,
  Database,
  FileText,
  FolderOpen,
  Globe2,
  Link2,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users
} from 'lucide-react';
import './styles.css';

const API_BASE = window.location.pathname.startsWith('/psychapp') ? '/psychapp/api' : '/api';

const CONNECTORS = [
  { id: 'gmail', label: 'Gmail', provider: 'google', icon: Mail },
  { id: 'google_drive', label: 'Google Drive', provider: 'google', icon: FolderOpen },
  { id: 'google_calendar', label: 'Google Calendar', provider: 'google', icon: CalendarDays },
  { id: 'outlook', label: 'Outlook Mail', provider: 'microsoft', icon: Mail },
  { id: 'sharepoint', label: 'OneDrive / SharePoint', provider: 'microsoft', icon: Cloud },
  { id: 'teams', label: 'Microsoft Teams', provider: 'microsoft', icon: Users }
];

const EXPORT_SOURCES = [
  'WhatsApp .txt',
  'Twitter / X .js .json',
  'Instagram .json',
  'Thunderbird .mbox',
  'Dropbox .csv .txt',
  'Proton Drive .txt .md'
];

function App() {
  const [health, setHealth] = useState(null);
  const [oauth, setOauth] = useState(null);
  const [selectedConnectors, setSelectedConnectors] = useState([]);
  const [files, setFiles] = useState([]);
  const [profiles, setProfiles] = useState([
    { id: crypto.randomUUID(), url: 'https://x.com/oibafsaijem', enabled: true },
    { id: crypto.randomUUID(), url: 'https://instagram.com/soyoibaf', enabled: true }
  ]);
  const [remoteMcp, setRemoteMcp] = useState({ name: '', url: '', allowed: '' });
  const [notes, setNotes] = useState('');
  const [scrapePreview, setScrapePreview] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    refreshStatus();
  }, []);

  const activeProfileUrls = useMemo(
    () => profiles.filter(profile => profile.enabled && profile.url.trim()).map(profile => profile.url.trim()),
    [profiles]
  );

  async function refreshStatus() {
    setError('');
    try {
      const [healthRes, oauthRes] = await Promise.all([
        fetch(`${API_BASE}/health`),
        fetch(`${API_BASE}/oauth/status`)
      ]);
      setHealth(await healthRes.json());
      setOauth(await oauthRes.json());
    } catch (err) {
      setError(err.message);
    }
  }

  function providerConnected(provider) {
    return Boolean(oauth?.providers?.[provider]?.connected);
  }

  function toggleConnector(id) {
    setSelectedConnectors(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id]
    );
  }

  async function connectProvider(provider) {
    window.location.href = `${API_BASE}/oauth/start/${provider}?return_to=${encodeURIComponent(window.location.pathname)}`;
  }

  async function disconnectProvider(provider) {
    setBusy(`disconnect-${provider}`);
    try {
      await fetch(`${API_BASE}/oauth/logout/${provider}`, { method: 'POST' });
      await refreshStatus();
    } finally {
      setBusy('');
    }
  }

  async function readFiles(event) {
    const selected = [...event.target.files].slice(0, 12);
    const next = [];
    for (const file of selected) {
      const text = await file.text();
      next.push({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type || 'text/plain',
        size: file.size,
        text: text.slice(0, 60000)
      });
    }
    setFiles(current => [...current, ...next]);
    event.target.value = '';
  }

  function updateProfile(id, patch) {
    setProfiles(current => current.map(profile => profile.id === id ? { ...profile, ...patch } : profile));
  }

  function addProfile() {
    setProfiles(current => [...current, { id: crypto.randomUUID(), url: '', enabled: true }]);
  }

  async function runScrape() {
    setBusy('scrape');
    setError('');
    setScrapePreview(null);
    try {
      const response = await fetch(`${API_BASE}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: activeProfileUrls })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || 'Scraping falló');
      setScrapePreview(data.results);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function runAnalysis() {
    setBusy('analysis');
    setError('');
    setAnalysis(null);
    try {
      const remote_mcp_servers = remoteMcp.url.trim()
        ? [{
            name: remoteMcp.name.trim() || 'remote_mcp',
            server_url: remoteMcp.url.trim(),
            allowed_tools: remoteMcp.allowed.split(',').map(item => item.trim()).filter(Boolean)
          }]
        : [];
      const response = await fetch(`${API_BASE}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes,
          profile_urls: activeProfileUrls,
          files,
          connector_ids: selectedConnectors,
          remote_mcp_servers
        })
      });
      const data = await response.json();
      if (!response.ok) {
        if (data?.error?.oauth_url) {
          setError(`${data.error.message}. Abriendo OAuth...`);
          window.location.href = data.error.oauth_url;
          return;
        }
        throw new Error(data?.error?.message || 'Análisis falló');
      }
      setAnalysis(data);
      setScrapePreview(data.scraped || null);
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/psychapp/">
          <span className="brand-mark">ΨD</span>
          <span>
            <strong>PsychApp</strong>
            <small>Psyche Deep</small>
          </span>
        </a>
        <nav className="top-actions" aria-label="Estado">
          <StatusPill ok={health?.openai?.key_present} label={health?.openai?.key_present ? 'OpenAI activo' : 'OpenAI pendiente'} />
          <StatusPill ok={health?.supabase?.configured} label={health?.supabase?.configured ? 'Supabase activo' : 'Supabase opcional'} />
          <button className="icon-button" onClick={refreshStatus} title="Actualizar estado">
            <RefreshCw size={18} />
          </button>
        </nav>
      </header>

      <section className="workspace">
        <aside className="side-panel">
          <section className="panel-block identity-block">
            <BrainCircuit size={28} />
            <div>
              <h1>Modelo psicológico computacional</h1>
              <p>Análisis prudente con OpenAI, MCP, OAuth, archivos y scraping público.</p>
            </div>
          </section>

          <section className="panel-block">
            <div className="section-title">
              <ShieldCheck size={18} />
              <h2>OAuth</h2>
            </div>
            <ProviderRow
              name="Google"
              connected={providerConnected('google')}
              busy={busy === 'disconnect-google'}
              onConnect={() => connectProvider('google')}
              onDisconnect={() => disconnectProvider('google')}
            />
            <ProviderRow
              name="Microsoft"
              connected={providerConnected('microsoft')}
              busy={busy === 'disconnect-microsoft'}
              onConnect={() => connectProvider('microsoft')}
              onDisconnect={() => disconnectProvider('microsoft')}
            />
          </section>

          <section className="panel-block">
            <div className="section-title">
              <Database size={18} />
              <h2>MCP conectores</h2>
            </div>
            <div className="source-list">
              {CONNECTORS.map(connector => (
                <ConnectorToggle
                  key={connector.id}
                  connector={connector}
                  selected={selectedConnectors.includes(connector.id)}
                  connected={providerConnected(connector.provider)}
                  onToggle={() => toggleConnector(connector.id)}
                />
              ))}
            </div>
          </section>

          <section className="panel-block compact">
            <div className="section-title">
              <Globe2 size={18} />
              <h2>MCP remoto</h2>
            </div>
            <input
              value={remoteMcp.name}
              onChange={event => setRemoteMcp(current => ({ ...current, name: event.target.value }))}
              placeholder="Etiqueta"
            />
            <input
              value={remoteMcp.url}
              onChange={event => setRemoteMcp(current => ({ ...current, url: event.target.value }))}
              placeholder="https://servidor-mcp.example.com/mcp"
            />
            <input
              value={remoteMcp.allowed}
              onChange={event => setRemoteMcp(current => ({ ...current, allowed: event.target.value }))}
              placeholder="allowed_tools separados por coma"
            />
          </section>
        </aside>

        <section className="main-panel">
          <div className="analysis-header">
            <div>
              <p className="eyebrow">Analysis workspace</p>
              <h2>Análisis exhaustivo</h2>
            </div>
            <button className="primary-button" onClick={runAnalysis} disabled={busy === 'analysis'}>
              {busy === 'analysis' ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
              Iniciar análisis completo
            </button>
          </div>

          {error && <div className="alert">{error}</div>}

          <div className="input-grid">
            <section className="work-section">
              <div className="section-title">
                <FileText size={18} />
                <h3>Notas y contexto</h3>
              </div>
              <textarea
                value={notes}
                onChange={event => setNotes(event.target.value)}
                placeholder="Estado actual, objetivos, preguntas o contexto clínico no sensible..."
              />
              <div className="method-strip" aria-label="Capas de análisis">
                {['OCEAN', 'LIWC', 'Apego', 'Young', 'Sesgos', 'Series', 'Predicción'].map(label => (
                  <span key={label}>{label}</span>
                ))}
              </div>
            </section>

            <section className="work-section">
              <div className="section-title">
                <Upload size={18} />
                <h3>Archivos exportados</h3>
              </div>
              <label className="upload-zone">
                <Archive size={22} />
                <input type="file" multiple onChange={readFiles} accept=".txt,.md,.json,.csv,.mbox,.js" />
                <span>{files.length ? `${files.length} archivo(s) cargado(s)` : 'Seleccionar exports'}</span>
              </label>
              <div className="export-chips">
                {EXPORT_SOURCES.map(source => <span key={source}>{source}</span>)}
              </div>
              {files.length > 0 && (
                <div className="file-list">
                  {files.map(file => (
                    <button key={file.id} className="file-row" onClick={() => setFiles(current => current.filter(item => item.id !== file.id))} title="Quitar archivo">
                      <FileText size={16} />
                      <span>{file.name}</span>
                      <Trash2 size={15} />
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="work-section profile-section">
            <div className="section-title split">
              <span>
                <Search size={18} />
                <h3>Perfiles públicos</h3>
              </span>
              <button className="secondary-button" onClick={runScrape} disabled={busy === 'scrape' || !activeProfileUrls.length}>
                {busy === 'scrape' ? <Loader2 className="spin" size={17} /> : <Globe2 size={17} />}
                Probar scraping
              </button>
            </div>

            <div className="profile-list">
              {profiles.map(profile => (
                <div className="profile-row" key={profile.id}>
                  <input
                    type="checkbox"
                    checked={profile.enabled}
                    onChange={event => updateProfile(profile.id, { enabled: event.target.checked })}
                    aria-label="Activar perfil"
                  />
                  <Link2 size={17} />
                  <input
                    value={profile.url}
                    onChange={event => updateProfile(profile.id, { url: event.target.value })}
                    placeholder="https://..."
                  />
                  <button className="icon-button" onClick={() => setProfiles(current => current.filter(item => item.id !== profile.id))} title="Quitar perfil">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>

            <button className="ghost-button" onClick={addProfile}>
              <Plus size={17} />
              Añadir perfil público
            </button>
          </section>

          <section className="result-band">
            <div className="result-panel">
              <div className="section-title">
                <Activity size={18} />
                <h3>Resultado</h3>
              </div>
              {analysis?.output_text ? (
                <pre className="analysis-text">{analysis.output_text}</pre>
              ) : (
                <div className="empty-state">
                  <BrainCircuit size={42} />
                  <p>Listo para analizar datos conectados, archivos y perfiles públicos.</p>
                </div>
              )}
            </div>

            <div className="scrape-panel">
              <div className="section-title">
                <Globe2 size={18} />
                <h3>Scraping</h3>
              </div>
              {scrapePreview?.length ? (
                <div className="scrape-list">
                  {scrapePreview.map(item => (
                    <article key={`${item.url}-${item.fetched_at}`} className={item.ok ? 'scrape-ok' : 'scrape-fail'}>
                      <strong>{item.title || item.url}</strong>
                      <span>{item.status || 'ERR'} · {item.elapsed_ms} ms · {item.bytes_read || 0} bytes</span>
                      <p>{item.description || item.text || item.error}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-mini">Sin scraping ejecutado.</div>
              )}
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}

function StatusPill({ ok, label }) {
  return (
    <span className={ok ? 'status-pill ok' : 'status-pill warn'}>
      {ok ? <CheckCircle2 size={15} /> : <Activity size={15} />}
      {label}
    </span>
  );
}

function ProviderRow({ name, connected, busy, onConnect, onDisconnect }) {
  return (
    <div className="provider-row">
      <span className={connected ? 'dot connected' : 'dot'} />
      <strong>{name}</strong>
      <button onClick={connected ? onDisconnect : onConnect}>
        {busy ? <Loader2 className="spin" size={16} /> : null}
        {connected ? 'Desconectar' : 'Conectar'}
      </button>
    </div>
  );
}

function ConnectorToggle({ connector, selected, connected, onToggle }) {
  const Icon = connector.icon;
  return (
    <label className={selected ? 'connector selected' : 'connector'}>
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <Icon size={18} />
      <span>
        <strong>{connector.label}</strong>
        <small>{connected ? 'OAuth listo' : 'OAuth pendiente'}</small>
      </span>
    </label>
  );
}

createRoot(document.getElementById('root')).render(<App />);
