import { useState, useRef, useCallback, useEffect } from "react";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  CartesianGrid, ReferenceLine
} from "recharts";

const API_URL = "/api/messages";
const MODEL   = import.meta.env.VITE_OPENAI_MODEL || "gpt-4.1-mini";

const MCPS = {
  gmail:    { name:"gmail",           connector_id:"connector_gmail"          },
  drive:    { name:"drive",           connector_id:"connector_googledrive"    },
  calendar: { name:"google_calendar", connector_id:"connector_googlecalendar" },
  m365:     { name:"m365",            connector_id:"connector_outlookemail"   },
  outlook:  { name:"outlook",         connector_id:"connector_outlookemail"   },
  teams:    { name:"teams",           connector_id:"connector_microsoftteams" },
  onedrive: { name:"onedrive",        connector_id:"connector_sharepoint"     },
  dropbox:  { name:"dropbox",         connector_id:"connector_dropbox"        },
};

// ── PARSERS ──────────────────────────────────────────────────────────────────

function parseWhatsApp(text) {
  const out = [];
  const ios  = /\[(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\]\s([^:]+):\s(.+)/;
  const droid= /^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}),?\s+(\d{1,2}:\d{2}(?:\s?[AP]M)?)\s-\s([^:]+):\s(.+)/;
  for (const line of text.split("\n")) {
    const m = line.match(ios) || line.match(droid);
    if (!m) continue;
    const [,d,t,sender,content] = m;
    const parts = d.split(/[\/\-.]/);
    const ts = new Date(`${parts[2]?.length===2?"20"+parts[2]:parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}T${t.includes(":")&&t.split(":").length===2?t+":00":t}`);
    if (!isNaN(ts)) out.push({ ts, sender, content, source:"whatsapp" });
  }
  return out;
}

function parseTwitter(text) {
  try {
    const json = text.replace(/^window\.YTD\.\w+\.\w+\s*=\s*/, "").trim();
    const arr  = JSON.parse(json);
    return arr.map(item => {
      const tw = item.tweet || item;
      return { ts: new Date(tw.created_at), sender:"me", content: tw.full_text||tw.text||"", source:"twitter" };
    }).filter(m => !isNaN(m.ts));
  } catch { return []; }
}

function parseInstagram(text) {
  try {
    const data = JSON.parse(text);
    const msgs = data.messages || (Array.isArray(data) ? data : []);
    return msgs.map(m => ({
      ts: new Date(m.timestamp_ms || m.timestamp || 0),
      sender: m.sender_name || "me",
      content: m.content || m.text || "",
      source: "instagram"
    })).filter(m => m.content && !isNaN(m.ts));
  } catch { return []; }
}

function parseMBOX(text) {
  const out = [];
  const blocks = text.split(/^From /m).slice(1);
  for (const block of blocks) {
    const lines  = block.split("\n");
    let date="", subject="", body="", inBody=false;
    for (const l of lines) {
      if (!inBody && l.trim()==="") { inBody=true; continue; }
      if (inBody) { body+=l+" "; if(body.length>800) break; continue; }
      if (l.startsWith("Date:"))    date    = l.slice(5).trim();
      if (l.startsWith("Subject:")) subject = l.slice(8).trim();
    }
    const ts = new Date(date);
    if (!isNaN(ts)) out.push({ ts, sender:"me", content: subject+" "+body.trim(), source:"thunderbird" });
  }
  return out;
}

function parseCSV(text) {
  const lines = text.split("\n").slice(1);
  return lines.map(l => {
    const [date,,,,content] = l.split(",");
    const ts = new Date(date);
    return { ts, sender:"me", content: content||"", source:"csv" };
  }).filter(m => m.content && !isNaN(m.ts));
}

// ── API HELPERS ───────────────────────────────────────────────────────────────

