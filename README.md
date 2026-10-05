# CodeAlong

CodeAlong pauser programmeringstutorialen din i Chrome når du begynner å skrive kode i VS Code, og starter den igjen når du er ferdig. Før videoen fortsetter, spoles den ca. 2 sekunder tilbake slik at du får med deg slutten av det instruktøren sa.

```
Du ser tutorialen ──► du begynner å skrive i VS Code ──► videoen pauses
                                                          │
          videoen fortsetter (−2 s) ◄── du er ferdig ◄────┘
          (idle i 5 s, Cmd/Ctrl+S, hurtigtast eller fokus på tutorialen)
```

Alt kjører lokalt. Det finnes ingen backend, ingen konto og ingen analytics, og kildekoden din sendes aldri noe sted. Bare signaler som «det ble skrevet» og «det ble lagret» går over en lokal forbindelse på `127.0.0.1`.

MVP-en består av:

- **Chrome-extension** (`packages/chrome`) som finner og styrer HTML5-videoen i fanen du velger å følge
- **VS Code-extension** (`packages/vscode`) som oppdager når du skriver og lagrer, og som eier tilstandsmaskinen
- **en lokal WebSocket** mellom dem

---

## Hurtigstart

```bash
npm install
npm run build            # bygger begge extensions
npm run package:vscode   # lager dist/codealong-vscode.vsix
```

**1. Installer VS Code-extensionen**

```bash
code --install-extension dist/codealong-vscode.vsix
```

Du kan også gå til VS Code → Extensions → `…` → *Install from VSIX…* og velge `dist/codealong-vscode.vsix`. Statuslinjen nederst til venstre viser deretter `CodeAlong: Waiting for Chrome`.

**2. Installer Chrome-extensionen**

1. Åpne `chrome://extensions`.
2. Slå på **Developer mode** (øverst til høyre).
3. Klikk **Load unpacked** og velg mappen `packages/chrome/dist`.
4. Fest gjerne CodeAlong-ikonet i verktøylinjen (puslespill-ikonet → nål).

Extension-ID-en blir alltid `golihbblpnhanlhgnnngcfhmolomajoo`, fordi den er låst med `key` i manifestet. VS Code godtar bare tilkoblinger fra denne ID-en.

**3. Følg en tutorial**

1. Åpne en tutorial (YouTube, Vimeo, Laracasts eller en annen side med HTML5-video).
2. Klikk CodeAlong-ikonet → **Follow this tab**. På sider utenom YouTube, Vimeo og Laracasts ber Chrome om tilgang til akkurat den siden.
3. Badgen på ikonet blir grønn (`ON`), og VS Code viser `CodeAlong: Tutorial Playing`.
4. Start videoen og begynn å skrive i VS Code.

---

## Hvordan det fungerer

| Hendelse | Hva CodeAlong gjør |
|---|---|
| Du endrer kode i VS Code mens tutorialen spiller | Pauser én gang, uansett hvor mange tastetrykk som følger. Statuslinjen viser `Coding...` |
| Du har ikke skrevet på *idle delay* sekunder (standard 5) | Spoler 2 s tilbake og fortsetter. Statuslinjen teller ned de siste sekundene |
| Du lagrer manuelt (Cmd/Ctrl+S) | Fortsetter ca. 1 s senere, med mindre du skriver videre. Auto-save ignoreres |
| Du går tilbake til tutorial-fanen (valgfritt, av som standard) | Fortsetter |
| Du pauser videoen selv | CodeAlong starter den **aldri** automatisk igjen |
| Du starter videoen selv mens du koder | CodeAlong lar den spille resten av kode-økten |
| Du spoler i videoen mens den er pauset av CodeAlong | Idle-timeren utsettes, og det blir ingen ekstra rewind (du har valgt posisjonen selv) |

### Manuell kontroll

| Handling | VS Code | Chrome (når Chrome har fokus) | Popup |
|---|---|---|---|
| Pause/fortsett tutorialen (brukerhandling, ingen rewind) | `Ctrl+Alt+P` | `Alt+Shift+P` | **Pause / Play** |
| «Jeg er ferdig», fortsett nå (med rewind) | `Ctrl+Alt+D` | `Alt+Shift+D` | **I'm done** |

Du kan også klikke på statuslinjen i VS Code for en meny (av/på, innstillinger, logg). Hurtigtastene kan endres under *Keyboard Shortcuts* (søk «CodeAlong») og i `chrome://extensions/shortcuts`.

### Innstillinger (VS Code → Settings → «CodeAlong»)

