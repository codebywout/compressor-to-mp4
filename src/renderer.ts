type BatchItem = import("./shared/types").BatchItem;
type CompressionResult = import("./shared/types").CompressionResult;
type CompressionSettings = import("./shared/types").CompressionSettings;
type FfmpegStatus = import("./core/ffmpeg-provider").FfmpegStatus;
type UpdateState = import("./core/updater").UpdateState;

type QueueFilter = "all" | "active" | "done" | "problem";
type ToastTone = "info" | "ok" | "error";

interface Preferences {
  mode?: "compress" | "convert";
  targetMb?: number;
  concurrency?: number;
  audioBitrate?: string;
  videoCodec?: string;
  preset?: string;
  resolution?: string;
  frameRate?: string;
  keepAudio?: boolean;
  advanced?: boolean;
}

const STORAGE_KEY = "video-compressor.preferences.v1";
const STATUS_LABEL = { queued: "Wachtend", running: "Bezig", completed: "Voltooid", failed: "Fout", cancelled: "Geannuleerd" } as const;

const items = new Map<string, BatchItem>();
const dismissed = new Set<string>();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let batchRunning = false;
let queueFilter: QueueFilter = "all";
let ffmpegReady = false;
let ffmpegState: FfmpegStatus["state"] = "checking";
let installing = false;
let reprobeRunning = false;
let summaryKey = "";

function getApi(): Window["videoCompressor"] {
  if (!window.videoCompressor) throw new Error("De preload-API is niet geladen. Start de applicatie opnieuw.");
  return window.videoCompressor;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  if (total < 5) return "bijna klaar";
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  if (minutes >= 60) return `nog ${Math.floor(minutes / 60)} u ${minutes % 60} min`;
  if (minutes > 0) return `nog ${minutes} min ${remainder} s`;
  return `nog ${remainder} s`;
}

function toast(message: string, tone: ToastTone = "info"): void {
  const host = $("toasts");
  const element = document.createElement("div");
  element.className = `toast ${tone}`;
  element.setAttribute("role", "status");
  element.textContent = message;
  host.append(element);
  while (host.children.length > 4) host.firstElementChild?.remove();
  window.setTimeout(() => element.remove(), 4600);
}

function currentMode(): CompressionSettings["mode"] {
  const checked = document.querySelector<HTMLInputElement>('input[name="processing-mode"]:checked');
  return checked?.value === "convert" ? "convert" : "compress";
}

function readSettings(): CompressionSettings {
  const targetRaw = Number($<HTMLInputElement>("target-mb").value);
  const frame = $<HTMLSelectElement>("framerate").value;
  return {
    mode: currentMode(),
    targetMb: Number.isFinite(targetRaw) && targetRaw > 0 ? targetRaw : 50,
    videoCodec: $<HTMLSelectElement>("video-codec").value as CompressionSettings["videoCodec"],
    audioBitrateKbps: Number($<HTMLSelectElement>("audio-bitrate").value),
    resolution: $<HTMLSelectElement>("resolution").value as CompressionSettings["resolution"],
    frameRate: frame === "original" ? "original" : Number(frame),
    preset: $<HTMLSelectElement>("preset").value as CompressionSettings["preset"],
    keepAudio: $<HTMLInputElement>("keep-audio").checked
  };
}

function effectiveSettings(item: BatchItem): CompressionSettings {
  if (item.status !== "queued" || batchRunning) return item.settings;
  const form = readSettings();
  return { ...form, targetMb: item.targetOverridden ? item.settings.targetMb : form.targetMb };
}

function validateForStart(settings: CompressionSettings): string | null {
  if (settings.mode === "compress") {
    const targetMb = Number($<HTMLInputElement>("target-mb").value);
    if (!Number.isFinite(targetMb) || targetMb <= 0) return "Vul een doelgrootte groter dan 0 MB in.";
  }
  const concurrency = Number($<HTMLInputElement>("concurrency").value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) return "Gelijktijdige taken moeten tussen 1 en 8 liggen.";
  return null;
}

function localSummary(): { queued: number; running: number; completed: number; failed: number; cancelled: number } {
  const summary = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of items.values()) summary[item.status]++;
  return summary;
}