async function callAI(system, userMsg, mcpList=[], maxTok=2000, tools=[]) {
  const body = {
    model: MODEL, max_tokens: maxTok,
    system,
    messages: [{ role:"user", content: userMsg }],
  };
  if (mcpList.length) body.mcp_servers = mcpList;
  if (tools.length)   body.tools       = tools;
  const r = await fetch(API_URL, {
    method:"POST",
    credentials:"include",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const e=await r.json().catch(()=>({}));
    throw new Error(e.error?.message||`HTTP ${r.status}`);
  }
  const data = await r.json();
  const text = data.content.filter(b=>b.type==="text").map(b=>b.text).join("");
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON in response: "+text.slice(0,200));
  return JSON.parse(match[0]);
}

const WEB_SEARCH_TOOL = [{ type:"web_search", name:"web_search" }];

async function fetchOAuthStatus() {
  try {
    const r = await fetch("/api/oauth/status", { credentials:"include" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── ANALYSIS PROMPTS ──────────────────────────────────────────────────────────

const INGEST_SYS = `You have access to data sources via OpenAI connectors / MCP tools. Your task:
1. Use available tools to list/search ALL messages and documents where authorized.
2. Return ONLY valid JSON, no markdown, no explanation.
Return: {"items":[{"id":"...","date":"ISO8601","content":"snippet max 300 chars","source":"...","meta":{}}],"next_page_token":null_or_string,"total_estimated":number}`;

const SCRAPE_SYS = (platform, handle, url) => `You are a data extraction agent with web_search capabilities.
Extract the maximum possible public content from this ${platform} profile: ${url} (handle: @${handle}).
Use web search where available. Deduplicate. Sort by date ascending.
Return ONLY valid JSON — no markdown, no preamble:
{
  "items": [
    {"date":"ISO8601","content":"full post text","source":"${platform}","url":"post url or empty","engagement":{"likes":0,"retweets":0,"comments":0}}
  ],
  "total_found": number,
  "data_quality": "none|poor|moderate|good",
  "sources_tried": ["url1","url2"],
  "notes": "brief description of what worked and what didn't"
}`;

const PERIOD_SYS = `You are a computational psychologist. Analyze the messages provided and extract features for THIS time period only.
Return ONLY valid JSON:
{
  "valence":number(-100_to_100),
  "arousal":number(0_to_100),
  "stress":number(0_to_100),
  "cognitive_complexity":number(0_to_100),
  "social_connectivity":number(0_to_100),
  "assertiveness":number(0_to_100),
  "hedging":number(0_to_100),
  "formality":number(0_to_100),
  "msg_count":number,
  "avg_length":number,
  "peak_hour":number(0_to_23),
  "themes":["..."],
  "biases_detected":["..."],
  "regulatory_events":["..."],
  "schema_activations":["..."],
  "anomalies":["..."],
  "locus_events":{"internal":number,"external":number},
  "attachment_signals":{"secure":number,"anxious":number,"avoidant":number}
}`;

const TRIGGER_SYS = `Analyze the full psychological time series and identify trigger patterns.
Return ONLY valid JSON:
{
  "triggers":[
    {"name":"...","type":"external|internal|cyclical","frequency":"...","antecedents":["..."],"behavioral_response":"...","emotional_signature":{"valence_shift":number,"arousal_shift":number},"examples":["..."]}
  ],
  "cyclical_patterns":[
    {"name":"...","period":"daily|weekly|monthly|seasonal","description":"...","peak_phase":"...","trough_phase":"..."}
  ],
  "correlations":[
    {"factor_a":"...","factor_b":"...","direction":"positive|negative","strength":number,"lag_days":number,"interpretation":"..."}
  ],
  "critical_periods":["..."],
  "burnout_risk_factors":["..."],
  "resilience_indicators":["..."]
}`;

const PROFILE_SYS = `Synthesize all data into a deep psychological profile. Be specific and evidence-based. Avoid vague generalities.
Return ONLY valid JSON:
{
  "ocean":{"openness":{"score":number,"ci_low":number,"ci_high":number,"confidence":"low|medium|high","evidence":["..."],"descriptors":["..."]},"conscientiousness":{...same...},"extraversion":{...same...},"agreeableness":{...same...},"neuroticism":{...same...}},
  "cognitive_biases":[{"name":"...","frequency":"...","example":"...","impact":"..."}],
  "defense_mechanisms":[{"name":"...","context":"...","frequency":"..."}],
  "schemas":[{"name":"...","domain":"...","activation_triggers":["..."],"evidence":"..."}],
  "attachment_style":{"primary":"secure|anxious|avoidant|disorganized","secondary":"...","evidence":["..."]},
  "regulatory_profile":{"dominant_strategy":"...","failure_conditions":["..."],"recovery_patterns":["..."]},
  "locus_of_control":{"overall":"internal|external|mixed","ratio":number,"domain_breakdown":{}},
  "cognitive_style":{"mode":"analytical|intuitive|mixed","complexity_index":number,"need_for_cognition":number,"decision_style":"..."},
  "communication_fingerprint":{"unique_markers":["..."],"linguistic_tell_signs":["..."]},
  "evolutionary_trajectory":{"trend":"improving|stable|declining","key_transitions":["..."],"growth_domains":["..."]},
  "dark_triad_screening":{"narcissism_indicators":number,"machiavellianism_indicators":number,"note":"..."},
  "predictive_levers":["..."],
  "summary":"2-3 sentence clinical summary",
  "preventive_recommendations":["..."]
}`;

const FORECAST_SYS = (profile, recentSeries) =>
  `Deep psychological profile:\n${JSON.stringify(profile)}\n\nRecent 90-day time series:\n${JSON.stringify(recentSeries)}\n\nYou are a predictive behavioral model. When the user describes a situation, predict reaction with maximum specificity and depth. Format: {emotional_reaction:{primary:"...",secondary:"...",intensity:0-100,duration_estimate:"..."},cognitive_patterns_activated:["..."],likely_behaviors:["..."],regulatory_challenges:["..."],early_warning_signs:["..."],protective_factors:["..."],preventive_suggestions:["..."],probability_distribution:[{scenario:"...",probability:number,outcome:"..."}]}`;

// ── SOURCE DEFINITIONS ────────────────────────────────────────────────────────

const SOURCE_DEFS = [
  { id:"gmail",      label:"Gmail",          icon:"ti-mail",               mcp:true,  mcpKey:"gmail",    provider:"google",    color:"#E24B4A", desc:"Emails de Gmail vía OAuth" },
  { id:"drive",      label:"Google Drive",   icon:"ti-brand-google-drive", mcp:true,  mcpKey:"drive",    provider:"google",    color:"#378ADD", desc:"Documentos de Google Drive vía OAuth" },
  { id:"calendar",   label:"Google Calendar",icon:"ti-calendar",           mcp:true,  mcpKey:"calendar", provider:"google",    color:"#1D9E75", desc:"Calendario de Google vía OAuth" },
  { id:"m365",       label:"Outlook Mail",   icon:"ti-brand-office",       mcp:true,  mcpKey:"m365",     provider:"microsoft", color:"#0F6E56", desc:"Outlook / Microsoft 365 vía OAuth" },
  { id:"teams",      label:"Microsoft Teams",icon:"ti-brand-teams",        mcp:true,  mcpKey:"teams",    provider:"microsoft", color:"#6264A7", desc:"Teams vía Microsoft OAuth" },
  { id:"onedrive",   label:"OneDrive/SharePoint",icon:"ti-cloud",          mcp:true,  mcpKey:"onedrive", provider:"microsoft", color:"#0078D4", desc:"OneDrive/SharePoint vía Microsoft OAuth" },
  { id:"whatsapp",   label:"WhatsApp",       icon:"ti-brand-whatsapp",     mcp:false, upload:".txt",      color:"#1D9E75", desc:"Exporta chat: Ajustes → Chat → Exportar" },
  { id:"twitter",    label:"Twitter / X",    icon:"ti-brand-x",           mcp:false, upload:".js,.json", color:"#2C2C2A", desc:"tweets.js del archivo de Twitter" },
  { id:"instagram",  label:"Instagram",      icon:"ti-brand-instagram",    mcp:false, upload:".json",     color:"#D4537E", desc:"messages_1.json del archivo de Instagram" },
  { id:"thunderbird",label:"Thunderbird",    icon:"ti-mail-bolt",         mcp:false, upload:".mbox,.txt", color:"#EF9F27", desc:"Exporta: Herramientas → Exportar" },
  { id:"dropbox",    label:"Dropbox",        icon:"ti-brand-dropbox",     mcp:false, upload:".csv,.txt,.json", color:"#888780", desc:"Exporta archivos de texto/notas" },
  { id:"proton_drive",label:"Proton Drive",  icon:"ti-cloud-lock",        mcp:false, upload:".txt,.md", color:"#534AB7", desc:"Archivos de texto y notas" },
];

const parsers = { whatsapp:parseWhatsApp, twitter:parseTwitter, instagram:parseInstagram, thunderbird:parseMBOX, dropbox:parseCSV, proton_drive:parseCSV };

const DEFAULT_URL_SOURCES = [
  { id:"tw_public",  platform:"twitter",   label:"Twitter / X",  icon:"ti-brand-x",         color:"#2C2C2A", url:"https://x.com/oibafsaijem",        handle:"oibafsaijem", enabled:false,  status:"idle", found:0, quality:"" },
  { id:"ig_public",  platform:"instagram", label:"Instagram",    icon:"ti-brand-instagram",  color:"#D4537E", url:"https://instagram.com/soyoibaf",   handle:"soyoibaf",   enabled:false, status:"idle", found:0, quality:"" },
];

function groupByQuarter(items) {
  const map = {};
  for (const it of items) {
    const d = new Date(it.ts || it.date);
    if (isNaN(d)) continue;
    const key = `${d.getFullYear()}-Q${Math.ceil((d.getMonth()+1)/3)}`;
    if (!map[key]) map[key] = [];
    map[key].push(it);
  }
  return Object.entries(map).sort(([a],[b])=>a.localeCompare(b));
}

function sampleMessages(msgs, n=120) {
  if (msgs.length<=n) return msgs;
  const step = Math.max(1, Math.floor(msgs.length/n));
  return msgs.filter((_,i)=>i%step===0).slice(0,n);
}

// ── SMALL UI COMPONENTS ───────────────────────────────────────────────────────

function Tag({ children, color, bg }) {
  return <span style={{ fontSize:11, padding:"2px 8px", borderRadius:4, background:bg||"var(--color-background-secondary)", color:color||"var(--color-text-secondary)", border:"0.5px solid var(--color-border-tertiary)", display:"inline-block", lineHeight:1.7 }}>{children}</span>;
}

function Card({ children, style }) {
  return <div style={{ padding:"12px 14px", background:"var(--color-background-secondary)", borderRadius:"var(--border-radius-lg)", border:"0.5px solid var(--color-border-tertiary)", ...style }}>{children}</div>;
}

function Chip({ label, val, color="#378ADD" }) {
  return (
    <div style={{ textAlign:"center" }}>
      <div style={{ fontSize:20, fontWeight:500, color }}>{val}</div>
      <div style={{ fontSize:11, color:"var(--color-text-secondary)", marginTop:2 }}>{label}</div>
    </div>
  );
}

function MiniBar({ score, color }) {
  return <div style={{ height:4, background:"var(--color-border-tertiary)", borderRadius:2 }}><div style={{ height:"100%", width:`${Math.round(Math.min(100,Math.max(0,score)))}%`, background:color, borderRadius:2 }}/></div>;
}

const CT = { display:"flex", alignItems:"center", gap:8 };

function OAuthPanel({ oauth, refresh }) {
  const google = oauth?.providers?.google?.connected;
  const microsoft = oauth?.providers?.microsoft?.connected;
  const logout = async (provider) => {
    await fetch(`/api/oauth/logout/${provider}`, { method:"POST", credentials:"include" }).catch(()=>{});
    refresh?.();
  };
  return (
    <Card style={{ margin:"1rem 0" }}>
      <p style={{ margin:"0 0 8px", fontSize:12, fontWeight:500, color:"var(--color-text-secondary)" }}>CONEXIONES OAUTH</p>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
          <Tag color={google?"var(--color-text-success)":"var(--color-text-warning)"} bg={google?"var(--color-background-success)":"var(--color-background-warning)"}>Google {google?"conectado":"pendiente"}</Tag>
          {!google ? <button onClick={()=>{ window.location.href="/api/oauth/start/google"; }} style={{ fontSize:12, padding:"6px 10px" }}>Connect Google</button>
                   : <button onClick={()=>logout("google")} style={{ fontSize:12, padding:"6px 10px" }}>Disconnect</button>}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
          <Tag color={microsoft?"var(--color-text-success)":"var(--color-text-warning)"} bg={microsoft?"var(--color-background-success)":"var(--color-background-warning)"}>Microsoft {microsoft?"conectado":"pendiente"}</Tag>
          {!microsoft ? <button onClick={()=>{ window.location.href="/api/oauth/start/microsoft"; }} style={{ fontSize:12, padding:"6px 10px" }}>Connect Microsoft</button>
                      : <button onClick={()=>logout("microsoft")} style={{ fontSize:12, padding:"6px 10px" }}>Disconnect</button>}
        </div>
      </div>
      <p style={{ margin:"8px 0 0", fontSize:11, color:"var(--color-text-tertiary)", lineHeight:1.5 }}>
        Las cuentas conectadas se autorizan mediante OAuth. No pegues tokens de Gmail/Drive/Outlook en Render.
      </p>
    </Card>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────────

export default function PsycheDeep() {
  const [phase, setPhase]       = useState("config");
  const [sources, setSources]   = useState(() => Object.fromEntries(SOURCE_DEFS.map(s=>([s.id,{...s,files:[],enabled:false,itemCount:0,processed:0,status:"idle"}]))));
  const [urlSources, setUrlSrc] = useState(DEFAULT_URL_SOURCES);
  const [logs,setLogs]          = useState([]);
  const [corpus,setCorpus]      = useState([]);
  const [timeSeries,setTimeSeries] = useState([]);
  const [profile,setProfile]    = useState(null);
  const [triggers,setTriggers]  = useState(null);
  const [tab,setTab]            = useState("timeline");
  const [chatHist,setChatHist]  = useState([]);
  const [chatIn,setChatIn]      = useState("");
  const [chatBusy,setChatBusy]  = useState(false);
  const [err,setErr]            = useState(null);
  const [analysisProgress,setAP] = useState({ done:0, total:0 });
  const [oauth,setOauth]        = useState(null);
  const logsRef = useRef(null);
  const chatRef = useRef(null);

  const refreshOAuth = useCallback(async()=>setOauth(await fetchOAuthStatus()),[]);
  useEffect(()=>{ refreshOAuth(); },[refreshOAuth]);

  const log = useCallback((msg,type="sys") => {
    setLogs(p=>[...p,{msg,type,id:Math.random()}]);
    setTimeout(()=>{ if(logsRef.current) logsRef.current.scrollTop=logsRef.current.scrollHeight; },30);
  },[]);

  // ── INGEST ──────────────────────────────────────────────────────────────────

  const ingestConnector = async (srcId, mcpKey) => {
    log(`↗ Conectando ${srcId.toUpperCase()} vía OAuth/OpenAI connector...`, "tool");
    const mcp = MCPS[mcpKey];
    if (!mcp) { log(`  ${srcId}: conector no disponible`, "warn"); return []; }
    const items = [];
    let pageToken = null;
    let round = 0;
    try {
      do {
        const prompt = round===0
          ? `List/search available messages, emails, documents, calendar items or files from this authorized source. Return JSON with items array and next_page_token if available.`
          : `Continue listing. Page token: "${pageToken}". Return JSON with items array and next_page_token.`;
        const res = await callAI(INGEST_SYS, prompt, [mcp], 2000);
        const batch = res.items||res.messages||res.files||[];
        items.push(...batch.map(it=>({...it, source:srcId, ts:new Date(it.date||it.created_at||it.timestamp||0)})));
        setSources(p=>({...p,[srcId]:{...p[srcId],itemCount:items.length,status:"loading"}}));
        log(`  ${srcId}: ${items.length} elementos`,"data");
        pageToken = res.next_page_token||res.pageToken||null;
        round++;
        if (round>20) break;
      } while (pageToken);
      log(`✓ ${srcId}: ${items.length} elementos totales`,"ok");
    } catch(e) {
      log(`  ${srcId} error: ${e.message}`,"err");
    }
    return items;
  };

  const ingestFile = (srcId, file) => new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      const parser = parsers[srcId];
      if (!parser) { resolve([]); return; }
      const items = parser(text);
      log(`✓ ${file.name}: ${items.length} mensajes parseados`,"ok");
      resolve(items);
    };
    reader.readAsText(file, "utf-8");
  });

  const ingestPublicURL = async (src) => {
    log(`↗ Scraping público: ${src.label} @${src.handle}`, "tool");
    setUrlSrc(p=>p.map(s=>s.id===src.id?{...s,status:"loading"}:s));
    try {
      const sys = SCRAPE_SYS(src.platform, src.handle, src.url);
      const res = await callAI(sys,
        `Extract ALL public posts from @${src.handle} (${src.url}). Try available web search strategies.`,
        [], 3000, WEB_SEARCH_TOOL);
      const items = (res.items||[]).map(it=>({
        ts: new Date(it.date||Date.now()),
        sender: src.handle,
        content: it.content||"",
        source: src.platform,
        url: it.url||"",
        engagement: it.engagement||{}
      })).filter(m=>m.content&&!isNaN(m.ts));
      const quality = res.data_quality||"unknown";
      log(`✓ ${src.label} @${src.handle}: ${items.length} posts (calidad: ${quality})`, items.length>0?"ok":"warn");
      if (res.notes) log(`  → ${res.notes}`, "data");
      setUrlSrc(p=>p.map(s=>s.id===src.id?{...s,status:"done",found:items.length,quality}:s));
      return items;
    } catch(e) {
      log(`  ${src.label} error: ${e.message}`,"err");
      setUrlSrc(p=>p.map(s=>s.id===src.id?{...s,status:"error"}:s));
      return [];
    }
  };

  // ── ANALYSIS ────────────────────────────────────────────────────────────────

  const analyzeQuarter = async (period, msgs) => {
    const sample = sampleMessages(msgs, 80);
    const content = sample.map(m=>`[${new Date(m.ts).toISOString().slice(0,10)}] ${m.source}: ${(m.content||"").slice(0,200)}`).join("\n");
    const res = await callAI(PERIOD_SYS, `Period: ${period}\nMessage count: ${msgs.length}\nSample:\n${content}`, [], 1000);
    return { period, ...res, msg_count: msgs.length };
  };

  const run = async () => {
    setPhase("ingesting");
    setLogs([]);
    setErr(null);
    let allItems = [];
    await refreshOAuth();

    for (const src of SOURCE_DEFS.filter(s=>s.mcp)) {
      if (!sources[src.id].enabled) continue;
      const providerConnected = src.provider === "google" ? oauth?.providers?.google?.connected : src.provider === "microsoft" ? oauth?.providers?.microsoft?.connected : true;
      if (!providerConnected) {
        log(`  ${src.label}: OAuth no conectado. Pulsa Connect ${src.provider}.`, "warn");
        continue;
      }
      const items = await ingestConnector(src.id, src.mcpKey);
      allItems.push(...items);
    }

    for (const src of SOURCE_DEFS.filter(s=>!s.mcp)) {
      const files = sources[src.id].files||[];
      for (const file of files) {
        const items = await ingestFile(src.id, file);
        allItems.push(...items);
      }
    }

    const activeUrlSrcs = urlSources.filter(s=>s.enabled);
    if (activeUrlSrcs.length>0) {
      log(`\n▸ Scraping perfiles públicos (${activeUrlSrcs.length} fuentes)...`,"sys");
      for (const src of activeUrlSrcs) {
        const items = await ingestPublicURL(src);
        allItems.push(...items);
      }
    }

    allItems.sort((a,b)=>new Date(a.ts)-new Date(b.ts));
    setCorpus(allItems);
    log(`\n▸ Corpus total: ${allItems.length} elementos de ${new Set(allItems.map(i=>i.source)).size} fuentes`,"sys");
    if (allItems.length===0) { setErr("No se encontraron datos. Conecta OAuth o sube archivos."); setPhase("error"); return; }

    setPhase("analyzing");
    const quarters = groupByQuarter(allItems);
    setAP({ done:0, total:quarters.length });
    log(`\n▸ Análisis temporal: ${quarters.length} trimestres`,"sys");
    const series = [];
    for (let i=0;i<quarters.length;i++) {
      const [period, msgs] = quarters[i];
      log(`  Analizando ${period} (${msgs.length} msgs)...`,"tool");
      try {
        const point = await analyzeQuarter(period, msgs);
        series.push(point);
        setAP({ done:i+1, total:quarters.length });
        setTimeSeries([...series]);
      } catch(e) {
        log(`  ${period} error: ${e.message}`,"err");
      }
    }

    log(`\n▸ Detectando desencadenantes y patrones...`,"sys");
    try {
      const trig = await callAI(TRIGGER_SYS, `Time series data:\n${JSON.stringify(series)}`, [], 2000);
      setTriggers(trig);
      log(`✓ ${(trig.triggers||[]).length} desencadenantes · ${(trig.correlations||[]).length} correlaciones`,"ok");
    } catch(e) { log(`  Triggers error: ${e.message}`,"err"); }

    log(`\n▸ Sintetizando perfil profundo...`,"sys");
    try {
      const sample100 = sampleMessages(allItems, 100);
      const profileData = await callAI(PROFILE_SYS,
        `Time series (${series.length} quarters):\n${JSON.stringify(series)}\n\nSample corpus (${sample100.length} msgs):\n${sample100.map(m=>`[${new Date(m.ts).toISOString().slice(0,10)}] ${m.source}: ${(m.content||"").slice(0,150)}`).join("\n")}`,
        [], 3000);
      setProfile(profileData);
      log(`✓ Perfil sintetizado`,"ok");
    } catch(e) { log(`  Profile error: ${e.message}`,"err"); setErr(e.message); }

    setPhase("dashboard");
  };

  // ── CHAT ─────────────────────────────────────────────────────────────────────

  const sendChat = async () => {
    const msg = chatIn.trim();
    if (!msg||chatBusy||!profile) return;
    setChatIn(""); setChatBusy(true);
    const newHist = [...chatHist,{role:"user",content:msg}];
    setChatHist(newHist);
    setTimeout(()=>{ if(chatRef.current) chatRef.current.scrollTop=chatRef.current.scrollHeight; },30);
    try {
      const recent = timeSeries.slice(-4);
      const r = await fetch(API_URL,{ method:"POST", credentials:"include", headers:{"Content-Type":"application/json"}, body: JSON.stringify({
        model:MODEL, max_tokens:1200,
        system: FORECAST_SYS(profile, recent),
        messages: newHist.map(m=>({ role:m.role, content:m.content }))
      })});
      const data = await r.json();
      const text = data.content.filter(b=>b.type==="text").map(b=>b.text).join("");
      let parsed;
      try { const m=text.match(/\{[\s\S]*\}/); parsed=m?JSON.parse(m[0]):null; } catch {}
      const reply = parsed ? formatForecast(parsed) : text;
      setChatHist(p=>[...p,{role:"assistant",content:reply,raw:parsed}]);
    } catch(e) { setChatHist(p=>[...p,{role:"assistant",content:`Error: ${e.message}`}]); }
    finally { setChatBusy(false); setTimeout(()=>{ if(chatRef.current) chatRef.current.scrollTop=chatRef.current.scrollHeight; },50); }
  };

  function formatForecast(p) {
    const er = p.emotional_reaction||{};
    const lb = p.likely_behaviors||[];
    const ps = p.preventive_suggestions||[];
    const prob = p.probability_distribution||[];
    return [
      er.primary&&`**Reacción emocional:** ${er.primary}${er.secondary?` → ${er.secondary}`:""} (intensidad ${er.intensity||"?"}%, duración ~${er.duration_estimate||"?"})`,
      (p.cognitive_patterns_activated||[]).length&&`**Patrones cognitivos:** ${p.cognitive_patterns_activated.join(" · ")}`,
      lb.length&&`**Conductas probables:** ${lb.join(", ")}`,
      (p.regulatory_challenges||[]).length&&`**Desafíos de regulación:** ${p.regulatory_challenges.join(", ")}`,
      ps.length&&`**Estrategias preventivas:** ${ps.join(" | ")}`,
      prob.length&&`**Escenarios:**\n${prob.map(s=>`• ${s.scenario} (${Math.round((s.probability||0)*100)}%): ${s.outcome}`).join("\n")}`,
    ].filter(Boolean).join("\n\n");
  }

  const valenceColor = v => v>20?"#1D9E75":v<-20?"#E24B4A":"#EF9F27";

  // ── PHASE: CONFIG ─────────────────────────────────────────────────────────────

  if (phase==="config") return (
    <div style={{ padding:"1.5rem 0" }}>
      <div style={CT}>
        <i className="ti ti-dna-2" style={{ fontSize:24, color:"var(--color-text-secondary)" }} aria-hidden />
        <div>
          <h2 style={{ margin:0, fontSize:18, fontWeight:500 }}>Modelo psicológico computacional</h2>
          <p style={{ margin:0, fontSize:13, color:"var(--color-text-secondary)" }}>Análisis exhaustivo · Series temporales · Predicción conductual</p>
        </div>
      </div>

      <p style={{ fontSize:13, color:"var(--color-text-secondary)", margin:"1rem 0", lineHeight:1.65 }}>
        Conecta Google/Microsoft mediante OAuth o sube archivos exportados. El sistema construirá series temporales trimestrales e inferirá patrones, desencadenantes y predicciones.
      </p>

      <OAuthPanel oauth={oauth} refresh={refreshOAuth} />

      <p style={{ fontSize:11, fontWeight:500, color:"var(--color-text-tertiary)", margin:"0 0 8px", letterSpacing:"0.05em" }}>FUENTES CONECTADAS VÍA OAUTH + OPENAI CONNECTORS</p>
      {SOURCE_DEFS.filter(s=>s.mcp).map(src=>{
        const connected = src.provider === "google" ? oauth?.providers?.google?.connected : src.provider === "microsoft" ? oauth?.providers?.microsoft?.connected : false;
        return (
        <div key={src.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 14px", marginBottom:6, background:"var(--color-background-secondary)", borderRadius:"var(--border-radius-md)", border:"0.5px solid var(--color-border-tertiary)", opacity: connected?1:0.72 }}>
          <i className={`ti ${src.icon}`} style={{ fontSize:18, color:src.color, flexShrink:0 }} aria-hidden />
          <div style={{ flex:1 }}>
            <p style={{ margin:0, fontSize:13, fontWeight:500 }}>{src.label}</p>
            <p style={{ margin:0, fontSize:11, color:"var(--color-text-tertiary)" }}>{src.desc}</p>
          </div>
          <Tag color={connected?"var(--color-text-success)":"var(--color-text-warning)"} bg={connected?"var(--color-background-success)":"var(--color-background-warning)"}>{connected?"OAuth OK":"OAuth pendiente"}</Tag>
          <label style={{ display:"flex", alignItems:"center", gap:6, cursor:connected?"pointer":"not-allowed" }}>
            <input type="checkbox" checked={sources[src.id].enabled}
              disabled={!connected}
              onChange={e=>setSources(p=>({...p,[src.id]:{...p[src.id],enabled:e.target.checked}}))}
              style={{ width:14, height:14, accentColor:src.color }} />
            <span style={{ fontSize:11, color:"var(--color-text-secondary)" }}>activar</span>
          </label>
        </div>
      );})}

      <p style={{ fontSize:11, fontWeight:500, color:"var(--color-text-tertiary)", margin:"1rem 0 8px", letterSpacing:"0.05em" }}>ARCHIVOS EXPORTADOS</p>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(0,1fr))", gap:8 }}>
        {SOURCE_DEFS.filter(s=>!s.mcp).map(src=>{
          const count = sources[src.id].files?.length||0;
          return (
            <label key={src.id} style={{ display:"block", padding:"10px 12px", background:"var(--color-background-secondary)", borderRadius:"var(--border-radius-md)", border:`0.5px solid ${count?"var(--color-border-secondary)":"var(--color-border-tertiary)"}`, cursor:"pointer", position:"relative" }}>
              <input type="file" multiple accept={src.upload}
                style={{ position:"absolute",opacity:0,width:"100%",height:"100%",top:0,left:0,cursor:"pointer" }}
                onChange={e=>{ const files=Array.from(e.target.files); setSources(p=>({...p,[src.id]:{...p[src.id],files:files,enabled:files.length>0}})); }} />
              <i className={`ti ${src.icon}`} style={{ fontSize:16, color:count?src.color:"var(--color-text-tertiary)", display:"block", marginBottom:4 }} aria-hidden />
              <p style={{ margin:0, fontSize:12, fontWeight:count?500:400 }}>{src.label}</p>
              <p style={{ margin:"2px 0 0", fontSize:10, color:"var(--color-text-tertiary)" }}>{count?`${count} archivo${count>1?"s":""}`:src.upload}</p>
            </label>
          );
        })}
      </div>

      <p style={{ fontSize:11, fontWeight:500, color:"var(--color-text-tertiary)", margin:"1rem 0 8px", letterSpacing:"0.05em" }}>PERFILES PÚBLICOS (WEB SEARCH)</p>
      {urlSources.map((src,i)=>(
        <div key={src.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", marginBottom:6, background:"var(--color-background-secondary)", borderRadius:"var(--border-radius-md)", border:`0.5px solid ${src.enabled?"var(--color-border-secondary)":"var(--color-border-tertiary)"}` }}>
          <i className={`ti ${src.icon}`} style={{ fontSize:18, color:src.enabled?src.color:"var(--color-text-tertiary)", flexShrink:0 }} aria-hidden />
          <div style={{ flex:1, minWidth:0 }}>
            <p style={{ margin:0, fontSize:13, fontWeight:500 }}>{src.label}</p>
            <input value={src.url} onChange={e=>setUrlSrc(p=>p.map((s,j)=>j===i?{...s,url:e.target.value,handle:e.target.value.split("/").filter(Boolean).pop()||s.handle}:s))}
              style={{ fontSize:11, padding:"2px 6px", marginTop:3, width:"100%", background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:4 }} />
          </div>
          <label style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", flexShrink:0 }}>
            <input type="checkbox" checked={src.enabled} onChange={e=>setUrlSrc(p=>p.map((s,j)=>j===i?{...s,enabled:e.target.checked}:s))} style={{ width:13, height:13, accentColor:src.color }} />
            <span style={{ fontSize:11, color:"var(--color-text-secondary)" }}>activar</span>
          </label>
          <button onClick={()=>setUrlSrc(p=>p.filter((_,j)=>j!==i))} style={{ padding:"3px 6px", fontSize:11, background:"none", border:"none", color:"var(--color-text-tertiary)", cursor:"pointer" }}>
            <i className="ti ti-x" style={{ fontSize:13 }} aria-hidden />
          </button>
        </div>
      ))}
      <button onClick={()=>setUrlSrc(p=>[...p,{ id:`url_${Date.now()}`, platform:"twitter", label:"Nuevo perfil", icon:"ti-brand-x", color:"#888780", url:"https://x.com/usuario", handle:"usuario", enabled:true, status:"idle", found:0, quality:"" }])}
        style={{ fontSize:12, padding:"6px 12px", marginBottom:"1rem", display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}>
        <i className="ti ti-plus" style={{ fontSize:13 }} aria-hidden />Añadir perfil público
      </button>

      <div style={{ margin:"0.75rem 0 1.25rem", display:"flex", flexWrap:"wrap", gap:5 }}>
        {["OCEAN/Big Five","LIWC NLP","Sesgos cognitivos","Esquemas de Young","Apego (Bowlby)","Regulación emocional (Gross)","Locus de control","Series temporales","Análisis de desencadenantes"].map(f=><Tag key={f}>{f}</Tag>)}
      </div>

      <button onClick={run} style={{ width:"100%", padding:"11px 0", fontSize:14, fontWeight:500, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
        <i className="ti ti-player-play" style={{ fontSize:15 }} aria-hidden />
        Iniciar análisis completo ↗
      </button>
    </div>
  );

  if (phase==="ingesting"||phase==="analyzing") return (
    <div style={{ padding:"1.5rem 0" }}>
      <div style={{ ...CT, marginBottom:"1.25rem" }}>
        <i className="ti ti-loader" style={{ fontSize:20, color:"var(--color-text-secondary)", animation:"spin 1.2s linear infinite" }} aria-hidden />
        <div>
          <h2 style={{ margin:0, fontSize:17, fontWeight:500 }}>{phase==="ingesting"?"Ingesta de datos":"Análisis temporal"}</h2>
          {phase==="analyzing"&&<p style={{ margin:0, fontSize:12, color:"var(--color-text-secondary)" }}>Trimestre {analysisProgress.done}/{analysisProgress.total}</p>}
        </div>
      </div>
      {phase==="analyzing"&&(
        <div style={{ marginBottom:"1rem", height:4, background:"var(--color-border-tertiary)", borderRadius:2 }}>
          <div style={{ height:"100%", width:`${analysisProgress.total?Math.round(analysisProgress.done/analysisProgress.total*100):0}%`, background:"#1D9E75", borderRadius:2, transition:"width 0.4s" }} />
        </div>
      )}
      <div ref={logsRef} style={{ fontFamily:"var(--font-mono)", fontSize:12, lineHeight:1.9, padding:"14px 16px", background:"var(--color-background-secondary)", borderRadius:"var(--border-radius-md)", border:"0.5px solid var(--color-border-tertiary)", maxHeight:360, overflowY:"auto" }}>
        {logs.map(l=>(
          <div key={l.id} style={{ color:l.type==="err"?"var(--color-text-danger)":l.type==="ok"?"var(--color-text-success)":l.type==="tool"?"var(--color-text-info)":l.type==="data"?"var(--color-text-warning)":"var(--color-text-secondary)" }}>{l.msg}</div>
        ))}
        <span style={{ display:"inline-block", width:6, height:12, background:"var(--color-text-secondary)", opacity:0.6, animation:"blink 1s step-end infinite" }} />
      </div>
      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (phase==="error") return (
    <div style={{ padding:"1.5rem 0" }}>
      <h2 style={{ fontSize:17, fontWeight:500, color:"var(--color-text-danger)", margin:"0 0 8px", display:"flex", alignItems:"center", gap:8 }}>
        <i className="ti ti-alert-circle" style={{ fontSize:18 }} aria-hidden />Error
      </h2>
      <p style={{ fontSize:13, color:"var(--color-text-secondary)", marginBottom:"1rem" }}>{err}</p>
      <button onClick={()=>setPhase("config")}>← Volver</button>
    </div>
  );

  if (phase!=="dashboard"||!profile) return null;

  const TABS = [
    { id:"timeline",  label:"Series temporales", icon:"ti-timeline" },
    { id:"patterns",  label:"Patrones",          icon:"ti-brain" },
    { id:"profile",   label:"Perfil profundo",   icon:"ti-microscope" },
    { id:"predict",   label:"Predictor",         icon:"ti-wand" },
  ];

  const dateRange = corpus.length ? `${new Date(corpus[0].ts).getFullYear()} – ${new Date(corpus[corpus.length-1].ts).getFullYear()}` : "";
  const srcBreakdown = corpus.reduce((a,m)=>({...a,[m.source]:(a[m.source]||0)+1}),{});
  const lastQ  = timeSeries[timeSeries.length-1]||{};
  const prevQ  = timeSeries[timeSeries.length-2]||{};
  const deltaV = (lastQ.valence||0)-(prevQ.valence||0);
  const deltaS = (lastQ.stress||0)-(prevQ.stress||0);

  const TRAIT_CFG = {
    openness:{ label:"Apertura", color:"#1D9E75" },
    conscientiousness:{ label:"Responsabilidad", color:"#378ADD" },
    extraversion:{ label:"Extraversión", color:"#EF9F27" },
    agreeableness:{ label:"Amabilidad", color:"#D4537E" },
    neuroticism:{ label:"Neuroticismo", color:"#E24B4A" },
  };
  const radarData = Object.entries(TRAIT_CFG).map(([k,v])=>({ trait:v.label, value:Math.round(profile.ocean?.[k]?.score||0) }));

  return (
    <div style={{ padding:"1rem 0" }}>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:"1.25rem" }}>
        <Card style={{ textAlign:"center" }}><Chip label="elementos" val={corpus.length.toLocaleString()} color="#378ADD" /></Card>
        <Card style={{ textAlign:"center" }}><Chip label="trimestres" val={timeSeries.length} color="#1D9E75" /></Card>
        <Card style={{ textAlign:"center" }}><Chip label="fuentes" val={Object.keys(srcBreakdown).length} color="#EF9F27" /></Card>
        <Card style={{ textAlign:"center" }}><Chip label="período" val={dateRange} color="var(--color-text-secondary)" /></Card>
      </div>

      <div style={{ display:"flex", gap:3, marginBottom:"1.25rem", padding:4, background:"var(--color-background-secondary)", borderRadius:"var(--border-radius-md)", border:"0.5px solid var(--color-border-tertiary)" }}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{ flex:1, padding:"7px 4px", fontSize:11, fontWeight:tab===t.id?500:400, background:tab===t.id?"var(--color-background-primary)":"transparent", border:`0.5px solid ${tab===t.id?"var(--color-border-secondary)":"transparent"}`, borderRadius:"var(--border-radius-md)", cursor:"pointer", color:tab===t.id?"var(--color-text-primary)":"var(--color-text-secondary)", display:"flex", alignItems:"center", justifyContent:"center", gap:4 }}>
            <i className={`ti ${t.icon}`} style={{ fontSize:13 }} aria-hidden />{t.label}
          </button>
        ))}
      </div>

      {tab==="timeline"&&(
        <div>
          {deltaS>15&&(
            <div style={{ padding:"10px 14px", marginBottom:"1rem", borderRadius:"var(--border-radius-md)", background:"var(--color-background-danger)", border:"0.5px solid var(--color-border-danger)", display:"flex", alignItems:"center", gap:8 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize:16, color:"var(--color-text-danger)" }} aria-hidden />
              <span style={{ fontSize:13, color:"var(--color-text-danger)" }}>Estrés en ascenso: +{Math.round(deltaS)} pts respecto al trimestre anterior</span>
            </div>
          )}
          <Card style={{ marginBottom:12 }}>
            <p style={{ margin:"0 0 12px", fontSize:12, fontWeight:500, color:"var(--color-text-secondary)" }}>VALENCIA EMOCIONAL Y AROUSAL</p>
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={timeSeries} margin={{ top:5, right:10, bottom:5, left:-20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" />
                <XAxis dataKey="period" tick={{ fontSize:10, fill:"var(--color-text-tertiary)" }} />
                <YAxis domain={[-100,100]} tick={{ fontSize:10, fill:"var(--color-text-tertiary)" }} />
                <Tooltip contentStyle={{ fontSize:11, background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-secondary)" }} />
                <ReferenceLine y={0} stroke="var(--color-border-secondary)" />
                <Area type="monotone" dataKey="valence" stroke="#1D9E75" fill="#1D9E7522" strokeWidth={1.5} name="Valencia" />
                <Area type="monotone" dataKey="arousal" stroke="#378ADD" fill="#378ADD11" strokeWidth={1.5} name="Arousal" />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
          <Card style={{ marginBottom:12 }}>
            <p style={{ margin:"0 0 12px", fontSize:12, fontWeight:500, color:"var(--color-text-secondary)" }}>ESTRÉS · COMPLEJIDAD COGNITIVA · CONECTIVIDAD SOCIAL</p>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={timeSeries} margin={{ top:5, right:10, bottom:5, left:-20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" />
                <XAxis dataKey="period" tick={{ fontSize:10, fill:"var(--color-text-tertiary)" }} />
                <YAxis domain={[0,100]} tick={{ fontSize:10, fill:"var(--color-text-tertiary)" }} />
                <Tooltip contentStyle={{ fontSize:11, background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-secondary)" }} />
                <Line type="monotone" dataKey="stress" stroke="#E24B4A" strokeWidth={1.5} dot={false} name="Estrés" />
                <Line type="monotone" dataKey="cognitive_complexity" stroke="#7F77DD" strokeWidth={1.5} dot={false} name="Complejidad" />
                <Line type="monotone" dataKey="social_connectivity" stroke="#EF9F27" strokeWidth={1.5} dot={false} name="Sociabilidad" />
              </LineChart>
            </ResponsiveContainer>
          </Card>
          <Card style={{ marginBottom:12 }}>
            <p style={{ margin:"0 0 12px", fontSize:12, fontWeight:500, color:"var(--color-text-secondary)" }}>VOLUMEN DE COMUNICACIÓN</p>
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={timeSeries} margin={{ top:5, right:10, bottom:5, left:-20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" />
                <XAxis dataKey="period" tick={{ fontSize:10, fill:"var(--color-text-tertiary)" }} />
                <YAxis tick={{ fontSize:10, fill:"var(--color-text-tertiary)" }} />
                <Tooltip contentStyle={{ fontSize:11, background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-secondary)" }} />
                <Bar dataKey="msg_count" fill="#378ADD44" stroke="#378ADD" strokeWidth={0.5} name="Mensajes" radius={[2,2,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}

      {tab==="patterns"&&triggers&&(
        <div>
          <p style={{ fontSize:12, fontWeight:500, margin:"0 0 10px", color:"var(--color-text-secondary)" }}>DESENCADENANTES IDENTIFICADOS</p>
          {(triggers.triggers||[]).map((t,i)=>(
            <Card key={i} style={{ marginBottom:8 }}>
              <div style={{ ...CT, marginBottom:8 }}>
                <i className="ti ti-bolt" style={{ fontSize:15, color:"#EF9F27" }} aria-hidden />
                <span style={{ fontWeight:500, fontSize:13 }}>{t.name}</span>
                <Tag>{t.type}</Tag>
                <span style={{ marginLeft:"auto", fontSize:11, color:"var(--color-text-tertiary)" }}>{t.frequency}</span>
              </div>
              <p style={{ margin:"0 0 6px", fontSize:12, color:"var(--color-text-secondary)" }}><strong>Respuesta conductual:</strong> {t.behavioral_response}</p>
              {(t.antecedents||[]).length>0&&<p style={{ margin:"0 0 6px", fontSize:12, color:"var(--color-text-tertiary)" }}>Antecedentes: {t.antecedents.join(" → ")}</p>}
            </Card>
          ))}
        </div>
      )}

      {tab==="profile"&&(
        <div>
          <Card style={{ marginBottom:12 }}>
            <p style={{ margin:"0 0 6px", fontSize:12, fontWeight:500, color:"var(--color-text-secondary)" }}>SÍNTESIS CLÍNICA</p>
            <p style={{ margin:0, fontSize:13, lineHeight:1.7 }}>{profile.summary}</p>
          </Card>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
            <Card>
              <p style={{ margin:"0 0 8px", fontSize:12, fontWeight:500, color:"var(--color-text-secondary)" }}>OCEAN</p>
              <ResponsiveContainer width="100%" height={180}>
                <RadarChart data={radarData}>
                  <PolarGrid stroke="var(--color-border-tertiary)" />
                  <PolarAngleAxis dataKey="trait" tick={{ fontSize:10, fill:"var(--color-text-secondary)" }} />
                  <Radar dataKey="value" stroke="#1D9E75" fill="#1D9E75" fillOpacity={0.2} strokeWidth={1.5} />
                </RadarChart>
              </ResponsiveContainer>
            </Card>
            <Card>
              <p style={{ margin:"0 0 10px", fontSize:12, fontWeight:500, color:"var(--color-text-secondary)" }}>PUNTUACIONES</p>
              {Object.entries(TRAIT_CFG).map(([k,v])=>{
                const tr = profile.ocean?.[k]||{};
                return (
                  <div key={k} style={{ marginBottom:10 }}>
                    <div style={{ ...CT, marginBottom:3 }}>
                      <span style={{ fontSize:12 }}>{v.label}</span>
                      <span style={{ marginLeft:"auto", fontSize:13, fontWeight:500, color:v.color }}>{Math.round(tr.score||0)}</span>
                      <Tag>{tr.confidence||"?"}</Tag>
                    </div>
                    <MiniBar score={tr.score||0} color={v.color} />
                  </div>
                );
              })}
            </Card>
          </div>
          {(profile.cognitive_biases||[]).length>0&&(
            <Card style={{ marginBottom:10 }}>
              <p style={{ margin:"0 0 10px", fontSize:12, fontWeight:500, color:"var(--color-text-secondary)" }}>SESGOS COGNITIVOS DETECTADOS</p>
              {profile.cognitive_biases.map((b,i)=>(
                <div key={i} style={{ marginBottom:8 }}>
                  <div style={{ ...CT, marginBottom:3 }}><span style={{ fontSize:13, fontWeight:500 }}>{b.name}</span><Tag>{b.frequency}</Tag></div>
                  <p style={{ margin:0, fontSize:12, color:"var(--color-text-secondary)" }}>{b.impact}</p>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      {tab==="predict"&&(
        <div>
          <Card style={{ marginBottom:12 }}>
            <p style={{ margin:"0 0 10px", fontSize:12, fontWeight:500, color:"var(--color-text-secondary)" }}>ESTADO ACTUAL (ÚLTIMO TRIMESTRE)</p>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10 }}>
              {[
                { label:"Valencia",  val:lastQ.valence||0,  color:valenceColor(lastQ.valence||0), delta:deltaV },
                { label:"Estrés",    val:lastQ.stress||0,   color:"#E24B4A", delta:deltaS },
                { label:"Complejidad", val:lastQ.cognitive_complexity||0, color:"#7F77DD", delta:null },
              ].map(m=>(
                <div key={m.label} style={{ textAlign:"center" }}>
                  <div style={{ fontSize:22, fontWeight:500, color:m.color }}>{Math.round(m.val)}</div>
                  <div style={{ fontSize:11, color:"var(--color-text-secondary)" }}>{m.label}</div>
                  {m.delta!=null&&<div style={{ fontSize:10, color:m.delta>0&&m.label!=="Estrés"?"#1D9E75":m.delta>0&&m.label==="Estrés"?"#E24B4A":"#1D9E75" }}>{m.delta>0?"+":""}{Math.round(m.delta)} vs Q prev</div>}
                </div>
              ))}
            </div>
          </Card>
          <p style={{ fontSize:13, color:"var(--color-text-secondary)", margin:"0 0 10px", lineHeight:1.6 }}>Describe una situación para obtener una predicción granular de tu reacción emocional, cognitiva y conductual.</p>
          <div ref={chatRef} style={{ minHeight:60, maxHeight:400, overflowY:"auto", marginBottom:10 }}>
            {chatHist.length===0&&(
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                {["Un colega critica mi trabajo en público","Me ofrecen un cambio de trabajo con más riesgo","Un proyecto falla por causas externas","Tengo 3 semanas de mucho trabajo seguidas","Me invitan a una reunión social inesperada"].map(ex=>(
                  <button key={ex} onClick={()=>setChatIn(ex)} style={{ fontSize:11, padding:"5px 10px", cursor:"pointer", textAlign:"left" }}>{ex}</button>
                ))}
              </div>
            )}
            {chatHist.map((m,i)=>(
              <div key={i} style={{ marginBottom:10, display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start" }}>
                <div style={{ maxWidth:"88%", padding:"9px 12px", borderRadius:m.role==="user"?"12px 12px 3px 12px":"12px 12px 12px 3px", background:m.role==="user"?"var(--color-background-info)":"var(--color-background-secondary)", border:"0.5px solid var(--color-border-tertiary)", fontSize:12, lineHeight:1.7, color:m.role==="user"?"var(--color-text-info)":"var(--color-text-primary)", whiteSpace:"pre-wrap" }}>
                  {m.content}
                </div>
              </div>
            ))}
            {chatBusy&&<div style={{ padding:8, display:"flex", gap:4 }}>{[0,1,2].map(i=><div key={i} style={{ width:5,height:5,borderRadius:"50%",background:"var(--color-text-tertiary)",animation:`bounce 1s ${i*0.18}s ease-in-out infinite` }} />)}</div>}
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <input value={chatIn} onChange={e=>setChatIn(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendChat()} placeholder="Describe la situación..." style={{ flex:1, padding:"9px 12px", fontSize:13 }} disabled={chatBusy} />
            <button onClick={sendChat} disabled={chatBusy||!chatIn.trim()} style={{ padding:"9px 14px" }}><i className="ti ti-send" style={{ fontSize:15 }} aria-hidden /></button>
          </div>
        </div>
      )}

      <style>{`@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}`}</style>
    </div>
  );
}
