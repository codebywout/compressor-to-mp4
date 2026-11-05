# Video Compressor

Een desktopapplicatie voor het comprimeren van `.ts`-video's naar MP4 met een maximale doelgrootte.

## Installatie

1. Installeer [Node.js](https://nodejs.org/) 20 of nieuwer.
2. FFmpeg is optioneel: de applicatie kan de gecontroleerde Windows-build automatisch downloaden. Handmatig installeren blijft mogelijk via `winget install Gyan.FFmpeg.Shared` of via de knop **Installatie kiezen**.
3. Installeer dependencies en voer in deze map uit:

```powershell
npm install
npm start
```

## Bouwen en testen

```powershell
npm run typecheck
npm test
npm run build
npm run dist
```

`npm run dist` maakt een schone Windows NSIS-installer in de map `release`, bijvoorbeeld `Video-Compressor-1.2.0-Setup.exe`. De installer toont het versienummer in het installatieprogramma en onder **Apps en onderdelen** als `Video Compressor 1.2.0`. Bij deïnstallatie verdwijnen programma (inclusief lokaal gedownloade FFmpeg), snelkoppelingen en registervermeldingen.

De installer gebruikt het icoon uit `assets/icon.ico` / `build/icon.ico`. FFmpeg wordt niet meegebundeld; bij automatische installatie belandt het rechtstreeks in de app-map (naast `VideoCompressor.exe`, of in de projectmap tijdens ontwikkeling) als `ffmpeg/` + `ffmpeg.json`.

De applicatie gebruikt FFmpeg met H.264 en AAC, twee-pass encoding, `+faststart` en een veiligheidsmarge. Als een resultaat toch groter is dan de doelgrootte, wordt automatisch maximaal twee keer met een lagere videobitrate opnieuw gecodeerd. Originele bestanden worden nooit overschreven.

## GitHub Releases en automatische updates

De geïnstalleerde app controleert GitHub Releases via `electron-updater`. Gebruikers zien een updatebanner of klikken op het versienummer rechtsboven.

### Eenmalig koppelen

1. Maak een GitHub-repository aan en push deze code.
2. Koppel de repo-naam:

```powershell
npm run sync:repo -- jouw-github-user video-compressor
```

### Nieuwe versie uitbrengen

**Optie A — GitHub Actions (aanbevolen)**

```powershell
npm run bump -- minor
# noteer de nieuwe versie uit package.json, bv. 1.3.0
git add -A
git commit -m "Release v1.3.0"
git tag v1.3.0
git push origin HEAD --tags
```

De workflow `.github/workflows/release.yml` bouwt de Windows-installer en publiceert `Video-Compressor-x.y.z-Setup.exe`, `.blockmap` en `latest.yml` als GitHub Release.

**Optie B — lokaal publiceren**

```powershell
$env:GH_TOKEN = "ghp_..."   # classic token met repo-rechten
npm run release -- minor --publish
```

### Updaten bij gebruikers

1. App start of gebruiker klikt op het versienummer.
2. Bij een nieuwere release: **Download**.
3. Daarna **Herstart en installeer**.
4. Gebruikersdata blijft behouden; alleen de app-bestanden worden vervangen.

## Architectuur

- `src/core/probe.ts`: FFprobe metadata-analyse.
- `src/core/bitrate.ts`: MB- en bitrateberekening.
- `src/core/compressor.ts`: streaming two-pass FFmpeg-compressie, progress parsing en annulering.
- `src/core/updater.ts`: GitHub Releases via electron-updater.
- `src/main.ts` / `src/preload.ts`: veilige Electron IPC-laag.
- `src/renderer.ts`: dashboard, drag-and-drop, batchverwerking, updates en resultaten.
- `src/core/batch-manager.ts`: wachtrij, paralleliteit, foutisolatie en annulering per taak.
- `src/core/ffmpeg-provider.ts`: detectie, versie- en codecvalidatie, persistente selectie en checksum-gecontroleerde installatie.

## Gebruik

Voeg bestanden toe via de bestandskiezer of drag-and-drop, ook buiten het sleepvlak. Selecteer een modus. **Comprimeren** gebruikt de ingestelde maximale grootte. **Converteren** probeert eerst stream-copy zonder hercodering; als de streams niet geschikt zijn voor de MP4-container, valt de applicatie automatisch terug op H.264/AAC. De MP4 wordt altijd in dezelfde map als het bronbestand gezet (`video.ts` → `video.mp4`); bestaat die naam al, dan wordt `video (1).mp4` gebruikt. Er is geen aparte uitvoermap. Start gebruikt de instellingen in het zijpaneel voor alle wachtende bestanden. Een doelgrootte die je op een bestand wijzigt, blijft voor dat bestand gelden tot je **Afwijkende doelgroottes wissen** kiest. Voltooide bestanden worden niet opnieuw verwerkt; gebruik **Opnieuw** op een kaart. Een lopend bestand annuleer je apart, of je stopt de hele batch. Een bestand dat bij de start niet gelezen kan worden, wordt alleen zelf als fout gemarkeerd. Stel gelijktijdige taken bij voorkeur op `1`; hogere waarden gebruiken meer CPU, RAM en schijfruimte.

Bij het ontbreken van FFmpeg verschijnt bovenaan de installatiekaart. **Automatisch installeren** downloadt FFmpeg 9.0.2 vanaf de gecontroleerde GyanD GitHub-release, controleert SHA-256, valideert het archief en wijzigt de globale Windows PATH niet. **Installatie kiezen** laat je een bestaande map met `ffmpeg.exe` en `ffprobe.exe` selecteren. De gekozen locatie wordt opgeslagen in de user-configuratie. Bij een bestaande Windows-installatie wordt `where.exe` gebruikt om de werkelijke PATH-locaties te vinden. Als FFmpeg via WinGet is geïnstalleerd maar nog niet in de PATH van het proces staat, wordt ook de lokale `Gyan.FFmpeg`-pakketmap gecontroleerd en na succesvolle validatie opgeslagen. Alleen een map waarin beide programma's aanwezig zijn wordt geaccepteerd. De standaard `node_modules/electron/dist/resources/ffmpeg`-map wordt niet als FFmpeg-installatie verondersteld.

De FFmpeg-controle start asynchroon met de applicatie en heeft een timeout per extern proces. De status kan `checking`, `available`, `missing`, `invalid` of `error` zijn. Bestanden kunnen al tijdens `checking` of wanneer FFmpeg ontbreekt aan de wachtrij worden toegevoegd; metadata wordt dan later opnieuw gelezen zodra een compressie wordt gestart. Alleen het starten van de batch wordt geblokkeerd zolang geen geldige FFmpeg/FFprobe-installatie beschikbaar is.

De doelgrootte is een maximum. Door MP4-container-overhead, zeer korte video's, minimale FFmpeg-bitrates en complexe beelden kan een extreem kleine doelgrootte technisch onhaalbaar zijn. In dat geval wordt het item als fout gemarkeerd zonder originele bestanden aan te passen.

## Bekende beperkingen

- FFmpeg/FFprobe worden niet meegebundeld. Dit voorkomt distributie van een GPL-build zonder afzonderlijke licentie- en compliancecontrole. De automatische download gebruikt de door GyanD gepubliceerde build en SHA-256-hash; controleer de FFmpeg-licentievoorwaarden bij verdere distributie.
- De releasevalidatie is uitgevoerd met echte FFmpeg 9.0.2-testmedia: TS met en zonder audio, verschillende resoluties/framerates en MP4-invoer. De doelgroottes 5, 10, 25, 50 en 100 MB bleven onder de limiet.
- Een extreem kleine, technisch onhaalbare doelgrootte wordt als fout gemarkeerd; er wordt geen misleidend succesvol resultaat gerapporteerd.
- `npm install` kan transitive advisories tonen vanuit Electron/Electron Builder. Controleer deze vóór distributie met `npm audit`; de packagingtooling is alleen als ontwikkeldependency opgenomen.
- `npm audit` meldt momenteel 6 moderate advisories in de `electron-builder`-dependencyboom rond `minimatch`. De voorgestelde automatische fix forceert een downgrade naar electron-builder 25.1.0 en is daarom niet toegepast.
- Bouw of publiceer opnieuw na elke versiewijziging (`npm run dist` of een GitHub tag). Updates werken alleen in de geïnstalleerde build, niet via `npm start`.
- Zonder codesignature kan Windows SmartScreen een waarschuwing tonen bij installatie/update; dat is verwacht zolang `signExecutable` uit staat.
