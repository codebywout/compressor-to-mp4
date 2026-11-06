# Video Compressor

Een desktopapplicatie voor het comprimeren van video's (o.a. `.ts`, `.mp4`, `.mov`, `.mkv`) naar MP4 met een maximale doelgrootte. Versie **1.3.0** voegt hardware-encoding (NVIDIA NVENC, AMD AMF, Intel QSV), automatische encoderselectie, adaptieve paralleliteit en een lichtere-jobs-eerst scheduler toe.

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

`npm run dist` maakt een schone Windows NSIS-installer in de map `release`, bijvoorbeeld `Video-Compressor-1.3.0-Setup.exe`. De installer toont het versienummer in het installatieprogramma en onder **Apps en onderdelen** als `Video Compressor 1.3.0`. Bij deïnstallatie verdwijnen programma (inclusief lokaal gedownloade FFmpeg), snelkoppelingen en registervermeldingen. Bij een **update** blijven snelkoppelingen en gebruikersinstellingen behouden.

De installer gebruikt het icoon uit `build/icon.ico` (bron: `assets/icon.svg`). FFmpeg wordt niet meegebundeld; bij automatische installatie belandt het rechtstreeks in de app-map (naast `VideoCompressor.exe`, of in de projectmap tijdens ontwikkeling) als `ffmpeg/` + `ffmpeg.json`.

De applicatie gebruikt FFmpeg met H.264/H.265 en AAC. CPU-encoding doet two-pass; hardware-encoders doen single-pass met retries tot de limiet. Auto kiest bij voorkeur NVENC (kwaliteit + snelheid); AMD AMF blijft handmatig beschikbaar. Paralleliteit kan handmatig (1–8) of automatisch. Originele bestanden worden nooit overschreven. Orphaned tijdelijke `vc-work-*`-mappen worden bij start opgeruimd.

## GitHub Releases en automatische updates

Je verspreidt **één** installer. Daarna publiceer je alleen nieuwe GitHub Releases; geïnstalleerde apps zoeken zelf naar updates.