function batchPercent(): number {
  if (!items.size) return 0;
  let total = 0;
  for (const item of items.values()) {
    if (item.status === "completed" || item.status === "failed" || item.status === "cancelled") total += 100;
    else if (item.status === "running") total += Math.max(0, Math.min(100, item.progress.percent));
  }
  return Math.round(total / items.size);
}

function matchesFilter(item: BatchItem): boolean {
  if (queueFilter === "active") return item.status === "queued" || item.status === "running";
  if (queueFilter === "done") return item.status === "completed";
  if (queueFilter === "problem") return item.status === "failed" || item.status === "cancelled";
  return true;
}

function savingLabel(result: CompressionResult): { text: string; tone: "ok" | "warn" } {
  if (result.originalBytes <= 0) return { text: "—", tone: "ok" };
  const ratio = 1 - result.outputBytes / result.originalBytes;
  const text = `${Math.abs(ratio * 100).toFixed(1)}%`;
  return ratio >= 0 ? { text: `${text} kleiner`, tone: "ok" } : { text: `${text} groter`, tone: "warn" };
}

function metaLine(item: BatchItem): string {
  const metadata = item.metadata;
  if (!metadata.duration && !metadata.width) return "Metadata volgt zodra FFmpeg het bestand kan lezen";
  return `${metadata.width}×${metadata.height} · ${metadata.videoCodec}/${metadata.audioCodec ?? "geen audio"}`;
}

function noteFor(item: BatchItem, settings: CompressionSettings): { text: string; tone: string } {
  if (item.error && item.status !== "cancelled") return { text: item.error, tone: "error" };
  const message = item.progress.message ?? "";
  if (message && message !== STATUS_LABEL[item.status] && message !== "Wachtend") {
    return { text: message, tone: item.status === "failed" ? "error" : "" };
  }
  if (item.status === "queued" && settings.mode === "compress" && item.metadata.size > 0 && settings.targetMb * 1_000_000 >= item.metadata.size) {
    return { text: "Doel is niet kleiner dan het origineel.", tone: "warn" };
  }
  return { text: "", tone: "" };
}

function progressDetail(item: BatchItem): string {
  const parts = [item.progress.speed, formatEta(item.progress.etaSeconds)];
  if (item.progress.bitrate && item.progress.bitrate !== "N/A") parts.push(item.progress.bitrate);
  return parts.filter(Boolean).join(" · ");
}

function showAction(card: HTMLElement, action: string, visible: boolean): void {
  card.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.classList.toggle("hidden", !visible);
}

function createCard(id: string): HTMLElement {
  const card = $<HTMLTemplateElement>("file-card-template").content.firstElementChild!.cloneNode(true) as HTMLElement;
  card.dataset.id = id;
  return card;
}

