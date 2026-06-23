const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const BDL = 'https://bdl.stat.gov.pl/api/v1';

// Zezwól na requesty z każdej domeny (możesz zawęzić do swojej)
app.use(cors());

// --- CACHE ---
// Lista gmin jest pobierana raz i trzymana w pamięci przez 24h
// Nie ma sensu odpytywać GUS przy każdym wyszukaniu skoro gminy się nie zmieniają
const cache = {
  units: null,
  unitsExpiry: 0,
  data: new Map(), // cache danych gminy: unitId -> { data, expiry }
};

const UNITS_TTL  = 24 * 60 * 60 * 1000; // 24 godziny
const DATA_TTL   =  1 * 60 * 60 * 1000; // 1 godzina

// Pomocnik do fetch z GUS — dodaje nagłówki które GUS akceptuje
async function gusGet(path) {
  const url = `${BDL}${path}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'GminaPL/1.0 (kontakt@gminapl.pl)',
    },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`GUS odpowiedział ${res.status} dla ${url}`);
  return res.json();
}

// Pobierz WSZYSTKIE gminy (level 6) — paginuje przez cały BDL
async function fetchAllUnits() {
  console.log('Pobieranie listy gmin z GUS BDL...');
  const allUnits = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    const data = await gusGet(`/units?page=${page}&page-size=100&lang=pl&format=json`);
    const pageSize = data.pageSize || 10;
    totalPages = Math.ceil(data.totalRecords / pageSize);

    for (const u of (data.results || [])) {
      // Level 6 = gminy; kind 1=miejska, 2=wiejska, 3=miejsko-wiejska
      if (u.level === 6 && ['1','2','3'].includes(u.kind)) {
        allUnits.push({
          id: u.id,
          name: u.name,
          kind: u.kind,
          parentId: u.parentId || '',
        });
      }
    }

    if (page % 50 === 0) {
      console.log(`  Strona ${page + 1}/${totalPages}, gmin: ${allUnits.length}`);
    }
    page++;

    // Małe opóźnienie żeby nie przeciążać GUS
    if (page < totalPages) await new Promise(r => setTimeout(r, 50));
  }

  console.log(`Pobrano ${allUnits.length} gmin.`);
  return allUnits;
}

// --- ENDPOINT: lista gmin (z wyszukiwaniem) ---
// GET /api/units?q=Konin
app.get('/api/units', async (req, res) => {
  try {
    // Odśwież cache jeśli wygasł
    if (!cache.units || Date.now() > cache.unitsExpiry) {
      cache.units = await fetchAllUnits();
      cache.unitsExpiry = Date.now() + UNITS_TTL;
    }

    const q = (req.query.q || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (!q || q.length < 2) {
      return res.json({ results: [], total: 0 });
    }

    // Filtruj po nazwie
    const matches = cache.units.filter(u => {
      const name = u.name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return name.startsWith(q) || name.includes(q);
    });

    // Sortuj: najpierw te które zaczynają się od query
    matches.sort((a, b) => {
      const an = a.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const bn = b.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const aStarts = an.startsWith(q) ? 0 : 1;
      const bStarts = bn.startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return an.localeCompare(bn);
    });

    res.json({ results: matches.slice(0, 15), total: matches.length });
  } catch (err) {
    console.error('Błąd /api/units:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- ENDPOINT: dane gminy ---
// GET /api/gmina/:id  — populacja, bezrobocie, REGON z BDL
app.get('/api/gmina/:id', async (req, res) => {
  const { id } = req.params;

  // Walidacja ID (12 cyfr)
  if (!/^\d{12}$/.test(id)) {
    return res.status(400).json({ error: 'Nieprawidłowe ID gminy' });
  }

  try {
    // Cache danych gminy
    const cached = cache.data.get(id);
    if (cached && Date.now() < cached.expiry) {
      console.log(`Cache hit: ${id}`);
      return res.json(cached.data);
    }

    // Zmienne BDL dla poziomu gminy (level 6)
    // 72305 = ludność ogółem (działa na każdym poziomie)
    // 461695 = bezrobotni zarejestrowani ogółem (gminy)
    // 64428 = podmioty REGON ogółem
    // 461696 = bezrobotni zarejestrowani kobiety
    const VARS = [72305, 461695, 64428];

    // Pobierz dane dla każdej zmiennej osobno (GUS może ignorować wiele var-id naraz)
    const results = [];
    for (const varId of VARS) {
      try {
        const url = `/data/by-unit/${id}?var-id=${varId}&format=json&lang=pl`;
        console.log(`Fetching: ${url}`);
        const data = await gusGet(url);
        console.log(`  → unitName: "${data.unitName}", results: ${data.results?.length || 0}`);
        if (data.results && data.results.length > 0) {
          results.push(...data.results);
        }
      } catch (e) {
        console.warn(`  Zmienna ${varId} niedostępna: ${e.message}`);
      }
    }

    const combined = {
      unitId: id,
      results,
    };

    // Zapisz w cache
    cache.data.set(id, { data: combined, expiry: Date.now() + DATA_TTL });

    res.json(combined);
  } catch (err) {
    console.error(`Błąd /api/gmina/${id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- ENDPOINT: status serwera ---
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    unitsCache: cache.units ? cache.units.length : 0,
    unitsCacheExpiry: cache.unitsExpiry ? new Date(cache.unitsExpiry).toISOString() : null,
    dataCache: cache.data.size,
  });
});

// --- START ---
app.listen(PORT, () => {
  console.log(`GminaPL backend działa na porcie ${PORT}`);
  console.log(`  GET /api/units?q=Konin    — wyszukiwanie gminy`);
  console.log(`  GET /api/gmina/:id        — dane gminy`);
  console.log(`  GET /api/status           — status cache`);

  // Wstępne załadowanie listy gmin przy starcie
  fetchAllUnits()
    .then(units => {
      cache.units = units;
      cache.unitsExpiry = Date.now() + UNITS_TTL;
      console.log(`Cache gmin gotowy: ${units.length} gmin`);
    })
    .catch(err => console.error('Błąd wstępnego ładowania gmin:', err.message));
});