| Innstilling | Standard | |
|---|---|---|
| `codealong.enabled` | `true` | Hovedbryter |
| `codealong.pauseOnTyping` | `true` | Pause når du begynner å skrive |
| `codealong.resumeAfterIdle` | `true` | Fortsett når du har sluttet å skrive |
| `codealong.idleDelaySeconds` | `5` | Sekunder uten tastetrykk før du regnes som ferdig |
| `codealong.resumeOnSave` | `true` | Manuell lagring regnes som «ferdig» |
| `codealong.resumeOnTutorialFocus` | `false` | Fortsett når tutorial-fanen får fokus. Nyttig på én skjerm, men forstyrrende på flere |
| `codealong.rewindBeforeResume` | `true` | Spol tilbake før automatisk resume |
| `codealong.rewindSeconds` | `2` | Hvor langt tilbake |
| `codealong.debug` | `false` | Logg alle hendelser til Output → «CodeAlong» |
| `codealong.port` | `47390` | Lokal port. Må samsvare med porten i Chrome-popupen (*Advanced*) |
| `codealong.allowedChromeExtensionIds` | ID-en over | Hvilke Chrome-extensions som får koble til |

Alle innstillingene er brukernivå (`application`), slik at alle VS Code-vinduer oppfører seg likt.

---

## Arkitektur

```
┌──────────────────────────── Chrome ────────────────────────────┐     ┌──────────── VS Code (hvert vindu) ─────────────┐
│                                                                │     │                                                │
│  Tutorial-fanen (Active Tutorial)                               │     │  extension.ts                                  │
│  ┌──────────────────────────────┐                               │     │   • onDidChangeTextDocument → "edit"           │
│  │ content script (hver frame)  │  chrome.runtime               │     │   • manuell save → "save"                      │
│  │  FrameAgent: velger video    │◄──────────────┐               │     │   • kommandoer / hurtigtaster                  │
│  │  VideoController: hvem       │               │               │     │   • statuslinje                                │
│  │  pauset? pause/play/rewind   │               ▼               │     │                │                               │
│  └──────────────────────────────┘   ┌───────────────────────┐   │ WS  │   HubNode ─────┴─ leder (eier porten):         │
│        (også i iframes, f.eks.      │ service worker        │◄──┼─────┼──►  HubServer (127.0.0.1, auth)               │
│         player.vimeo.com)           │  Active Tutorial      │   │     │      CoreRunner ─► HubCore (state machine)    │
│                                     │  HubConnection        │   │     │                                                │
│  Popup: status, Follow, av/på       │  FrameTracker, fokus  │   │     │   … eller følger: sender "edit"/"save" til     │
│                                     └───────────────────────┘   │     │   lederen i et annet VS Code-vindu             │
└────────────────────────────────────────────────────────────────┘     └────────────────────────────────────────────────┘
```

### Ansvarsfordeling

- **VS Code er «hjernen».** `HubCore` (`packages/vscode/src/core/hubCore.ts`) er en ren, synkron tilstandsmaskin uten I/O og uten timere. Den tar inn hendelser (`edit`, `save`, `video`, `tutorialFocus`, `control`, `tick`, …) med tidspunkt, og returnerer effekter (`send`-kommando, `log`). Tid modelleres som *deadlines* i tilstanden (`idleDeadline`, `saveResumeAt`, ventende kommando). `CoreRunner` holder én timer for nærmeste deadline. En «foreldet» timer finner dermed rett og slett ingenting å gjøre, så sene idle-hendelser er umulige per konstruksjon.
- **Chrome er sannheten om videoen.** `VideoController` (`packages/chrome/src/content/videoController.ts`) vet hvem som pauset (`owner: 'codealong' | 'user'`). Hver pause/play/seek CodeAlong selv gjør, registreres som *forventet* før media-API-et kalles. Den tilhørende DOM-hendelsen svelges. Alle andre hendelser er per definisjon brukerens (eller sidens egen spiller). Derfor kan CodeAlong aldri forveksle en brukerpause med sin egen.
- **Resume er idempotent og trygt.** En CodeAlong-pause får en `pauseId`. Resume-kommandoen bærer den samme ID-en, og nettleseren nekter hvis videoen ikke fortsatt er pauset av CodeAlong med akkurat den ID-en. Om brukeren har trykket play, pauset selv, byttet video eller noe annet, gjøres ingenting.

### Tilstander (VS Code-statuslinjen)