Repo: [codebywout/compressor-to-mp4](https://github.com/codebywout/compressor-to-mp4)

### Zo werkt het voor gebruikers

1. Bij het starten (en elke 6 uur) controleert de app GitHub Releases.
2. Is er een nieuwere versie, dan verschijnt een dialoog: **Later** of **Nu updaten**.
3. Na download vraagt de app om te herstarten en installeert de update.
4. Er is geen nieuwe installer nodig voor bestaande gebruikers.

Updates werken alleen in de **geïnstalleerde** app, niet via `npm start`.

### Eerste installer (eenmalig)

```powershell
npm run dist
```

Verspreid `release\Video-Compressor-1.3.0-Setup.exe` (of de huidige versie). Publiceer die ook als GitHub Release (zie hieronder), zodat latere updates een startpunt hebben.

### Nieuwe versie uitbrengen (geen nieuwe installer rondsturen)

```powershell
npm run bump -- patch
git add -A
git commit -m "Release v1.3.1"
git tag v1.3.1
git push origin HEAD --tags
```

GitHub Actions bouwt de installer en zet `Video-Compressor-x.y.z-Setup.exe` + `latest.yml` online. Bestaande installaties vragen daarna zelf om te updaten.

Lokaal publiceren kan ook:

```powershell
$env:GH_TOKEN = "ghp_..."
npm run release -- patch --publish
```

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

Voeg bestanden toe via de bestandskiezer of drag-and-drop, ook buiten het sleepvlak. Selecteer een modus. **Comprimeren** gebruikt de ingestelde maximale grootte. **Converteren** probeert eerst stream-copy zonder hercodering; als de streams niet geschikt zijn voor de MP4-container, valt de applicatie automatisch terug op H.264/AAC. De MP4 wordt altijd in dezelfde map als het bronbestand gezet (`video.ts` → `video.mp4`); bestaat die naam al, dan wordt `video (1).mp4` gebruikt. Er is geen aparte uitvoermap. Start gebruikt de instellingen in het zijpaneel voor alle wachtende bestanden. Een doelgrootte die je op een bestand wijzigt, blijft voor dat bestand gelden tot je **Afwijkende doelgroottes wissen** kiest. Voltooide bestanden worden niet opnieuw verwerkt; gebruik **Opnieuw** op een kaart. Een lopend bestand annuleer je apart, of je stopt de hele batch. Een bestand dat bij de start niet gelezen kan worden, wordt alleen zelf als fout gemarkeerd. Kies **Auto** voor paralleliteit tenzij je handmatig wilt fine-tunen (1–8). Hogere waarden gebruiken meer CPU, RAM, VRAM en schijfruimte.

Bij het ontbreken van FFmpeg verschijnt bovenaan de installatiekaart. **Automatisch installeren** downloadt FFmpeg 9.0.2 vanaf de gecontroleerde GyanD GitHub-release, controleert SHA-256, valideert het archief en wijzigt de globale Windows PATH niet. **Installatie kiezen** laat je een bestaande map met `ffmpeg.exe` en `ffprobe.exe` selecteren. De gekozen locatie wordt opgeslagen in de user-configuratie. Bij een bestaande Windows-installatie wordt `where.exe` gebruikt om de werkelijke PATH-locaties te vinden. Als FFmpeg via WinGet is geïnstalleerd maar nog niet in de PATH van het proces staat, wordt ook de lokale `Gyan.FFmpeg`-pakketmap gecontroleerd en na succesvolle validatie opgeslagen. Alleen een map waarin beide programma's aanwezig zijn wordt geaccepteerd. De standaard `node_modules/electron/dist/resources/ffmpeg`-map wordt niet als FFmpeg-installatie verondersteld.

De FFmpeg-controle start asynchroon met de applicatie en heeft een timeout per extern proces. De status kan `checking`, `available`, `missing`, `invalid` of `error` zijn. Bestanden kunnen al tijdens `checking` of wanneer FFmpeg ontbreekt aan de wachtrij worden toegevoegd; metadata wordt dan later opnieuw gelezen zodra een compressie wordt gestart. Alleen het starten van de batch wordt geblokkeerd zolang geen geldige FFmpeg/FFprobe-installatie beschikbaar is.

De doelgrootte is een maximum. Door MP4-container-overhead, zeer korte video's, minimale FFmpeg-bitrates en complexe beelden kan een extreem kleine doelgrootte technisch onhaalbaar zijn. In dat geval wordt het item als fout gemarkeerd zonder originele bestanden aan te passen.

## Bekende beperkingen

- FFmpeg/FFprobe worden niet meegebundeld. Dit voorkomt distributie van een GPL-build zonder afzonderlijke licentie- en compliancecontrole. De automatische download gebruikt de door GyanD gepubliceerde build en SHA-256-hash; controleer de FFmpeg-licentievoorwaarden bij verdere distributie.
- De releasevalidatie (v1.3.0) is uitgevoerd met publieke sampleclips én representatieve gegenereerde media (1080p/4K, H.264/H.265, TS, speciale bestandsnamen). Auto blijft NVENC: AMF kan sneller zijn, maar meetbaar lagere SSIM/VMAF. Zeer strakke limieten kunnen op hardware-encoders onhaalbaar zijn; dat wordt als fout gemeld zonder corrupte output.
- Een extreem kleine, technisch onhaalbare doelgrootte wordt als fout gemarkeerd; er wordt geen misleidend succesvol resultaat gerapporteerd.
- `npm install` kan transitive advisories tonen vanuit Electron/Electron Builder. Controleer deze vóór distributie met `npm audit`; de packagingtooling is alleen als ontwikkeldependency opgenomen.
- `npm audit` meldt momenteel 6 moderate advisories in de `electron-builder`-dependencyboom rond `minimatch`. De voorgestelde automatische fix forceert een downgrade naar electron-builder 25.1.0 en is daarom niet toegepast.
- Bouw of publiceer opnieuw na elke versiewijziging (`npm run dist` of een GitHub tag). Updates werken alleen in de geïnstalleerde build, niet via `npm start`.
- Zonder codesignature kan Windows SmartScreen een waarschuwing tonen bij installatie/update; dat is verwacht zolang `signExecutable` uit staat.
