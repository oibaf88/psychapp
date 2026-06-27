import fs from 'node:fs';

const file = 'PsycheDeep.jsx';
let code = fs.readFileSync(file, 'utf8');
let changed = false;

function replaceOnce(search, replacement, label) {
  if (code.includes(replacement)) return;
  if (!code.includes(search)) throw new Error(`patch-frontend: marker not found: ${label}`);
  code = code.replace(search, replacement);
  changed = true;
}

replaceOnce(
  'const API_URL = "/api/messages";\n',
  'const API_URL = "/api/messages";\nconst SCRAPE_URL = "/api/scrape-public";\n',
  'SCRAPE_URL constant'
);

replaceOnce(
  `async function callAI(system, userMsg, mcpList=[], maxTok=2000, tools=[]) {
  const body = {
    model: MODEL, max_tokens: maxTok,
    system,
    messages: [{ role:"user", content: userMsg }],
  };
  if (mcpList.length) body.mcp_servers = mcpList;
  if (tools.length)   body.tools       = tools;
  const r = await fetch(API_URL, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
  if (!r.ok) {
    const e = await r.json().catch(()=>({}));
    throw new Error(e.error?.message || e.message || \`HTTP \${r.status}\`);
  }
  const data = await r.json();
  const text = data.content.filter(b=>b.type==="text").map(b=>b.text).join("");
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON in response: "+text.slice(0,200));
  return JSON.parse(match[0]);
}
`,
  `async function callAI(system, userMsg, mcpList=[], maxTok=2000, tools=[]) {
  const body = {
    model: MODEL, max_tokens: maxTok,
    system,
    messages: [{ role:"user", content: userMsg }],
  };
  if (mcpList.length) body.mcp_servers = mcpList;
  if (tools.length)   body.tools       = tools;
  const r = await fetch(API_URL, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
  if (!r.ok) {
    const e = await r.json().catch(()=>({}));
    throw new Error(e.error?.message || e.message || \`HTTP \${r.status}\`);
  }
  const data = await r.json();
  const text = data.content.filter(b=>b.type==="text").map(b=>b.text).join("");
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON in response: "+text.slice(0,200));
  return JSON.parse(match[0]);
}

async function callPublicScraper(src) {
  const r = await fetch(SCRAPE_URL, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ platform:src.platform, handle:src.handle, url:src.url })
  });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error?.message || data.message || \`HTTP \${r.status}\`);
  return data;
}
`,
  'callPublicScraper helper'
);

const oldIngest = `  const ingestPublicURL = async (src) => {
    log(\`↗ Scraping público: \${src.label} @\${src.handle}\`, "tool");
    setUrlSrc(p=>p.map(s=>s.id===src.id?{...s,status:"loading"}:s));
    try {
      const sys = SCRAPE_SYS(src.platform, src.handle, src.url);
      const res = await callAI(sys,
        \`Extract ALL public posts from @\${src.handle} (\${src.url}). Try every strategy listed.\`,
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
      log(\`✓ \${src.label} @\${src.handle}: \${items.length} posts (calidad: \${quality})\`, items.length>0?"ok":"warn");
      if (res.notes) log(\`  → \${res.notes}\`, "data");
      setUrlSrc(p=>p.map(s=>s.id===src.id?{...s,status:"done",found:items.length,quality}:s));
      return items;
    } catch(e) {
      log(\`  \${src.label} error: \${e.message}\`,"err");
      setUrlSrc(p=>p.map(s=>s.id===src.id?{...s,status:"error"}:s));
      return [];
    }
  };
`;

const newIngest = `  const ingestPublicURL = async (src) => {
    log(\`↗ Scraping público real: \${src.label} @\${src.handle}\`, "tool");
    setUrlSrc(p=>p.map(s=>s.id===src.id?{...s,status:"loading"}:s));

    try {
      const res = await callPublicScraper(src);
      const items = (res.items||[]).map(it=>({
        ts: new Date(it.date||it.ts||Date.now()),
        sender: src.handle,
        content: it.content||"",
        source: it.source||src.platform,
        url: it.url||src.url,
        engagement: it.engagement||{},
        meta: it.meta||{}
      })).filter(m=>m.content&&!isNaN(m.ts));
      const quality = res.data_quality||"unknown";
      log(\`✓ scraper directo \${src.label}: \${items.length} elementos (calidad: \${quality})\`, items.length>0?"ok":"warn");
      if (res.notes) log(\`  → \${res.notes}\`, "data");
      if (items.length>0) {
        setUrlSrc(p=>p.map(s=>s.id===src.id?{...s,status:"done",found:items.length,quality}:s));
        return items;
      }
      log(\`  scraper directo sin datos útiles; fallback a OpenAI web_search\`, "warn");
    } catch(e) {
      log(\`  scraper directo falló: \${e.message}; fallback a OpenAI web_search\`, "warn");
    }

    try {
      const sys = SCRAPE_SYS(src.platform, src.handle, src.url);
      const res = await callAI(sys,
        \`Extract ALL public posts from @\${src.handle} (\${src.url}). Use web search. Return JSON only.\`,
        [], 3000, WEB_SEARCH_TOOL);
      const items = (res.items||[]).map(it=>({
        ts: new Date(it.date||Date.now()),
        sender: src.handle,
        content: it.content||"",
        source: src.platform,
        url: it.url||"",
        engagement: it.engagement||{}
      })).filter(m=>m.content&&!isNaN(m.ts));
      const quality = res.data_quality||"web_search";
      log(\`✓ OpenAI web_search \${src.label}: \${items.length} posts (calidad: \${quality})\`, items.length>0?"ok":"warn");
      if (res.notes) log(\`  → \${res.notes}\`, "data");
      setUrlSrc(p=>p.map(s=>s.id===src.id?{...s,status:"done",found:items.length,quality}:s));
      return items;
    } catch(e) {
      log(\`  \${src.label} error: \${e.message}\`,"err");
      setUrlSrc(p=>p.map(s=>s.id===src.id?{...s,status:"error"}:s));
      return [];
    }
  };
`;
replaceOnce(oldIngest, newIngest, 'ingestPublicURL');

replaceOnce(
  '          Usa web search para extraer posts públicos directamente desde la URL. Añade cualquier perfil público.',
  '          Primero intenta scraping server-side de HTML público; si no encuentra datos, usa OpenAI web_search como fallback. Añade cualquier perfil público.',
  'public scraping copy'
);

if (changed) fs.writeFileSync(file, code, 'utf8');
console.log(changed ? 'patch-frontend: applied' : 'patch-frontend: already applied');