function patchCard(card: HTMLElement, item: BatchItem): void {
  const settings = effectiveSettings(item);
  card.dataset.status = item.status;
  card.classList.toggle("hidden", !matchesFilter(item));
  const name = card.querySelector<HTMLElement>(".file-name")!;
  name.textContent = fileName(item.inputPath);
  name.title = item.inputPath;
  card.querySelector(".file-meta")!.textContent = metaLine(item);
  const chip = card.querySelector<HTMLElement>(".status-chip")!;
  chip.textContent = STATUS_LABEL[item.status];
  chip.className = `status-chip ${item.status}`;

  const percent = item.status === "completed" ? 100 : Math.max(0, Math.min(100, item.progress.percent));
  const fill = card.querySelector<HTMLElement>(".progress-fill")!;
  fill.style.width = `${percent}%`;
  fill.className = `progress-fill ${item.status}`;
  card.querySelector(".progress-percent")!.textContent = item.status === "running" || item.status === "completed" ? `${Math.round(percent)}%` : "—";
  card.querySelector(".progress-detail")!.textContent = item.status === "running" ? progressDetail(item) : "";

  card.querySelector(".metric-size")!.textContent = formatBytes(item.metadata.size);
  card.querySelector(".metric-duration")!.textContent = formatDuration(item.metadata.duration);
  const target = card.querySelector<HTMLElement>(".metric-target")!;
  target.classList.toggle("hidden", settings.mode !== "compress");
  const input = card.querySelector<HTMLInputElement>(".item-target")!;
  const nextTarget = String(settings.targetMb);
  if (document.activeElement !== input && input.value !== nextTarget) input.value = nextTarget;
  input.disabled = item.status !== "queued" || batchRunning;
  card.querySelector(".override-tag")?.classList.toggle("hidden", !(item.targetOverridden && item.status === "queued" && settings.mode === "compress"));
  card.querySelector(".metric-result")!.textContent = item.result ? formatBytes(item.result.outputBytes) : "—";
  const saving = card.querySelector<HTMLElement>(".metric-saving")!;
  if (item.result) {
    const label = savingLabel(item.result);
    saving.textContent = label.text;
    saving.className = `metric-saving ${label.tone}`;
  } else {
    saving.textContent = "—";
    saving.className = "metric-saving";
  }

  const note = noteFor(item, settings);
  const noteElement = card.querySelector<HTMLElement>(".file-note")!;
  noteElement.textContent = note.text;
  noteElement.className = `file-note ${note.tone}`.trim();

  showAction(card, "cancel", batchRunning && (item.status === "queued" || item.status === "running"));
  showAction(card, "retry", item.status === "failed" || item.status === "cancelled" || item.status === "completed");
  showAction(card, "open", Boolean(item.result));
  showAction(card, "reveal", Boolean(item.result));
  showAction(card, "save", Boolean(item.result));
  showAction(card, "remove", item.status !== "running");
}

function renderQueue(): void {
  const list = $("file-list");
  const seen = new Set<string>();
  for (const item of items.values()) {
    seen.add(item.id);
    let card = list.querySelector<HTMLElement>(`.file-card[data-id="${CSS.escape(item.id)}"]`);
    if (!card) {
      card = createCard(item.id);
      list.append(card);
    }
    patchCard(card, item);
  }
  for (const card of Array.from(list.querySelectorAll<HTMLElement>(".file-card"))) {
    if (!seen.has(card.dataset.id ?? "")) card.remove();
  }
  const ordered = [...items.values()].flatMap((item) => {
    const card = list.querySelector(`.file-card[data-id="${CSS.escape(item.id)}"]`);
    return card ? [card] : [];
  });
  const current = Array.from(list.querySelectorAll(".file-card"));
  if (current.length !== ordered.length || current.some((card, index) => card !== ordered[index])) {
    for (const card of ordered) list.append(card);
  }
  const visible = [...items.values()].some(matchesFilter);
  $("files-section").classList.toggle("hidden", items.size === 0);
  $("filter-empty").classList.toggle("hidden", items.size === 0 || visible);
  $("drop-zone").classList.toggle("compact", items.size > 0);
  const bytes = [...items.values()].reduce((total, item) => total + (item.metadata.size || 0), 0);
  $("file-count").textContent = `${items.size} bestand${items.size === 1 ? "" : "en"}${bytes ? ` · ${formatBytes(bytes)}` : ""}`;
  renderSummary();
}

function renderSummary(): void {
  const summary = localSummary();
  const saved = [...items.values()].reduce((total, item) => item.result ? total + item.result.originalBytes - item.result.outputBytes : total, 0);
  const parts = [`${summary.queued} wachtend`, `${summary.running} bezig`, `${summary.completed} voltooid`, `${summary.failed} mislukt`, `${summary.cancelled} geannuleerd`];
  if (saved > 0) parts.push(`${formatBytes(saved)} bespaard`);
  else if (saved < 0) parts.push(`${formatBytes(-saved)} groter`);
  const text = items.size ? parts.join(" · ") : "Voeg bestanden toe om te beginnen.";
  const key = `${text}:${items.size}`;
  if (key !== summaryKey) {
    summaryKey = key;
    $("batch-summary").textContent = text;
  }
  const percent = batchPercent();
  $("batch-progress-bar").style.width = `${percent}%`;
  $("batch-progress-bar").parentElement?.setAttribute("aria-valuenow", String(percent));
  const labels: Record<QueueFilter, string> = {
    all: `Alles ${items.size}`,
    active: `Actief ${summary.queued + summary.running}`,
    done: `Klaar ${summary.completed}`,
    problem: `Probleem ${summary.failed + summary.cancelled}`
  };
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
    const filter = button.dataset.filter as QueueFilter;
    button.textContent = labels[filter];
    button.setAttribute("aria-pressed", filter === queueFilter ? "true" : "false");
  });
  syncActions(summary);
}

