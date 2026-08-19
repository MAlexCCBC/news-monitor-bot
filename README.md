# News Monitor Bot

Monitorizeaza canale Telegram,
filtreaza dupa keywords politice,
verifica sa nu fie duplicat/similar cu ce ai postat in ultimele 72h,
reformateaza cu AI in stilul tau, gaseste o imagine potrivita, si **iti trimite
tie privat pe Telegram** rezultatul gata pregatit.

**Postarea ramane 100% manuala** — botul NU posteaza nimic automat pe niciun canal.

---

## Ce trebuie sa faci, pas cu pas

### 1. Ia acces API Telegram (pentru citirea canalelor)

Mergi pe https://my.telegram.org, logheaza-te cu numarul tau, du-te la
**API Development Tools**, creeaza o aplicatie (orice nume). O sa primesti:
- `api_id`
- `api_hash`

Pune-le in `.env` (copiaza `.env.example` -> `.env` mai intai).

### 2. Creeaza botul de notificari (separat de contul tau)

Pe Telegram, cauta **@BotFather**, scrie `/newbot`, urmeaza pasii.
Primesti un token — pune-l in `.env` la `NOTIFY_BOT_TOKEN`.

Apoi cauta **@userinfobot**, scrie-i orice, iti da ID-ul tau de Telegram —
pune-l la `NOTIFY_CHAT_ID`. Trimite-i botului tau nou creat un `/start` mesaj
(altfel nu are voie sa-ti trimita el primul mesaj).

### 3. Ia cheile API rămase

- **Gemini**: https://aistudio.google.com/apikey -> `GEMINI_API_KEY`
- **Tavily**: din contul tau Tavily -> `TAVILY_API_KEY`

⚠️ **Important**: nu trimite niciodata aceste chei prin chat/mesaje. Pune-le
DOAR in `.env` local sau in variabilele de mediu din Railway. Daca ai trimis
vreo cheie cuiva sau ai postat-o undeva, regenereaz-o imediat din platforma respectiva.

### 4. Instaleaza si fă login o singură dată

```bash
npm install
npm run login
```

O sa-ti ceara numarul de telefon si codul SMS primit pe Telegram (contul tau
normal). La final iti da o linie `TG_SESSION=...` — copiaz-o in `.env`.

Asta se face **o singura data**. Dupa asta sesiunea ramane valida.

### 5. Verifică username-urile canalelor

In `.env`, la `CHANNELS`, pune username-urile exacte (fara @) ale celor 4
canale, asa cum apar in linkul canalului (ex: `t.me/g4media` -> `g4media`).

### 6. Rulează local ca test

```bash
npm start
```

Ar trebui sa primesti pe Telegram, de la botul tau, mesajul
"🤖 Bot pornit...". Lasă-l să ruleze și postează ceva pe unul din canale
(sau așteaptă o știre naturală) ca să vezi fluxul complet.

### 7. Pune-l pe Railway (gratuit, 24/7)

1. Creează cont pe [railway.app](https://railway.app)
2. New Project -> Deploy from GitHub repo (urcă acest folder pe un repo GitHub, privat!)
3. In Settings -> Variables, adaugă TOATE variabilele din `.env` (inclusiv
   `TG_SESSION` generat la pasul 4)
4. Deploy. Railway pornește automat `npm start`.

⚠️ Free tier-ul Railway are o limită lunară de ore — dacă botul rulează 24/7
tot timpul, verifică în dashboard să nu depășești planul gratuit. Dacă
depășești, următoarea opțiune ieftină e un VPS de ~5€/lună (Hetzner).

### 7b. (Alternativă) GitHub Actions

Proiectul are un workflow în `.github/workflows/bot.yml`. Pentru el, adaugă
TOATE variabilele din `.env` ca **GitHub Secrets** (Settings -> Secrets and
variables -> Actions), cu aceleași nume (incluzând `TG_SESSION`, `CHANNELS`,
`KEYWORDS`, `ROMANIAN_PERSONALITIES`, etc.), apoi rulează workflow-ul manual
din tab-ul Actions -> Bot -> Run workflow.

⚠️ **Limitări**: un job GitHub Actions se oprește automat după ~5-6 ore și
baza de date (`data.sqlite`) nu e persistentă între rulări — deci pentru 24/7
real e mai potrivit Railway/VPS, nu Actions.

---

## Cum funcționează fluxul (rezumat)

1. Botul ascultă mesajele din canale (contul tău normal, MTProto)
2. Când apare un mesaj cu link, extrage, curăță
3. Verifică dacă data e azi
4. Caută keywords (lista completă e în `.env`, o poți edita oricând)
5. Calculează embedding cu Gemini pe **titlu + primul paragraf** și compară cu
   ultimele 72h — dacă similaritatea trece de 80%, ignoră (sau te anunță scurt,
   ca să știi de ce a sărit)
6. Reformatează cu Gemini text (cascadă automată de modele dacă unul dă rate-limit)
7. Caută o imagine (Tavily, fallback DuckDuckGo), verifică raportul (3:4/9:16),
   decupează dacă e nevoie, verifică să nu fi fost folosită în ultimele 30 zile
8. Îți trimite ție privat, pe Telegram, tot pachetul: text formatat + imagine
9. **Tu decizi și postezi manual** pe canalul tău

## Ce poți edita ușor

- **Keywords**: `.env` -> `CHANNELS` / `KEYWORDS`
- **Stilul postării**: `src/ai/rewrite.js` -> `PROMPT_TEMPLATE`
- **Pragul de similaritate**: `.env` -> `SIMILARITY_THRESHOLD` (0.80 = 80%)
- **Selectoare HTML per site** (dacă un site își schimbă structura):
  `src/scraper/article.js` -> `SITE_CONFIG`

## Probleme comune

- **"Toate modelele text au eșuat"** → ai atins toate limitele Gemini pe ziua
  respectivă, verifică în consolă (link-ul pe care mi l-ai dat) și așteaptă
  resetarea limitelor (de obicei la miezul nopții UTC)
- **Nu găsește imagini** → verifică `TAVILY_API_KEY`, sau botul te anunță și
  poți căuta manual ca înainte
- **Un canal nu e detectat** → verifică username-ul exact din `.env` (fără @, fără spații)
