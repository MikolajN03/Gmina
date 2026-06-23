const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const BDL = 'https://bdl.stat.gov.pl/api/v1';

app.use(cors());
app.use(express.json());

// ─── CACHE ────────────────────────────────────────────────────────────────────
const cache = {
  units: null,
  unitsExpiry: 0,
  gmina: new Map(),   // unitId → { data, expiry }
  vars: null,         // lista zweryfikowanych zmiennych dla level 6
};
const TTL = {
  units: 24 * 3600 * 1000,
  gmina:  1 * 3600 * 1000,
  vars:  72 * 3600 * 1000,
};

// ─── GUS FETCH ────────────────────────────────────────────────────────────────
async function gusGet(path, retries = 3) {
  const url = `${BDL}${path}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'GminaPL/1.0' },
        timeout: 20000,
      });
      if (res.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── ZMIENNE POZIOMU GMINY ────────────────────────────────────────────────────
// Zweryfikowane zmienne które działają dla gminy (level 6).
// Odkryte przez /api/discover — nie zgadujemy, sprawdzamy.
const KNOWN_VARS = {
  pop:        72305,   // Ludność ogółem
  popM:       72306,   // Mężczyźni
  popF:       72307,   // Kobiety
  births:     456986,  // Urodzenia żywe
  deaths:     456987,  // Zgony
  migration:  148190,  // Saldo migracji (liczba jednostek pomocniczych - sprawdzić)
  regon:      64428,   // Podmioty REGON ogółem
  regonPriv:  64429,   // Podmioty REGON sektor prywatny
  unemployed: 461695,  // Bezrobotni zarejestrowani ogółem
  unemployedF:461696,  // Bezrobotni zarejestrowani kobiety
  income:     910268,  // Dochody własne gminy na 1 mieszkańca
  spending:   910269,  // Wydatki gminy na 1 mieszkańca
};

// ─── DISCOVERY ZMIENNYCH ──────────────────────────────────────────────────────
// Uruchom raz, wyniki trafiają do cache.vars
async function discoverVariables(testUnitId = '011212001011') {
  console.log('Discovering zmiennych dla level 6...');
  const working = {};

  // Testujemy wszystkie znane kandidaty + rozszerzony zakres
  const candidates = Object.entries(KNOWN_VARS);

  for (const [name, varId] of candidates) {
    try {
      await sleep(200);
      const data = await gusGet(`/data/by-unit/${testUnitId}?var-id=${varId}&format=json&lang=pl`);
      if (data.results && data.results.length > 0) {
        const values = data.results[0].values || [];
        const hasData = values.some(v => v.val !== null && v.val !== 0 && v.attrId !== 0);
        if (hasData) {
          working[name] = varId;
          const latest = values.filter(v => v.val !== null).slice(-1)[0];
          console.log(`  ✓ ${name} (${varId}): latest=${latest?.val} (${latest?.year})`);
        } else {
          console.log(`  ✗ ${name} (${varId}): brak danych`);
        }
      }
    } catch (e) {
      console.warn(`  ! ${name} (${varId}): ${e.message}`);
    }
  }

  console.log(`Discovery gotowe: ${Object.keys(working).length}/${candidates.length} zmiennych działa`);
  return working;
}

// ─── POBIERZ GMINY ────────────────────────────────────────────────────────────
async function fetchAllUnits() {
  console.log('Pobieranie listy gmin z GUS BDL...');
  const allUnits = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    const data = await gusGet(`/units?page=${page}&page-size=100&lang=pl&format=json`);
    const pageSize = data.pageSize || 10;
    totalPages = Math.ceil(data.totalRecords / pageSize);

    for (const u of data.results || []) {
      if (u.level === 6 && ['1','2','3'].includes(u.kind)) {
        allUnits.push({ id: u.id, name: u.name, kind: u.kind, parentId: u.parentId || '' });
      }
    }

    if (page % 100 === 0) console.log(`  Strona ${page+1}/${totalPages}, gmin: ${allUnits.length}`);
    page++;
    if (page < totalPages) await sleep(50);
  }

  console.log(`Pobrano ${allUnits.length} gmin.`);
  return allUnits;
}

// ─── POBIERZ DANE GMINY ───────────────────────────────────────────────────────
async function fetchGminaData(unitId) {
  // Upewnij się że mamy mapę działających zmiennych
  if (!cache.vars) {
    cache.vars = await discoverVariables();
  }

  const workingVarIds = Object.values(cache.vars);
  if (workingVarIds.length === 0) throw new Error('Brak zweryfikowanych zmiennych');

  // Pobierz wszystkie zmienne w jednym requeście (GUS obsługuje wiele var-id)
  const varQuery = workingVarIds.map(v => `var-id=${v}`).join('&');
  const data = await gusGet(`/data/by-unit/${unitId}?${varQuery}&format=json&lang=pl`);

  // Zbuduj mapę: varName → values[]
  const byId = {};
  for (const r of data.results || []) byId[r.id] = r.values || [];

  const result = { unitId, unitName: data.unitName || '', variables: {} };
  for (const [name, varId] of Object.entries(cache.vars)) {
    result.variables[name] = byId[varId] || [];
  }

  return result;
}

// ─── HELPERY ──────────────────────────────────────────────────────────────────
function latestVal(values) {
  if (!values || !values.length) return null;
  const sorted = [...values].filter(v => v.val !== null).sort((a, b) => b.year - a.year);
  return sorted[0] || null;
}

function trend(values, years = 5) {
  if (!values || values.length < 2) return null;
  const sorted = [...values].filter(v => v.val !== null).sort((a, b) => a.year - b.year);
  const recent = sorted.slice(-years);
  if (recent.length < 2) return null;
  const first = recent[0].val, last = recent[recent.length - 1].val;
  return first === 0 ? null : ((last - first) / first * 100).toFixed(1);
}

// ─── GENERUJ WSKAZÓWKI AI ─────────────────────────────────────────────────────
async function generateInsights(gminaName, stats) {
  const prompt = `Jesteś ekspertem od polskiej statystyki regionalnej. Przeanalizuj dane dla gminy "${gminaName}" i napisz 3-4 konkretne, przydatne wskazówki dla osoby rozważającej przeprowadzkę.

Dane:
- Populacja (najnowsza): ${stats.pop ?? 'brak'}
- Trend populacji 5 lat: ${stats.popTrend ?? 'brak'}%
- Urodzenia żywe (ostatni rok): ${stats.births ?? 'brak'}
- Zgony (ostatni rok): ${stats.deaths ?? 'brak'}
- Bezrobotni zarejestrowani: ${stats.unemployed ?? 'brak'}
- Podmioty REGON (firmy): ${stats.regon ?? 'brak'}
- Dochody własne gminy/mieszkańca: ${stats.income ?? 'brak'} zł
- Wydatki gminy/mieszkańca: ${stats.spending ?? 'brak'} zł

Napisz w stylu: konkretne, przydatne obserwacje (nie ogólniki). Jeśli danych brakuje, pomiń ten aspekt.
Format: JSON z polem "insights" będącym tablicą 3-4 obiektów { "title": "...", "text": "...", "type": "positive"|"neutral"|"warning" }.
Zwróć TYLKO JSON, bez żadnego markdown.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';

  try {
    return JSON.parse(text);
  } catch {
    // Próba wyciągnięcia JSON z tekstu
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { insights: [] };
  }
}