function syncActions(summary = localSummary()): void {
  const start = $<HTMLButtonElement>("compress-button");
  start.textContent = batchRunning ? "Bezig…" : currentMode() === "convert" ? "Start conversie" : "Start compressie";
  let reason = "";
  if (ffmpegState === "checking") reason = "FFmpeg wordt nog gecontroleerd.";
  else if (!ffmpegReady) reason = "FFmpeg is niet beschikbaar.";
  else if (!summary.queued) reason = items.size ? "Geen wachtende bestanden." : "Voeg eerst video's toe.";
  start.disabled = batchRunning || !ffmpegReady || summary.queued === 0;
  $("start-hint").textContent = batchRunning ? "De batch loopt. Je kunt een bestand apart annuleren." : reason;
  $("cancel-button").classList.toggle("hidden", !batchRunning);
  $<HTMLButtonElement>("clear-button").disabled = batchRunning || ![...items.values()].some((item) => item.status !== "running");
  $<HTMLButtonElement>("clear-completed").disabled = summary.completed === 0;
  $<HTMLButtonElement>("retry-failed").disabled = summary.failed + summary.cancelled === 0;
  $<HTMLButtonElement>("reset-targets").disabled = batchRunning;
}

function updateModeUi(): void {
  const converting = currentMode() === "convert";
  $("target-mb-field").classList.toggle("hidden", converting);
  $("codec-field").classList.toggle("hidden", converting);
  $("convert-note").classList.toggle("hidden", !converting);
  $("advanced-toggle").classList.toggle("hidden", converting);
  $("advanced-options").classList.toggle("hidden", converting || !$<HTMLInputElement>("advanced").checked);
}

