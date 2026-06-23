# GminaPL Backend

Prosty proxy serwer do GUS Bank Danych Lokalnych (BDL API).

## Uruchomienie lokalnie

```bash
npm install
npm start
```

Serwer startuje na `http://localhost:3000`.

## Endpointy

```
GET /api/units?q=Konin       — wyszukiwanie gminy po nazwie
GET /api/gmina/042501011011  — dane statystyczne gminy (populacja, bezrobocie, REGON)
GET /api/status              — stan cache serwera
```

## Deployment na Railway (darmowy)

1. Załóż konto na https://railway.app (logowanie przez GitHub)
2. Kliknij **New Project → Deploy from GitHub repo**
3. Wskaż to repozytorium
4. Railway automatycznie wykryje Node.js i uruchomi `npm start`
5. W zakładce **Settings → Networking** kliknij **Generate Domain**
6. Gotowe — masz publiczny URL np. `https://gminapl-backend.up.railway.app`

## Deployment na Render (darmowy)

1. Załóż konto na https://render.com
2. **New → Web Service → Connect GitHub repo**
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Kliknij **Create Web Service**

## Deployment na Fly.io

```bash
npm install -g flyctl
flyctl auth login
flyctl launch
flyctl deploy
```

## Jak to działa

- Przy starcie serwer pobiera całą listę gmin z GUS BDL (~2500 rekordów, ~470 stron)
- Lista jest trzymana w pamięci przez 24 godziny, potem odświeżana
- Wyszukiwanie działa lokalnie na tej liście — zero opóźnień
- Dane statystyczne gminy (po kliknięciu) są pobierane na żywo z GUS i cache'owane na 1h
- Serwer dodaje nagłówki CORS żeby frontend mógł go odpytywać z przeglądarki