`Off` → `Waiting for Chrome` → `Connected` (ingen tutorial) → `No video found` → `Tutorial Playing` ⇄ `Coding...` (pauset av CodeAlong) → `Paused – waiting for you` (hvis auto-resume er av) / `Tutorial Paused` (pauset av deg) / `Coding (video playing)` / `Tutorial Ended`

### Race conditions som er håndtert

| Situasjon | Løsning |
|---|---|
| Brukeren pauser, CodeAlong vil starte | Resume krever `owner === 'codealong'` og samme `pauseId`, sjekket i nettleseren mot faktisk tilstand |
| Brukeren starter videoen mens CodeAlong tror den er pauset | `play`-hendelsen er ikke forventet ⇒ `manual-play` ⇒ eierskap nullstilles, og auto-pause holdes av resten av økten |
| Idle-hendelse etter at tilstanden har endret seg | Deadlines i tilstanden, ikke løse timere. Resume sjekker eierskap på begge sider |
| Mange save- og typing-hendelser ⇒ mange play | Maks én pause/resume i flukt (`pending`, 3 s timeout). Duplikat-resume avvises av `pauseId` |
| Lagring midt i skrivingen | Save venter 1 s. Ny typing avbryter |
| Brukeren og CodeAlong trykker samtidig | Hurtigtasten sender `userToggle`, som avgjøres i nettleseren mot faktisk tilstand, ikke mot VS Codes kopi |
| Kommando til en frame som har forsvunnet | Rapporteres som `command-failed`. Ny primær frame velges |

### Lokal kommunikasjon og sikkerhet

- VS Code lytter på `127.0.0.1:47390`, aldri på nettverkskort. Chromes service worker er klient, siden extensions ikke kan lytte på porter.
- **Hvem får koble til:**
  - Forespørsler med `Origin`-header kommer fra en nettleser. Bare `chrome-extension://golihbblpnhanlhgnnngcfhmolomajoo` slipper inn, og alt annet avvises med 403 *før* WebSocket-handshaken. Nettsider kan ikke forfalske `Origin`, så en vilkårlig side du har åpen kan verken koble til eller styre noe (dette er også testet i ekte Chromium).
  - Forespørsler *uten* `Origin` (lokale prosesser) må være et annet VS Code-vindu og oppgi tokenet i `~/.codealong/editor-token` (filrettigheter `0600`, lesbar bare for din bruker).
  - `Host` må være `127.0.0.1` eller `localhost` (beskyttelse mot DNS-rebinding).
- Protokollen har versjon og handshake (`hello` → `welcome`). Hver melding valideres, og maks størrelse er 16 KB.
- Bare én nettleser-tilkobling er aktiv om gangen. En nyere (f.eks. etter at service workeren er startet på nytt) erstatter den gamle.
- **Tillatelser i Chrome:** `storage`, `scripting`, `activeTab`, `alarms` og vertstilgang bare til YouTube, Vimeo og Laracasts. Andre sider spørres om én og én når du klikker *Follow this tab*.
- **Hvilke data sendes:** aktivitetstype (`edit`/`save`), videostatus (spiller/pauset/eier/tid) og fanens tittel. Aldri kode, filnavn eller innhold.

### Robusthet

| Scenario | Oppførsel |
|---|---|
| Chrome starter før VS Code | Service workeren prøver igjen med backoff (1 → 10 s). Agentens heartbeat og en `chrome.alarms`-alarm vekker den om Chrome har stoppet den |
| VS Code starter før Chrome / reloades | Chrome kobler til når den finner huben. En CodeAlong-pause «adopteres» og fortsettes etter én idle-periode |
| Flere VS Code-vinduer | Første vindu blir *leder* (eier porten). De andre blir *følgere* og videresender typing. Lukkes lederen, tar en følger over automatisk |
| Chrome stopper service workeren (MV3) | Tilstanden ligger i `chrome.storage`, og agenter i siden vekker den. Testet i ekte Chromium |
| Chrome-extensionen reloades | Aktiv tutorial gjenopprettes, og nye agenter injiseres. CodeAlongs pause gjenkjennes via `data-codealong-pause` på `<video>` |
| Tutorial-fanen lukkes / du følger en annen fane | Den gamle fanen slippes og styres ikke lenger |
| Flere videoer på siden | Velger videoen som spiller, ellers den største synlige. Valget er «klebrig», så en liten hover-preview kan ikke stjele kontrollen |
| Video i iframe (Laracasts → Vimeo) | Agenten kjører i alle frames, og service workeren velger framen med tutorial-videoen |
| YouTube SPA-navigasjon / ny video | `emptied` nullstiller eierskap, så en ny video startes aldri av en gammel pause |
| Videoen er ferdig | `ended` behandles ikke som brukerpause, og den pauses eller startes ikke |
| `play()` blir avvist (autoplay-regler) | Eierskapet gis tilbake til brukeren, uten nye forsøk |
| Remote-utvikling (SSH/WSL/containere) | VS Code-extensionen kjører alltid lokalt (`extensionKind: ["ui"]`), så Chrome når den |
| Endringer i andre dokumenter enn det aktive, i ufokusert vindu, i output/git/settings | Teller ikke. Formatters, git-checkout og AI-agenter som redigerer i bakgrunnen pauser ikke videoen |