function savePreferences(): void {
  const preferences: Preferences = {
    mode: currentMode(),
    targetMb: Number($<HTMLInputElement>("target-mb").value) || 50,
    concurrency: Number($<HTMLInputElement>("concurrency").value) || 1,
    audioBitrate: $<HTMLSelectElement>("audio-bitrate").value,
    videoCodec: $<HTMLSelectElement>("video-codec").value,
    preset: $<HTMLSelectElement>("preset").value,
    resolution: $<HTMLSelectElement>("resolution").value,
    frameRate: $<HTMLSelectElement>("framerate").value,
    keepAudio: $<HTMLInputElement>("keep-audio").checked,
    advanced: $<HTMLInputElement>("advanced").checked
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

function setSelect(id: string, value: string | undefined): void {
  if (!value) return;
  const select = $<HTMLSelectElement>(id);
  if (Array.from(select.options).some((option) => option.value === value)) select.value = value;
}

function loadPreferences(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const preferences = JSON.parse(raw) as Preferences;
    if (preferences.mode === "compress" || preferences.mode === "convert") {
      const input = document.querySelector<HTMLInputElement>(`input[name="processing-mode"][value="${preferences.mode}"]`);
      if (input) input.checked = true;
    }
    if (typeof preferences.targetMb === "number" && preferences.targetMb > 0) $<HTMLInputElement>("target-mb").value = String(preferences.targetMb);
    if (typeof preferences.concurrency === "number") {
      $<HTMLInputElement>("concurrency").value = String(Math.min(8, Math.max(1, Math.round(preferences.concurrency))));
    }
    setSelect("audio-bitrate", preferences.audioBitrate);
    setSelect("video-codec", preferences.videoCodec);
    setSelect("preset", preferences.preset);
    setSelect("resolution", preferences.resolution);
    setSelect("framerate", preferences.frameRate);
    if (typeof preferences.keepAudio === "boolean") $<HTMLInputElement>("keep-audio").checked = preferences.keepAudio;
    if (typeof preferences.advanced === "boolean") $<HTMLInputElement>("advanced").checked = preferences.advanced;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function onSettingsChanged(): void {
  updateModeUi();
  savePreferences();
  renderQueue();
}

function resetQueuedItem(item: BatchItem): void {
  item.status = "queued";
  item.error = undefined;
  item.result = undefined;
  item.progress = { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" };
}

function removeItems(predicate: (item: BatchItem) => boolean): void {
  for (const [id, item] of items) {
    if (!predicate(item)) continue;
    dismissed.add(id);
    if (batchRunning && (item.status === "queued" || item.status === "running")) getApi().cancelItem(id);
    items.delete(id);
  }
  renderQueue();
}

async function addFiles(paths: string[]): Promise<void> {
  const known = new Set([...items.values()].map((item) => item.inputPath.toLowerCase()));
  let added = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    if (known.has(path.toLowerCase())) { skipped++; continue; }
    try {
      const metadata = await getApi().probe(path);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      items.set(id, {
        id, inputPath: path, metadata, settings: readSettings(), targetOverridden: false, status: "queued",
        progress: { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" }
      });
      known.add(path.toLowerCase());
      added++;
    } catch (error) {
      errors.push(`${fileName(path)}: ${(error as Error).message}`);
    }
  }
  renderQueue();
  if (added) toast(`${added} bestand${added === 1 ? "" : "en"} toegevoegd.`, "ok");
  else if (skipped) toast("Die bestanden staan al in de wachtrij.");
  if (errors.length) toast(errors.slice(0, 3).join(" "), "error");
}

async function startBatch(): Promise<void> {
  if (batchRunning) return;
  const settings = readSettings();
  const problem = validateForStart(settings);
  if (problem) { toast(problem, "error"); return; }
  const queued = [...items.values()].filter((item) => item.status === "queued");
  if (!queued.length) { toast("Er staan geen wachtende bestanden klaar."); return; }
  if (!ffmpegReady) { toast("FFmpeg is nog niet klaar. Installeer of kies eerst een installatie.", "error"); return; }
  const concurrency = Number($<HTMLInputElement>("concurrency").value);
  for (const item of queued) item.settings = effectiveSettings(item);
  renderQueue();
  batchRunning = true;
  syncActions();
  try {
    await getApi().startBatch(queued.map((item) => ({ ...item })), concurrency);
    const summary = localSummary();
    if (summary.failed) toast(`${summary.failed} bestand${summary.failed === 1 ? "" : "en"} mislukt.`, "error");
    else if (summary.completed && !summary.cancelled) toast(`${summary.completed} bestand${summary.completed === 1 ? "" : "en"} klaar.`, "ok");
  } catch (error) {
    toast((error as Error).message, "error");
  } finally {
    batchRunning = false;
    renderQueue();
  }
}

function applyFfmpegStatus(status: FfmpegStatus): void {
  const becameReady = status.available && !ffmpegReady;
  ffmpegReady = status.available;
  ffmpegState = status.state;
  const panel = $("ffmpeg-panel");
  panel.classList.remove("is-ok", "is-bad", "is-wait");
  const pill = $("binary-status");
  if (status.state === "checking") {
    panel.classList.add("is-wait");
    pill.textContent = "FFmpeg controleren";
    pill.className = "pill wait";
  } else if (status.available) {
    panel.classList.add("is-ok");
    pill.textContent = "FFmpeg klaar";
    pill.className = "pill ok";
    if (becameReady) $<HTMLDetailsElement>("ffmpeg-details").open = false;
  } else {
    panel.classList.add("is-bad");
    pill.textContent = "FFmpeg ontbreekt";
    pill.className = "pill error";
    $<HTMLDetailsElement>("ffmpeg-details").open = true;
  }
  $("ffmpeg-status").textContent = status.state === "checking"
    ? "Bezig met zoeken en valideren…"
    : status.available ? `Gereed · ${status.version ?? "onbekende versie"}` : status.message;
  $("ffmpeg-location").textContent = status.location ?? (status.available ? "Windows PATH" : "Niet gevonden");
  $("ffmpeg-codecs").textContent = `H.264 ${status.codecs.h264 ? "aanwezig" : "ontbreekt"} · H.265 ${status.codecs.h265 ? "aanwezig" : "ontbreekt"} · AAC ${status.codecs.aac ? "aanwezig" : "ontbreekt"}`;
  $("ffmpeg-install").classList.toggle("hidden", status.available || status.state === "checking");
  $<HTMLButtonElement>("ffmpeg-install-button").disabled = status.available || installing || status.state === "checking";
  $<HTMLButtonElement>("ffmpeg-select").disabled = installing || status.state === "checking";
  $<HTMLButtonElement>("ffmpeg-recheck").disabled = installing || status.state === "checking";
  syncActions();
  if (becameReady) void reprobeQueued();
}

async function reprobeQueued(): Promise<void> {
  if (reprobeRunning) return;
  reprobeRunning = true;
  try {
    for (const item of [...items.values()]) {
      if (item.status !== "queued" || (item.metadata.duration > 0 && item.metadata.width > 0)) continue;
      try { item.metadata = await getApi().probe(item.inputPath); } catch { /* De start probeert het opnieuw. */ }
    }
    renderQueue();
  } finally {
    reprobeRunning = false;
  }
}

function filePaths(data: DataTransfer | null): string[] {
  if (!data) return [];
  return Array.from(data.files).map((file) => (file as File & { path?: string }).path ?? "").filter(Boolean);
}

let watchFfmpeg = true;

function watchStatus(): void {
  if (!watchFfmpeg || ffmpegState !== "checking") return;
  window.setTimeout(() => {
    void getApi().ffmpegStatus().then((status) => {
      applyFfmpegStatus(status);
      watchStatus();
    }).catch((error: Error) => toast(error.message, "error"));
  }, 500);
}

loadPreferences();
updateModeUi();
renderQueue();

function applyUpdateState(state: UpdateState): void {
  const panel = $("update-panel");
  const visible = state.status === "checking" || state.status === "available" || state.status === "downloading" || state.status === "downloaded" || state.status === "error";
  panel.classList.toggle("hidden", !visible);
  panel.dataset.status = state.status;
  $("update-status").textContent = state.message;
  $("update-progress-wrap").classList.toggle("hidden", state.status !== "downloading");
  $("update-progress").style.width = `${Math.max(0, Math.min(100, state.percent))}%`;
  $("update-download").classList.toggle("hidden", state.status !== "available");
  $("update-install").classList.toggle("hidden", state.status !== "downloaded");
  $("update-later").classList.toggle("hidden", state.status !== "available" && state.status !== "downloaded");
  $<HTMLButtonElement>("update-check").disabled = state.status === "checking" || state.status === "downloading";
  $<HTMLButtonElement>("update-download").disabled = state.status === "downloading";
  $<HTMLButtonElement>("check-updates").disabled = state.status === "checking" || state.status === "downloading";
  const versionButton = $("check-updates");
  versionButton.textContent = state.availableVersion && (state.status === "available" || state.status === "downloading" || state.status === "downloaded")
    ? `v${state.currentVersion} → v${state.availableVersion}`
    : `v${state.currentVersion}`;
  versionButton.classList.toggle("has-update", state.status === "available" || state.status === "downloaded");
  versionButton.title = state.status === "disabled" ? state.message : "Klik om op updates te controleren";
  const notes = $("update-notes");
  const noteText = state.releaseNotes?.trim() ?? "";
  notes.textContent = noteText;
  notes.classList.toggle("hidden", !noteText || (state.status !== "available" && state.status !== "downloaded"));
}

async function checkUpdates(manual = false): Promise<void> {
  try {
    const state = await getApi().checkForUpdates();
    applyUpdateState(state);
    if (!manual) return;
    if (state.status === "not-available") toast(state.message, "ok");
    if (state.status === "available") toast(`Update ${state.availableVersion} beschikbaar.`, "ok");
    if (state.status === "error") toast(state.message, "error");
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

void (async () => {
  try {
    const info = await getApi().getAppInfo();
    $("check-updates").textContent = `v${info.version}`;
    $("check-updates").title = `${info.name} ${info.version} · controleer op updates`;
    document.title = `${info.name} ${info.version}`;
    applyUpdateState(await getApi().getUpdateStatus());
  } catch {
    $("check-updates").textContent = "v?";
  }
})();

$("check-updates").onclick = () => { void checkUpdates(true); };
$("update-check").onclick = () => { void checkUpdates(true); };
$("update-download").onclick = async () => {
  try { applyUpdateState(await getApi().downloadUpdate()); }
  catch (error) { toast((error as Error).message, "error"); }
};
$("update-install").onclick = async () => {
  try { await getApi().installUpdate(); }
  catch (error) { toast((error as Error).message, "error"); }
};
$("update-later").onclick = () => {
  $("update-panel").classList.add("hidden");
  toast("Je kunt later updaten via het versienummer rechtsboven.");
};

document.querySelectorAll('input[name="processing-mode"]').forEach((input) => input.addEventListener("change", onSettingsChanged));
for (const id of ["target-mb", "concurrency", "audio-bitrate", "video-codec", "preset", "resolution", "framerate", "keep-audio", "advanced"]) {
  $(id).addEventListener("change", onSettingsChanged);
}
$("target-mb").addEventListener("input", onSettingsChanged);

$("select-button").onclick = async () => {
  try { await addFiles(await getApi().selectFiles()); }
  catch (error) { toast((error as Error).message, "error"); }
};

let dragDepth = 0;
const dropZone = $("drop-zone");
window.addEventListener("dragenter", (event) => { event.preventDefault(); dragDepth++; dropZone.classList.add("dragging"); });
window.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; });
window.addEventListener("dragleave", (event) => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) dropZone.classList.remove("dragging"); });
window.addEventListener("drop", (event) => { event.preventDefault(); dragDepth = 0; dropZone.classList.remove("dragging"); void addFiles(filePaths(event.dataTransfer)); });

document.addEventListener("wheel", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type === "number" && document.activeElement === target) target.blur();
}, { passive: true });