// ─── ENDPOINTY ────────────────────────────────────────────────────────────────

// GET /api/units?q=Konin
app.get('/api/units', async (req, res) => {
  try {
    if (!cache.units || Date.now() > cache.unitsExpiry) {
      cache.units = await fetchAllUnits();
      cache.unitsExpiry = Date.now() + TTL.units;
    }

    const q = (req.query.q || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (q.length < 2) return res.json({ results: [], total: 0 });

    const matches = cache.units.filter(u => {
      const n = u.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return n.startsWith(q) || n.includes(q);
    }).sort((a, b) => {
      const an = a.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const bn = b.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return an.startsWith(q) === bn.startsWith(q) ? an.localeCompare(bn) : an.startsWith(q) ? -1 : 1;
    });

    res.json({ results: matches.slice(0, 15), total: matches.length });
  } catch (e) {
    console.error('/api/units:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gmina/:id
app.get('/api/gmina/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^\d{12}$/.test(id)) return res.status(400).json({ error: 'Nieprawidłowe ID' });

  try {
    const cached = cache.gmina.get(id);
    if (cached && Date.now() < cached.expiry) return res.json(cached.data);

    const raw = await fetchGminaData(id);

    // Wylicz statystyki do wskazówek AI
    const popVals  = raw.variables.pop || [];
    const birthV   = raw.variables.births || [];
    const deathV   = raw.variables.deaths || [];
    const unempV   = raw.variables.unemployed || [];
    const regonV   = raw.variables.regon || [];
    const incomeV  = raw.variables.income || [];
    const spendV   = raw.variables.spending || [];

    const latestPop  = latestVal(popVals);
    const latestBirth= latestVal(birthV);
    const latestDeath= latestVal(deathV);
    const latestUnemp= latestVal(unempV);
    const latestRegon= latestVal(regonV);
    const latestInc  = latestVal(incomeV);
    const latestSpend= latestVal(spendV);

    const stats = {
      pop:       latestPop?.val,
      popTrend:  trend(popVals),
      births:    latestBirth?.val,
      deaths:    latestDeath?.val,
      unemployed:latestUnemp?.val,
      regon:     latestRegon?.val,
      income:    latestInc?.val,
      spending:  latestSpend?.val,
    };

    // Generuj wskazówki AI
    let insights = { insights: [] };
    try {
      insights = await generateInsights(raw.unitName || id, stats);
    } catch (e) {
      console.warn('AI insights error:', e.message);
    }

    const result = { ...raw, stats, insights: insights.insights || [] };
    cache.gmina.set(id, { data: result, expiry: Date.now() + TTL.gmina });
    res.json(result);

  } catch (e) {
    console.error(`/api/gmina/${id}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/discover — uruchom discovery zmiennych na żądanie
app.get('/api/discover', async (req, res) => {
  try {
    const unitId = req.query.unit || '011212001011';
    cache.vars = null; // wyczyść cache
    const vars = await discoverVariables(unitId);
    res.json({ working: vars, count: Object.keys(vars).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    unitsCache: cache.units?.length ?? 0,
    gminaCache: cache.gmina.size,
    varsDiscovered: cache.vars ? Object.keys(cache.vars) : null,
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GminaPL backend na porcie ${PORT}`);

  // Przy starcie: pobierz gminy i odkryj zmienne równolegle
  Promise.all([
    fetchAllUnits().then(u => {
      cache.units = u;
      cache.unitsExpiry = Date.now() + TTL.units;
      console.log(`Cache gmin: ${u.length}`);
    }),
    discoverVariables().then(v => {
      cache.vars = v;
      console.log(`Cache zmiennych: ${Object.keys(v).join(', ')}`);
    }),
  ]).catch(e => console.error('Błąd startu:', e.message));
});