---

## Utvikling

```bash
npm install
npm run watch      # esbuild i watch-modus for begge extensions
```

- **VS Code-extensionen:** Åpne repoet i VS Code og trykk **F5** («Run CodeAlong (VS Code extension)»). Et nytt vindu starter med extensionen lastet fra kildekoden.
- **Chrome-extensionen:** Last `packages/chrome/dist` som unpacked (se over) og klikk ↻ på `chrome://extensions` etter endringer. Logger: *service worker*-lenken på extension-kortet (bakgrunn), DevTools i tutorial-fanen (content script, prefiks `[CodeAlong]`), og popupen → *Advanced* → *Debug logging* (viser de siste hendelsene).
- **VS Code-logg:** Slå på `codealong.debug` og åpne Output → «CodeAlong». Eksempel:

  ```
  20:14:02 TYPING_STARTED
  20:14:02 PAUSE_REQUESTED
  20:14:02 VIDEO_PAUSED_BY_CODEALONG
  20:14:09 FILE_SAVED
  20:14:10 TYPING_IDLE
  20:14:10 AUTO_RESUME (reason=save rewind=2s)
  20:14:10 VIDEO_RESUMED
  ```

  Andre hendelser: `VIDEO_PLAYING`, `MANUAL_PAUSE`, `MANUAL_PLAY`, `VIDEO_SEEKED`, `VIDEO_ENDED`, `VIDEO_CHANGED`, `CONNECTION_LOST`, `CONNECTION_RESTORED`, `ADOPTED_CODEALONG_PAUSE`, `SAVE_RESUME_CANCELLED`, `PAUSE_SKIPPED`, `COMMAND_TIMEOUT`, … Kildekode logges aldri. Med flere VS Code-vinduer skrives hendelsene i vinduet som er hub (leder).

### Prosjektstruktur

```
packages/
  protocol/   meldingstyper, validering, konstanter (delt av begge)
  vscode/     VS Code-extension
    src/core/hubCore.ts      tilstandsmaskinen (ren, testbar)
    src/hub/                 server, leder/følger, timer-runner, token
    src/activity.ts          hva som teller som «brukeren koder»
  chrome/     Chrome-extension (MV3)
    src/background/          service worker: aktiv tutorial, tilkobling, frames
    src/content/             agent + VideoController
    src/popup/, static/      popup og manifest
test/         system-tester (hub ⇄ ekte WebSocket ⇄ Chrome-kode ⇄ falsk video)
e2e/          ekte Chromium med extensionen lastet, og ekte VS Code
scripts/      build (esbuild) og ikon-generering
```

---

## Testing

```bash
npm run check        # typecheck + lint + unit-/integrasjonstester + build
npm test             # bare testene (Vitest)
```

**Enhetstester og integrasjonstester** (`npm test`, ca. 5 s):

- `hubCore.test.ts`: tilstandsmaskinen. Pause én gang, idle/save/fokus-resume, brukerpause respekteres, sene idle-hendelser, timeouts, reconnect, adopsjon, seek, av/på.
- `videoController.test.ts`: eierskap, rewind (≥ 0), duplikat-resume, seek, `ended`, ny kilde, avvist `play()`, gjenoppretting etter reload.
- `server.test.ts`: tilgangskontroll mot ekte WebSocket. Feil `Origin`, DNS-rebinding, token, protokollversjon, erstatning av tilkobling.
- `test/fullLoop.test.ts`: hele kjeden over ekte WebSocket, inkludert at et annet VS Code-vindu tar over og at Chrome starter før VS Code.

**Ekte Chromium med extensionen** (`npm run test:e2e`, ca. 15 s). Første gang trengs `npx playwright install chromium`. Testen laster `packages/chrome/dist` i Chromium og peker `www.youtube.com` og `player.vimeo.com` til en lokal HTTPS-server, slik at de statiske content scriptene kjører som på de ekte sidene. Den dekker:

- Follow, pause ved typing og resume med cirka 2 s rewind
- At brukerpause respekteres
- Hurtigtast
- At andre faner og en «decoy»-video ikke styres
- At en nettside ikke får koble til huben
- Video i cross-origin iframe
- At lukking av fanen slipper tutorialen
- At Chrome kan stoppe service workeren
- Restart av huben

**Ekte VS Code** (`npm run test:vscode`). Laster ned en VS Code-build første gang, eller bruker en installert:

```bash
CODEALONG_VSCODE="/Applications/Visual Studio Code.app/Contents/MacOS/Electron" npm run test:vscode
```

Testen kjører extensionen i en isolert VS Code-profil og verifiserer:

- Aktivering og kommandoer
- At typing pauser, uten duplikater
- Idle-resume med rewind
- At bakgrunnsendringer ignoreres
- Hurtigtast
- At brukerpause respekteres
- At manuell lagring gir resume

### Manuell sjekkliste

1. Følg en YouTube-tutorial. Badgen viser `ON`, og VS Code viser `Tutorial Playing`.
2. Skriv i en fil. Videoen pauses straks (badge `II`, `Coding...`).
3. Slutt å skrive. Etter ~5 s fortsetter videoen fra ~2 s tidligere.
4. Skriv, og trykk Cmd/Ctrl+S. Videoen fortsetter etter ~1 s.
5. Pause videoen selv i YouTube, og skriv. Den forblir pauset.
6. Trykk `Ctrl+Alt+P` i VS Code. Videoen starter og stopper uten å bytte vindu.
7. Ha Chrome og VS Code på hver sin skjerm. Alt over virker uten å klikke i Chrome.
8. Lukk VS Code og åpne igjen. Chrome kobler til på nytt (`…` → `ON`).

---

## Kjente begrensninger

- **Ikke publisert i Chrome Web Store.** Extensionen må lastes som unpacked (Developer mode). Chrome 137+ tillater ikke lenger `--load-extension` i vanlig Chrome, så automatiserte tester bruker Playwrights Chromium.
- **Bare HTML5 `<video>`.** Videoer i *closed* Shadow DOM, i canvas/WebGL eller i spillere som ikke bruker `<video>` blir ikke funnet. Spillere som bevisst «slåss» mot programmatisk play/pause kan i verste fall pause igjen selv. CodeAlong behandler det da som en brukerpause og starter aldri videoen.
- **DRM-beskyttet video** (f.eks. noen Udemy-kurs) kan styres (pause/play/tid), men er ikke testet bredt.
- **Testet mot ekte YouTube** (pause, resume med rewind, brukerpause og YouTubes egen knapp i synk) i Chromium. Vimeo og Laracasts er testet med lokale sider som etterligner oppsettet (cross-origin iframe), men ikke mot de ekte sidene.
- **Cross-origin iframes på «ukjente» sider:** Tilgang gis bare til sidens egen origin. Ligger videoen i en iframe fra et annet domene (ikke YouTube eller Vimeo), blir den ikke funnet.
- **Iframes som dukker opp senere** på ukjente sider får ikke agent før siden lastes på nytt. På YouTube, Vimeo og Laracasts skjer det automatisk.
- **Idle er en heuristikk.** Tenker du lenge uten å skrive, fortsetter videoen. Juster `idleDelaySeconds`, slå av `resumeAfterIdle` og bruk lagring/hurtigtast, eller trykk `Ctrl+Alt+P` for å pause igjen (det er da en brukerpause som ikke fortsettes automatisk).
- **Alle filer teller.** MVP-en vet ikke hvilke filer som hører til tutorialen. All skriving i den aktive editoren (i et fokusert VS Code-vindu) teller. Filtreringen ligger samlet i `packages/vscode/src/activity.ts`, så den kan gjøres smartere senere.
- **Chrome-hurtigtastene virker bare når Chrome har fokus.** Bruk VS Code-hurtigtastene når du koder.
- **Én Chrome-profil om gangen.** Huben godtar én nettleser-tilkobling, og den nyeste vinner.
- **Porten må være lik** i VS Code (`codealong.port`) og i Chrome-popupen (*Advanced*) hvis du endrer den.
- Bare Chrome og VS Code (testet med VS Code 1.95). VS Code-varianter som Cursor bør fungere med samme `.vsix`, men er ikke testet. Ikke Firefox, Safari, JetBrains eller Neovim.