$("file-list").addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.classList.contains("item-target")) return;
  const item = items.get(input.closest<HTMLElement>(".file-card")?.dataset.id ?? "");
  if (!item) return;
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) {
    input.value = String(item.settings.targetMb);
    toast("Doelgrootte moet groter zijn dan 0 MB.", "error");
    return;
  }
  item.settings = { ...item.settings, targetMb: value };
  item.targetOverridden = true;
  renderQueue();
});

$("file-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
  if (!button) return;
  const item = items.get(button.closest<HTMLElement>(".file-card")?.dataset.id ?? "");
  if (!item) return;
  if (button.dataset.action === "remove") removeItems((candidate) => candidate.id === item.id);
  if (button.dataset.action === "cancel") {
    getApi().cancelItem(item.id);
    if (item.status === "queued") {
      item.status = "cancelled";
      item.progress = { ...item.progress, status: "cancelled", message: "Geannuleerd" };
      renderQueue();
    } else {
      item.progress = { ...item.progress, message: "Annuleren…" };
      renderQueue();
    }
  }
  if (button.dataset.action === "retry") {
    resetQueuedItem(item);
    renderQueue();
    if (batchRunning) toast("Dit bestand start mee zodra je de volgende batch start.");
  }
  if (button.dataset.action === "open" && item.result) void getApi().openFile(item.result.outputPath).then((error) => { if (error) toast(error, "error"); });
  if (button.dataset.action === "reveal" && item.result) void getApi().showInFolder(item.result.outputPath);
  if (button.dataset.action === "save" && item.result) {
    void getApi().saveCopy(item.result.outputPath).then((saved) => { if (saved) toast("Kopie opgeslagen.", "ok"); }).catch((error: Error) => toast(error.message, "error"));
  }
});

