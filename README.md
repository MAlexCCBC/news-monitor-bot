# News Monitor Bot

Monitorizeaza canale Telegram,
filtreaza dupa keywords politice,
verifica articolele din linkuri fata de cele procesate in ultimele 24h,
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

- **Gemini**: https://aistudio.google.com/apikey -> `GEMINI_API_KEY` (embeddinguri, relevanță și arbitraj de similaritate)
- **OpenAI API**: https://platform.openai.com/api-keys -> `OPENAI_API_KEY` (redactare cu GPT-6 Luna, reasoning medium)
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
`KEYWORDS`, `ROMANIAN_PERSONALITIES`, `OPENAI_API_KEY`, etc.), apoi rulează workflow-ul manual
din tab-ul Actions -> Bot -> Run workflow.

⚠️ **Limitări**: un job GitHub Actions se oprește automat după ~5-6 ore și
baza de date (`data.sqlite`) este restaurată din branch-ul `data` și salvată
periodic plus la oprire. Ultimul interval nesalvat se poate pierde dacă runner-ul
este oprit forțat. Joburile sunt serializate pentru o singură sesiune Telegram.

---

## Cum funcționează fluxul (rezumat)

1. Botul ascultă mesajele din canale (contul tău normal, MTProto)
2. Când apare un mesaj cu link, extrage, curăță
3. Verifică publicarea în ultimele `ARTICLE_MAX_AGE_HOURS` (implicit 12 ore),
   inclusiv peste miezul nopții. Datele fără fus orar folosesc Europe/Bucharest.
   Lipsa unei date de publicare verificabile, o dată invalidă sau o dată în viitor
   blochează fluxul automat. `dateModified` și datele recomandărilor nu sunt
   dovezi de publicare. Vârsta se verifică din nou înainte de redactare și livrare;
   cererile de aprobare devenite vechi se închid. Linkurile manuale păstrează override-ul.
4. Caută keywords (lista completă e în `.env`, o poți edita oricând)
5. Calculează embedding cu Gemini pentru **titlu + întregul articol curățat**,
   în fragmente trimise într-un batch. Compară local cu vectorii salvați ai
   articolelor procesate în **ultimele 24 de ore**, inclusiv la reverificarea
   cererilor după restart. `HISTORY_HOURS` vechi nu mai modifică această fereastră.
   Istoricul nu se retrimite la Gemini. Scorul semantic este verificat cu
   dovezi despre eveniment din titlu și corp; pasajele de context comune nu
   sunt suficiente dacă începuturile articolelor descriu dezvoltări diferite.
   Candidații plauzibili sunt comparați de Gemini pe articolele complete, cu
   modelele Lite primele și fallback la restul modelelor text. Arbitrajul AI
   poate corecta duplicate false și duplicate ratate; dacă Gemini nu răspunde,
   verdictul local rămâne fallback. O posibilă repetare cere confirmare în chat.
   Procentul afișat este scor semantic, nu probabilitate de duplicat.
6. Reformatează cu GPT-6 Luna la reasoning medium; dacă nu există cheia OpenAI sau cererea eșuează, folosește cascada Gemini configurată.
7. Caută o imagine (Tavily -> Bing HTML -> Wikimedia Commons -> Wikipedia -> DuckDuckGo),
   verifică facial + anti-text cu AI, decupează la format portret 3:4 centrat pe față,
   evită refolosirea recentă
8. Îți trimite ție privat, pe Telegram, tot pachetul: text formatat + imagine
9. **Tu decizi și postezi manual** pe canalul tău

### Procesare manuală a unui link (fără filtrul de similaritate)

Trimite linkul articolului direct în chatul privat cu botul configurat la
`NOTIFY_CHAT_ID` (sau folosește `/start` pentru instrucțiuni). Botul confirmă
primirea și procesează linkul chiar dacă URL-ul a fost procesat anterior,
fără filtre de similaritate, dată, keywords sau relevanță. Textele generate
de AI nu se mai compară cu alte texte și nu li se mai calculează embeddings.
Această cale îți trimite rezultatul în privat; nu publică automat pe canal.

### Cereri de similaritate și restart

Comparația articolului-sursă este prezentată ca „Comparație între link-uri”, cu
ambele linkuri clickabile. Cererea pentru link expiră după 12 ore și se
salvează în SQLite împreună cu datele procesării și ID-ul mesajului Telegram.
La reverificare se actualizează comparația în același mesaj, dacă duplicatul
găsit s-a schimbat. Vechile texte AI blocate se eliberează la pornire, folosind
textul deja generat; nu se mai creează astfel de cereri. La upgrade, cererile
vechi pentru link din ultimele 12 ore se prelungesc și butoanele se retrimit.
Pe GitHub Actions, baza de date se restaurează și se salvează în branch-ul
`data`.

Butoanele „Procesează oricum” și „Ignoră” exprimă doar alegerea editorială.
Pentru feedback de similaritate, folosește „Știre diferită · procesează” sau
„Aceeași știre · ignoră”. Numai aceste clasificări explicite influențează
comparațiile viitoare. Deciziile deduse anterior din aprobări/ignorări rămân în
arhivă, dar nu mai sunt aplicate ca dovezi semantice.

Indiferent de `KEYWORDS`, sunt păstrate și știrile despre Mureșan, Bolojan,
PNL, USR și politică; setările existente rămân active în plus.

Pentru arbitrajul de similaritate Gemini încearcă mai întâi modelele Flash Lite,
cu cote zilnice mai mari, apoi fallbackurile disponibile pe cheia curentă.
Răspunsurile Gemini nu sunt folosite la redactarea principală dacă GPT-6 Luna
reușește.

## Ce poți edita ușor

- **Keywords**: `.env` -> `CHANNELS` / `KEYWORDS`
- **Stilul postării**: `src/ai/rewrite.js` -> `PROMPT_TEMPLATE`
- **Pragul de similaritate**: `.env` -> `SIMILARITY_THRESHOLD` (0.85 = 85%)
- **Vârsta maximă a știrilor**: `.env` -> `ARTICLE_MAX_AGE_HOURS` (12 implicit),
  sau variabila Actions cu același nume. O republicare de context vechi cu o dată
  nouă poate necesita în continuare verificare editorială și de similaritate.
- **Selectoare HTML per site** (dacă un site își schimbă structura):
  `src/scraper/article.js` -> `SITE_CONFIG`

## Probleme comune

- **"Toate modelele text au eșuat"** → ai atins toate limitele Gemini pe ziua
  respectivă, verifică în consolă (link-ul pe care mi l-ai dat) și așteaptă
  resetarea limitelor (de obicei la miezul nopții UTC)
- **Nu găsește imagini** → verifică `TAVILY_API_KEY`, sau botul te anunță și
  poți căuta manual ca înainte
- **Un canal nu e detectat** → verifică username-ul exact din `.env` (fără @, fără spații)