$("queue-filters").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-filter]");
  if (!button?.dataset.filter) return;
  queueFilter = button.dataset.filter as QueueFilter;
  renderQueue();
});

$("reset-targets").onclick = () => {
  let count = 0;
  const targetMb = readSettings().targetMb;
  for (const item of items.values()) {
    if (item.status === "queued" && item.targetOverridden) {
      item.targetOverridden = false;
      item.settings = { ...item.settings, targetMb };
      count++;
    }
  }
  renderQueue();
  toast(count ? `${count} doelgroottes teruggezet.` : "Geen afwijkende doelgroottes.", count ? "ok" : "info");
};
$("compress-button").onclick = () => { void startBatch().catch((error: Error) => toast(error.message, "error")); };
$("cancel-button").onclick = () => getApi().cancelBatch();
$("retry-failed").onclick = () => {
  let count = 0;
  for (const item of items.values()) {
    if (item.status !== "failed" && item.status !== "cancelled") continue;
    resetQueuedItem(item);
    count++;
  }
  renderQueue();
  if (!count) toast("Geen mislukte bestanden.");
  else toast(batchRunning ? `${count} terug in de wachtrij. Ze starten mee bij de volgende batch.` : `${count} terug in de wachtrij.`, "ok");
};
$("clear-completed").onclick = () => removeItems((item) => item.status === "completed");
$("clear-button").onclick = () => { if (!batchRunning) removeItems((item) => item.status !== "running"); };
if (window.videoCompressor) {
  window.videoCompressor.onBatchUpdate((update) => {
    if (dismissed.has(update.item.id)) return;
    items.set(update.item.id, update.item);
    renderQueue();
  });
  window.videoCompressor.onBinaryStatus(applyFfmpegStatus);
  window.videoCompressor.onUpdateStatus(applyUpdateState);
  window.videoCompressor.onFfmpegInstallProgress((percent) => {
    $<HTMLDetailsElement>("ffmpeg-details").open = true;
    $("ffmpeg-install").classList.remove("hidden");
    $("ffmpeg-install-progress").style.width = `${Math.max(0, Math.min(100, percent))}%`;
  });
  window.videoCompressor.onBinaryError((message) => { if (ffmpegState === "error") toast(message, "error"); });
  void getApi().ffmpegStatus().then((status) => {
    applyFfmpegStatus(status);
    watchStatus();
  }).catch((error: Error) => { $("ffmpeg-status").textContent = `Controle mislukt: ${error.message}`; });
  window.setTimeout(() => {
    if (ffmpegState !== "checking") return;
    watchFfmpeg = false;
    $("ffmpeg-status").textContent = "De controle duurt te lang. Probeer opnieuw.";
    $<HTMLButtonElement>("ffmpeg-recheck").disabled = false;
  }, 20_000);
} else {
  ffmpegState = "error";
  $("ffmpeg-panel").classList.remove("is-wait");
  $("ffmpeg-panel").classList.add("is-bad");
  $("binary-status").textContent = "Preload ontbreekt";
  $("binary-status").className = "pill error";
  $("ffmpeg-status").textContent = "De applicatie-API is niet geladen. Start via Electron.";
  syncActions();
}

$("ffmpeg-recheck").onclick = async () => {
  watchFfmpeg = true;
  try {
    applyFfmpegStatus(await getApi().recheckFfmpeg());
    watchStatus();
  } catch (error) { toast((error as Error).message, "error"); }
};
$("ffmpeg-select").onclick = async () => {
  try { applyFfmpegStatus(await getApi().selectFfmpeg()); }
  catch (error) { toast((error as Error).message, "error"); }
};
$("ffmpeg-install-button").onclick = async () => {
  installing = true;
  $<HTMLButtonElement>("ffmpeg-install-button").disabled = true;
  $("ffmpeg-install").classList.remove("hidden");
  try { applyFfmpegStatus(await getApi().installFfmpeg()); }
  catch (error) { toast((error as Error).message, "error"); }
  finally {
    installing = false;
    $<HTMLButtonElement>("ffmpeg-install-button").disabled = ffmpegReady || ffmpegState === "checking";
    $<HTMLButtonElement>("ffmpeg-select").disabled = ffmpegState === "checking";
    $<HTMLButtonElement>("ffmpeg-recheck").disabled = ffmpegState === "checking";
    syncActions();
  }
};
