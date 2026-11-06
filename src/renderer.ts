type BatchItem = import("./shared/types").BatchItem;
type CompressionResult = import("./shared/types").CompressionResult;
type CompressionSettings = import("./shared/types").CompressionSettings;
type FfmpegStatus = import("./core/ffmpeg-provider").FfmpegStatus;
type UpdateState = import("./core/updater").UpdateState;

type QueueFilter = "all" | "active" | "done" | "problem";
type ToastTone = "info" | "ok" | "error";
type PageId = "converter" | "history" | "settings" | "about";
type ThemePreference = "system" | "light" | "dark";

interface Preferences {
  mode?: "compress" | "convert";
  targetMb?: number;
  concurrency?: number;
  audioBitrate?: string;
  videoCodec?: string;
  encoderPreference?: string;
  preset?: string;
  resolution?: string;
  frameRate?: string;
  keepAudio?: boolean;
  advanced?: boolean;
  theme?: ThemePreference;
}

interface HistoryEntry {
  id: string;
  inputPath: string;
  outputPath: string | null;
  finishedAt: string;
  originalBytes: number;
  outputBytes: number | null;
  status: "completed" | "failed" | "cancelled";
  error?: string;
  durationSeconds: number | null;
}

const STORAGE_KEY = "video-compressor.preferences.v1";
const HISTORY_KEY = "video-compressor.history.v1";
const STATUS_LABEL = { queued: "Wachtend", running: "Bezig", completed: "Voltooid", failed: "Fout", cancelled: "Geannuleerd" } as const;
const PAGE_COPY: Record<PageId, { title: string; subtitle: string }> = {
  converter: { title: "Converter", subtitle: "Comprimeer of converteer video’s naar MP4" },
  history: { title: "Geschiedenis", subtitle: "Eerdere resultaten, gescheiden van de actieve wachtrij" },
  settings: { title: "Instellingen", subtitle: "Uiterlijk, standaardwaarden, FFmpeg en updates" },
  about: { title: "Over", subtitle: "Versie- en diagnose-informatie" }
};

const items = new Map<string, BatchItem>();
const dismissed = new Set<string>();
const historyEntries: HistoryEntry[] = [];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let batchRunning = false;
let lastBatchRuntime: import("./shared/types").BatchRuntimeInfo | null = null;
let queueFilter: QueueFilter = "all";
let ffmpegReady = false;
let ffmpegState: FfmpegStatus["state"] = "checking";
let ffmpegStatusCache: FfmpegStatus | null = null;
let installing = false;
let reprobeRunning = false;
let summaryKey = "";
let selectedId: string | null = null;
let currentPage: PageId = "converter";
let appInfo: { name: string; version: string; packaged: boolean; userData: string; appDirectory: string; electron: string } | null = null;
let latestUpdate: UpdateState | null = null;

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
    keepAudio: $<HTMLInputElement>("keep-audio").checked,
    encoderPreference: $<HTMLSelectElement>("encoder-preference").value as CompressionSettings["encoderPreference"]
  };
}

function readConcurrency(): number {
  const value = Number($<HTMLSelectElement>("concurrency").value);
  if (!Number.isInteger(value) || value < 0 || value > 8) return 1;
  return value;
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
  const concurrency = readConcurrency();
  if (!Number.isInteger(concurrency) || concurrency < 0 || concurrency > 8) return "Gelijktijdige taken moeten Auto of 1–8 zijn.";
  if (settings.videoCodec === "h265" && (!ffmpegStatusCache?.available || !ffmpegStatusCache.codecs.h265)) {
    return "H.265 is niet beschikbaar in de huidige FFmpeg-installatie. Kies H.264.";
  }
  const preference = settings.encoderPreference ?? "auto";
  const hardware = ffmpegStatusCache?.hardware;
  if (preference === "nvidia" && !(hardware?.nvidia.h264 || hardware?.nvidia.h265)) {
    return "NVIDIA NVENC is niet beschikbaar. Kies Automatisch of CPU.";
  }
  if (preference === "amd" && !(hardware?.amd.h264 || hardware?.amd.h265)) {
    return "AMD AMF is niet beschikbaar. Kies Automatisch of CPU.";
  }
  if (preference === "intel" && !(hardware?.intel.h264 || hardware?.intel.h265)) {
    return "Intel Quick Sync is niet beschikbaar. Kies Automatisch of CPU.";
  }
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

function showAction(row: HTMLElement, action: string, visible: boolean): void {
  row.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.classList.toggle("hidden", !visible);
}

function createRow(id: string): HTMLElement {
  const row = $<HTMLTemplateElement>("file-row-template").content.firstElementChild!.cloneNode(true) as HTMLElement;
  row.dataset.id = id;
  return row;
}

function patchRow(row: HTMLElement, item: BatchItem): void {
  const settings = effectiveSettings(item);
  row.dataset.status = item.status;
  row.classList.toggle("hidden", !matchesFilter(item));
  row.classList.toggle("selected", selectedId === item.id);
  const name = row.querySelector<HTMLElement>(".file-name")!;
  name.textContent = fileName(item.inputPath);
  name.title = item.inputPath;

  row.querySelector(".col-res")!.textContent = item.metadata.width ? `${item.metadata.width}×${item.metadata.height}` : "—";
  row.querySelector(".col-size")!.textContent = formatBytes(item.metadata.size);

  const targetCell = row.querySelector<HTMLElement>(".col-target")!;
  targetCell.classList.toggle("hidden", settings.mode !== "compress");
  const input = row.querySelector<HTMLInputElement>(".item-target")!;
  const nextTarget = String(settings.targetMb);
  if (document.activeElement !== input && input.value !== nextTarget) input.value = nextTarget;
  input.disabled = item.status !== "queued" || batchRunning;
  row.querySelector(".override-tag")?.classList.toggle("hidden", !(item.targetOverridden && item.status === "queued" && settings.mode === "compress"));

  const chip = row.querySelector<HTMLElement>(".status-chip")!;
  chip.textContent = STATUS_LABEL[item.status];
  chip.className = `status-chip ${item.status}`;

  const percent = item.status === "completed" ? 100 : Math.max(0, Math.min(100, item.progress.percent));
  const fill = row.querySelector<HTMLElement>(".progress-fill")!;
  fill.style.width = `${percent}%`;
  fill.className = `progress-fill ${item.status}`;
  row.querySelector(".progress-percent")!.textContent = item.status === "running" || item.status === "completed" ? `${Math.round(percent)}%` : "—";

  row.querySelector(".col-result")!.textContent = item.result ? formatBytes(item.result.outputBytes) : "—";
  const saving = row.querySelector<HTMLElement>(".col-saving")!;
  if (item.result) {
    const label = savingLabel(item.result);
    saving.textContent = label.text;
    saving.className = `col-saving ${label.tone}`;
  } else {
    saving.textContent = "—";
    saving.className = "col-saving";
  }

  const note = noteFor(item, settings);
  const noteElement = row.querySelector<HTMLElement>(".file-note")!;
  noteElement.textContent = note.text;
  noteElement.className = `file-note muted ${note.tone}`.trim();

  showAction(row, "cancel", batchRunning && (item.status === "queued" || item.status === "running"));
  showAction(row, "retry", item.status === "failed" || item.status === "cancelled" || item.status === "completed");
  showAction(row, "open", Boolean(item.result));
  showAction(row, "reveal", Boolean(item.result));
  showAction(row, "save", Boolean(item.result));
  showAction(row, "remove", item.status !== "running");
}

function renderQueue(): void {
  const list = $("file-list");
  const seen = new Set<string>();
  for (const item of items.values()) {
    seen.add(item.id);
    let row = list.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(item.id)}"]`);
    if (!row) {
      row = createRow(item.id);
      list.append(row);
    }
    patchRow(row, item);
  }
  for (const row of Array.from(list.querySelectorAll<HTMLElement>("tr[data-id]"))) {
    if (!seen.has(row.dataset.id ?? "")) row.remove();
  }
  const ordered = [...items.values()].flatMap((item) => {
    const row = list.querySelector(`tr[data-id="${CSS.escape(item.id)}"]`);
    return row ? [row] : [];
  });
  const current = Array.from(list.querySelectorAll("tr[data-id]"));
  if (current.length !== ordered.length || current.some((row, index) => row !== ordered[index])) {
    for (const row of ordered) list.append(row);
  }
  const visible = [...items.values()].some(matchesFilter);
  $("files-section").classList.toggle("hidden", items.size === 0);
  $("filter-empty").classList.toggle("hidden", items.size === 0 || visible);
  $("drop-zone").classList.toggle("compact", items.size > 0);
  const bytes = [...items.values()].reduce((total, item) => total + (item.metadata.size || 0), 0);
  $("file-count").textContent = `${items.size} bestand${items.size === 1 ? "" : "en"}${bytes ? ` · ${formatBytes(bytes)}` : ""}`;
  renderSummary();
  renderDetails();
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
  else if (!ffmpegReady) reason = "FFmpeg is niet beschikbaar. Ga naar Instellingen.";
  else if (!summary.queued) reason = items.size ? "Geen wachtende bestanden." : "Voeg eerst video’s toe.";
  start.disabled = batchRunning || !ffmpegReady || summary.queued === 0;
  if (batchRunning) {
    const runtime = lastBatchRuntime;
    const mode = runtime?.concurrencyMode === "auto" ? "Auto" : "Handmatig";
    const encoder = runtime?.encoderLabel ?? "encoder";
    const parallel = runtime?.concurrency ?? "—";
    $("start-hint").textContent = `${mode} · ${parallel} tegelijk · ${encoder} · ${summary.running} bezig · ${summary.queued} wachtend`;
  } else {
    $("start-hint").textContent = reason;
  }
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
  syncActions();
  renderQueue();
}

function syncSettingsMirrors(fromConverter: boolean): void {
  const pairs: Array<[string, string]> = [
    ["target-mb", "settings-target-mb"],
    ["audio-bitrate", "settings-audio"],
    ["video-codec", "settings-codec"],
    ["encoder-preference", "settings-encoder"],
    ["preset", "settings-preset"],
    ["concurrency", "settings-concurrency"],
    ["resolution", "settings-resolution"],
    ["framerate", "settings-framerate"]
  ];
  for (const [a, b] of pairs) {
    const source = $<HTMLInputElement | HTMLSelectElement>(fromConverter ? a : b);
    const target = $<HTMLInputElement | HTMLSelectElement>(fromConverter ? b : a);
    if (document.activeElement !== target) target.value = source.value;
  }
  const keepSource = $<HTMLInputElement>(fromConverter ? "keep-audio" : "settings-keep-audio");
  const keepTarget = $<HTMLInputElement>(fromConverter ? "settings-keep-audio" : "keep-audio");
  keepTarget.checked = keepSource.checked;
}

function savePreferences(): void {
  const theme = document.querySelector<HTMLInputElement>('input[name="theme"]:checked')?.value as ThemePreference | undefined;
  const preferences: Preferences = {
    mode: currentMode(),
    targetMb: Number($<HTMLInputElement>("target-mb").value) || 50,
    concurrency: readConcurrency(),
    audioBitrate: $<HTMLSelectElement>("audio-bitrate").value,
    videoCodec: $<HTMLSelectElement>("video-codec").value,
    encoderPreference: $<HTMLSelectElement>("encoder-preference").value,
    preset: $<HTMLSelectElement>("preset").value,
    resolution: $<HTMLSelectElement>("resolution").value,
    frameRate: $<HTMLSelectElement>("framerate").value,
    keepAudio: $<HTMLInputElement>("keep-audio").checked,
    advanced: $<HTMLDetailsElement>("advanced-toggle").open,
    theme: theme ?? "system"
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

function setSelect(id: string, value: string | undefined): void {
  if (!value) return;
  const select = $<HTMLSelectElement>(id);
  if (Array.from(select.options).some((option) => option.value === value)) select.value = value;
}

function applyTheme(theme: ThemePreference): void {
  document.body.dataset.theme = theme;
  const input = document.querySelector<HTMLInputElement>(`input[name="theme"][value="${theme}"]`);
  if (input) input.checked = true;
  void getApi().setThemeSource(theme).catch(() => undefined);
}

function sanitizePreferences(raw: string | null): Preferences | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Preferences;
    if (!value || typeof value !== "object") return null;
    const preferences: Preferences = {};
    if (value.mode === "compress" || value.mode === "convert") preferences.mode = value.mode;
    if (typeof value.targetMb === "number" && Number.isFinite(value.targetMb) && value.targetMb > 0) preferences.targetMb = value.targetMb;
    if (typeof value.concurrency === "number" && Number.isFinite(value.concurrency)) {
      preferences.concurrency = Math.min(8, Math.max(0, Math.round(value.concurrency)));
    }
    if (value.audioBitrate === "96" || value.audioBitrate === "128" || value.audioBitrate === "160" || value.audioBitrate === "192") {
      preferences.audioBitrate = value.audioBitrate;
    }
    if (value.videoCodec === "h264" || value.videoCodec === "h265") preferences.videoCodec = value.videoCodec;
    if (value.encoderPreference === "auto" || value.encoderPreference === "cpu" || value.encoderPreference === "nvidia"
      || value.encoderPreference === "intel" || value.encoderPreference === "amd") {
      preferences.encoderPreference = value.encoderPreference;
    }
    if (value.preset === "ultrafast" || value.preset === "veryfast" || value.preset === "faster"
      || value.preset === "fast" || value.preset === "medium" || value.preset === "slow") {
      preferences.preset = value.preset;
    }
    if (value.resolution === "original" || value.resolution === "1080p" || value.resolution === "720p" || value.resolution === "480p") {
      preferences.resolution = value.resolution;
    }
    if (value.frameRate === "original" || value.frameRate === "24" || value.frameRate === "25" || value.frameRate === "30" || value.frameRate === "60") {
      preferences.frameRate = value.frameRate;
    }
    if (typeof value.keepAudio === "boolean") preferences.keepAudio = value.keepAudio;
    if (typeof value.advanced === "boolean") preferences.advanced = value.advanced;
    if (value.theme === "system" || value.theme === "light" || value.theme === "dark") preferences.theme = value.theme;
    return preferences;
  } catch {
    return null;
  }
}

function sanitizeHistory(raw: string | null): HistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries: HistoryEntry[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<HistoryEntry>;
      if (typeof candidate.id !== "string" || typeof candidate.inputPath !== "string") continue;
      if (typeof candidate.finishedAt !== "string") continue;
      if (candidate.status !== "completed" && candidate.status !== "failed" && candidate.status !== "cancelled") continue;
      if (typeof candidate.originalBytes !== "number" || !Number.isFinite(candidate.originalBytes)) continue;
      entries.push({
        id: candidate.id,
        inputPath: candidate.inputPath,
        outputPath: typeof candidate.outputPath === "string" ? candidate.outputPath : null,
        finishedAt: candidate.finishedAt,
        originalBytes: candidate.originalBytes,
        outputBytes: typeof candidate.outputBytes === "number" && Number.isFinite(candidate.outputBytes) ? candidate.outputBytes : null,
        status: candidate.status,
        error: typeof candidate.error === "string" ? candidate.error : undefined,
        durationSeconds: typeof candidate.durationSeconds === "number" && Number.isFinite(candidate.durationSeconds)
          ? candidate.durationSeconds
          : null
      });
      if (entries.length >= 200) break;
    }
    return entries;
  } catch {
    return [];
  }
}

function loadPreferences(): void {
  try {
    const preferences = sanitizePreferences(localStorage.getItem(STORAGE_KEY));
    if (!preferences) {
      applyTheme("system");
      return;
    }
    if (preferences.mode === "compress" || preferences.mode === "convert") {
      const input = document.querySelector<HTMLInputElement>(`input[name="processing-mode"][value="${preferences.mode}"]`);
      if (input) input.checked = true;
    }
    if (typeof preferences.targetMb === "number" && preferences.targetMb > 0) $<HTMLInputElement>("target-mb").value = String(preferences.targetMb);
    if (typeof preferences.concurrency === "number") {
      setSelect("concurrency", String(preferences.concurrency));
    }
    setSelect("audio-bitrate", preferences.audioBitrate);
    setSelect("video-codec", preferences.videoCodec);
    setSelect("encoder-preference", preferences.encoderPreference);
    setSelect("preset", preferences.preset);
    setSelect("resolution", preferences.resolution);
    setSelect("framerate", preferences.frameRate);
    if (typeof preferences.keepAudio === "boolean") $<HTMLInputElement>("keep-audio").checked = preferences.keepAudio;
    if (typeof preferences.advanced === "boolean") $<HTMLDetailsElement>("advanced-toggle").open = preferences.advanced;
    applyTheme(preferences.theme === "light" || preferences.theme === "dark" ? preferences.theme : "system");
    syncSettingsMirrors(true);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    applyTheme("system");
  }
}

function loadHistory(): void {
  historyEntries.length = 0;
  try {
    const entries = sanitizeHistory(localStorage.getItem(HISTORY_KEY));
    historyEntries.push(...entries);
    if (localStorage.getItem(HISTORY_KEY) && entries.length === 0) localStorage.removeItem(HISTORY_KEY);
  } catch {
    localStorage.removeItem(HISTORY_KEY);
  }
}

function saveHistory(): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(historyEntries.slice(0, 200)));
}

function pushHistory(item: BatchItem): void {
  if (item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled") return;
  if (item.status === "completed" && !item.result?.outputPath) return;
  const entry: HistoryEntry = {
    id: `${item.id}-${item.status}-${item.result?.outputPath ?? item.error ?? "done"}`,
    inputPath: item.inputPath,
    outputPath: item.result?.outputPath ?? null,
    finishedAt: new Date().toISOString(),
    originalBytes: item.metadata.size || item.result?.originalBytes || 0,
    outputBytes: item.result?.outputBytes ?? null,
    status: item.status,
    error: item.error,
    durationSeconds: item.metadata.duration || null
  };
  if (historyEntries.some((existing) => existing.id === entry.id)) return;
  historyEntries.unshift(entry);
  if (historyEntries.length > 200) historyEntries.length = 200;
  saveHistory();
  renderHistory();
}

function renderHistory(): void {
  const list = $("history-list");
  list.replaceChildren();
  $("history-empty").classList.toggle("hidden", historyEntries.length > 0);
  for (const entry of historyEntries) {
    const tr = document.createElement("tr");
    const saving = entry.outputBytes != null && entry.originalBytes > 0
      ? `${Math.abs((1 - entry.outputBytes / entry.originalBytes) * 100).toFixed(1)}%`
      : "—";
    tr.innerHTML = `
      <td title="${entry.inputPath}"><strong>${fileName(entry.inputPath)}</strong></td>
      <td>${new Date(entry.finishedAt).toLocaleString("nl-BE")}</td>
      <td>${formatBytes(entry.originalBytes)}</td>
      <td>${entry.outputBytes != null ? formatBytes(entry.outputBytes) : "—"}</td>
      <td>${saving}</td>
      <td><span class="status-chip ${entry.status}">${STATUS_LABEL[entry.status]}</span></td>
      <td class="col-actions"></td>`;
    const actions = tr.querySelector(".col-actions")!;
    if (entry.outputPath) {
      const openBtn = document.createElement("button");
      openBtn.className = "btn text";
      openBtn.type = "button";
      openBtn.textContent = "Afspelen";
      openBtn.onclick = () => { void getApi().openFile(entry.outputPath!).then((error) => { if (error) toast(error, "error"); }); };
      const revealBtn = document.createElement("button");
      revealBtn.className = "btn text";
      revealBtn.type = "button";
      revealBtn.textContent = "In map";
      revealBtn.onclick = () => { void getApi().showInFolder(entry.outputPath!); };
      actions.append(openBtn, revealBtn);
    } else {
      actions.textContent = entry.error ? entry.error.slice(0, 48) : "—";
    }
    list.append(tr);
  }
}

function renderDetails(): void {
  const empty = $("detail-empty");
  const body = $("detail-body");
  const item = selectedId ? items.get(selectedId) : null;
  if (!item) {
    empty.classList.remove("hidden");
    body.classList.add("hidden");
    body.replaceChildren();
    return;
  }
  empty.classList.add("hidden");
  body.classList.remove("hidden");
  const settings = effectiveSettings(item);
  const rows: Array<[string, string]> = [
    ["Bestand", fileName(item.inputPath)],
    ["Pad", item.inputPath],
    ["Grootte", formatBytes(item.metadata.size)],
    ["Duur", formatDuration(item.metadata.duration)],
    ["Resolutie", item.metadata.width ? `${item.metadata.width}×${item.metadata.height}` : "—"],
    ["Video", item.metadata.videoCodec || "—"],
    ["Audio", item.metadata.audioCodec ?? "geen"],
    ["Framerate", item.metadata.frameRate ? `${item.metadata.frameRate}` : "—"],
    ["Modus", settings.mode === "compress" ? "Comprimeren" : "Converteren"],
    ["Doel", settings.mode === "compress" ? `${settings.targetMb} MB` : "—"],
    ["Codec", settings.videoCodec.toUpperCase()],
    ["Encoderkeuze", settings.encoderPreference ?? "auto"],
    ["Preset", settings.preset],
    ["Status", STATUS_LABEL[item.status]]
  ];
  if (item.progress.encoderLabel) rows.push(["Actieve encoder", item.progress.encoderLabel]);
  if (item.result) {
    rows.push(["Resultaat", formatBytes(item.result.outputBytes)], ["Uitvoer", item.result.outputPath], ["Besparing", savingLabel(item.result).text]);
    if (item.result.performance) {
      const perf = item.result.performance;
      rows.push(
        ["Gebruikte encoder", perf.encoderLabel + (perf.fellBackToCpu ? " (fallback CPU)" : "")],
        ["Encodingtijd", `${(perf.encodingMs / 1000).toFixed(1)} s`],
        ["Totale tijd", `${(perf.totalMs / 1000).toFixed(1)} s`],
        ["Gem. FPS", perf.averageFps != null ? String(perf.averageFps) : "—"]
      );
    }
  }
  if (item.error) rows.push(["Fout", item.error]);
  body.replaceChildren(...rows.flatMap(([dt, dd]) => {
    const term = document.createElement("dt");
    term.textContent = dt;
    const def = document.createElement("dd");
    def.textContent = dd;
    return [term, def];
  }));
}

function selectItem(id: string | null): void {
  selectedId = id;
  renderQueue();
}

function navigate(page: PageId): void {
  currentPage = page;
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll<HTMLElement>(".page").forEach((panel) => {
    const active = panel.dataset.pagePanel === page;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  $("page-title").textContent = PAGE_COPY[page].title;
  $("page-subtitle").textContent = PAGE_COPY[page].subtitle;
  $("converter-action-bar").classList.toggle("hidden", page !== "converter");
  if (page === "about") renderAbout();
  if (page === "history") renderHistory();
}

function renderAbout(): void {
  const list = $("about-list");
  const rows: Array<[string, string]> = [
    ["Applicatie", appInfo?.name ?? "Video Compressor"],
    ["Versie", appInfo?.version ?? "—"],
    ["Electron", appInfo?.electron ?? "—"],
    ["FFmpeg", ffmpegStatusCache?.version ?? "—"],
    ["FFmpeg-status", ffmpegStatusCache?.message ?? "—"],
    ["FFmpeg-locatie", ffmpegStatusCache?.location ?? "—"],
    ["Installatiemap", appInfo?.appDirectory ?? "—"],
    ["User data", appInfo?.userData ?? "—"],
    ["Update", latestUpdate?.message ?? "—"]
  ];
  list.replaceChildren(...rows.flatMap(([dt, dd]) => {
    const term = document.createElement("dt");
    term.textContent = dt;
    const def = document.createElement("dd");
    def.textContent = dd;
    return [term, def];
  }));
}

async function addFiles(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const unique: string[] = [];
  const existing = new Set([...items.values()].map((item) => item.inputPath.toLowerCase()));
  for (const path of paths) {
    const key = path.toLowerCase();
    if (existing.has(key) || unique.some((candidate) => candidate.toLowerCase() === key)) continue;
    unique.push(path);
  }
  if (!unique.length) {
    toast("Die bestanden staan al in de wachtrij.");
    return;
  }
  let failed = 0;
  for (const path of unique) {
    try {
      const metadata = await getApi().probe(path);
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const item: BatchItem = {
        id,
        inputPath: path,
        metadata,
        settings: readSettings(),
        status: "queued",
        progress: { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" }
      };
      items.set(id, item);
      if (!selectedId) selectedId = id;
    } catch (error) {
      failed += 1;
      if (failed <= 3) toast(error instanceof Error ? error.message : "Bestand kon niet worden gelezen.", "error");
    }
  }
  const added = unique.length - failed;
  if (added > 0) toast(`${added} bestand${added === 1 ? "" : "en"} toegevoegd.`, "ok");
  renderQueue();
}

function filePaths(transfer: DataTransfer | null): string[] {
  if (!transfer) return [];
  return Array.from(transfer.files)
    .map((file) => {
      try { return getApi().getPathForFile(file); } catch { return (file as File & { path?: string }).path ?? ""; }
    })
    .filter(Boolean);
}

async function startBatch(): Promise<void> {
  const settings = readSettings();
  const problem = validateForStart(settings);
  if (problem) {
    toast(problem, "error");
    return;
  }
  const queued = [...items.values()].filter((item) => item.status === "queued").map((item) => ({
    ...item,
    settings: effectiveSettings(item),
    progress: { status: "analyzing" as const, percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" },
    error: undefined,
    result: undefined
  }));
  if (!queued.length) return;
  for (const item of queued) items.set(item.id, item);
  batchRunning = true;
  lastBatchRuntime = null;
  renderQueue();
  try {
    await getApi().startBatch(queued, readConcurrency());
  } finally {
    batchRunning = false;
    renderQueue();
    const summary = localSummary();
    if (summary.failed) toast(`${summary.failed} bestand(en) mislukt.`, "error");
    else if (summary.completed) toast(`${summary.completed} bestand(en) klaar.`, "ok");
  }
}

function applyFfmpegStatus(status: FfmpegStatus): void {
  ffmpegStatusCache = status;
  ffmpegState = status.state;
  ffmpegReady = status.available;
  const panel = $("ffmpeg-panel");
  const chip = $("sidebar-ffmpeg");
  panel.classList.remove("is-ok", "is-bad", "is-wait");
  if (status.state === "checking") {
    panel.classList.add("is-wait");
    chip.dataset.state = "wait";
    chip.textContent = "FFmpeg controleren";
  } else if (status.available) {
    panel.classList.add("is-ok");
    chip.dataset.state = "ok";
    chip.textContent = "FFmpeg klaar";
  } else {
    panel.classList.add("is-bad");
    chip.dataset.state = "error";
    chip.textContent = "FFmpeg ontbreekt";
  }
  $("ffmpeg-status").textContent = status.state === "checking"
    ? "Bezig met zoeken en valideren…"
    : status.message;
  $("ffmpeg-location").textContent = status.location ?? (status.available ? "Windows PATH" : "Niet gevonden");
  const hw = status.hardware ?? { nvidia: { h264: false, h265: false }, intel: { h264: false, h265: false }, amd: { h264: false, h265: false } };
  $("ffmpeg-codecs").textContent = [
    `H.264 ${status.codecs.h264 ? "aanwezig" : "ontbreekt"}`,
    `H.265 ${status.codecs.h265 ? "aanwezig" : "ontbreekt"}`,
    `AAC ${status.codecs.aac ? "aanwezig" : "ontbreekt"}`,
    `NVENC ${hw.nvidia.h264 || hw.nvidia.h265 ? "ok" : "nee"}`,
    `AMF ${hw.amd.h264 || hw.amd.h265 ? "ok" : "nee"}`,
    `QSV ${hw.intel.h264 || hw.intel.h265 ? "ok" : "nee"}`
  ].join(" · ");
  $("ffmpeg-install").classList.toggle("hidden", status.available || status.state === "checking" || !installing);
  applyCodecAvailability(status);
  applyEncoderAvailability(status);
  syncActions();
  if (status.available) void reprobeQueued();
  if (currentPage === "about") renderAbout();
}

function applyCodecAvailability(status: FfmpegStatus): void {
  for (const id of ["video-codec", "settings-codec"] as const) {
    const select = $<HTMLSelectElement>(id);
    const h265 = Array.from(select.options).find((option) => option.value === "h265");
    if (!h265) continue;
    if (!status.available) {
      h265.disabled = true;
      h265.textContent = "H.265 (FFmpeg niet beschikbaar)";
    } else if (!status.codecs.h265) {
      h265.disabled = true;
      h265.textContent = "H.265 (niet ondersteund door deze FFmpeg)";
    } else {
      h265.disabled = false;
      h265.textContent = "H.265";
    }
    if (h265.disabled && select.value === "h265") {
      select.value = "h264";
      if (id === "video-codec") syncSettingsMirrors(true);
      else syncSettingsMirrors(false);
      savePreferences();
    }
  }
}

function applyEncoderAvailability(status: FfmpegStatus): void {
  const hw = status.hardware ?? { nvidia: { h264: false, h265: false }, intel: { h264: false, h265: false }, amd: { h264: false, h265: false } };
  const hint = $("encoder-hint");
  for (const id of ["encoder-preference", "settings-encoder"] as const) {
    const select = $<HTMLSelectElement>(id);
    const setOption = (value: string, enabled: boolean, label: string): void => {
      const option = Array.from(select.options).find((entry) => entry.value === value);
      if (!option) return;
      option.disabled = !enabled;
      option.textContent = label;
    };
    setOption("auto", true, "Automatisch");
    setOption("cpu", status.available, status.available ? "CPU" : "CPU (FFmpeg ontbreekt)");
    setOption("nvidia", Boolean(hw.nvidia.h264 || hw.nvidia.h265), hw.nvidia.h264 || hw.nvidia.h265 ? "NVIDIA" : "NVIDIA (niet beschikbaar)");
    setOption("intel", Boolean(hw.intel.h264 || hw.intel.h265), hw.intel.h264 || hw.intel.h265 ? "Intel" : "Intel (niet beschikbaar)");
    setOption("amd", Boolean(hw.amd.h264 || hw.amd.h265), hw.amd.h264 || hw.amd.h265 ? "AMD" : "AMD (niet beschikbaar)");
    const selected = select.options[select.selectedIndex];
    if (selected?.disabled) {
      select.value = "auto";
      if (id === "encoder-preference") syncSettingsMirrors(true);
      else syncSettingsMirrors(false);
      savePreferences();
    }
  }
  const active = [];
  if (hw.nvidia.h264 || hw.nvidia.h265) active.push("NVIDIA");
  if (hw.amd.h264 || hw.amd.h265) active.push("AMD");
  if (hw.intel.h264 || hw.intel.h265) active.push("Intel");
  hint.textContent = active.length
    ? `Automatisch gebruikt ${active.join(" / ")} wanneer beschikbaar; anders CPU. Snellere presets = grotere bestanden bij dezelfde kwaliteit.`
    : "Geen bruikbare hardware-encoder gevonden; Automatisch gebruikt CPU. Snellere presets = grotere bestanden bij dezelfde kwaliteit.";
}

async function reprobeQueued(): Promise<void> {
  if (reprobeRunning || !ffmpegReady) return;
  const pending = [...items.values()].filter((item) => item.status === "queued" && (!item.metadata.duration || !item.metadata.width));
  if (!pending.length) return;
  reprobeRunning = true;
  try {
    for (const item of pending) {
      try {
        const metadata = await getApi().probe(item.inputPath);
        items.set(item.id, { ...item, metadata });
      } catch {
        // Keep placeholder metadata until start-batch rechecks.
      }
    }
    renderQueue();
  } finally {
    reprobeRunning = false;
  }
}

function applyUpdateState(state: UpdateState): void {
  latestUpdate = state;
  const panel = $("update-panel");
  const visible = state.status === "checking" || state.status === "available" || state.status === "downloading" || state.status === "downloaded" || state.status === "error";
  panel.classList.toggle("hidden", !visible);
  panel.dataset.status = state.status;
  $("update-status").textContent = state.message;
  $("settings-update-status").textContent = state.message;
  $("update-progress-wrap").classList.toggle("hidden", state.status !== "downloading");
  $("update-progress").style.width = `${Math.max(0, Math.min(100, state.percent))}%`;
  $("update-download").classList.toggle("hidden", state.status !== "available");
  $("update-install").classList.toggle("hidden", state.status !== "downloaded");
  $("update-later").classList.toggle("hidden", state.status !== "available" && state.status !== "downloaded");
  $("settings-update-download").classList.toggle("hidden", state.status !== "available");
  $("settings-update-install").classList.toggle("hidden", state.status !== "downloaded");
  const versionButton = $<HTMLButtonElement>("check-updates");
  versionButton.classList.toggle("has-update", state.status === "available" || state.status === "downloaded");
  versionButton.textContent = state.availableVersion && (state.status === "available" || state.status === "downloading" || state.status === "downloaded")
    ? `Update ${state.availableVersion}`
    : "Updates";
  const notes = $("update-notes");
  const noteText = state.releaseNotes?.trim() ?? "";
  notes.textContent = noteText;
  notes.classList.toggle("hidden", !noteText || (state.status !== "available" && state.status !== "downloaded"));
  if (appInfo) $("sidebar-version").textContent = `v${appInfo.version}`;
  if (currentPage === "about") renderAbout();
}

getApi().onBatchUpdate((update) => {
  const previous = items.get(update.item.id);
  items.set(update.item.id, update.item);
  if (update.summary.runtime) lastBatchRuntime = update.summary.runtime;
  if (previous && previous.status !== update.item.status && (update.item.status === "completed" || update.item.status === "failed" || update.item.status === "cancelled")) {
    pushHistory(update.item);
  }
  renderQueue();
});

getApi().onBinaryStatus(applyFfmpegStatus);
getApi().onBinaryError((message) => toast(message, "error"));
getApi().onFfmpegInstallProgress((percent) => {
  installing = true;
  $("ffmpeg-install").classList.remove("hidden");
  $("ffmpeg-install-progress").style.width = `${Math.max(0, Math.min(100, percent))}%`;
});
getApi().onUpdateStatus(applyUpdateState);

document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((button) => {
  button.onclick = () => navigate((button.dataset.page as PageId) || "converter");
});

document.querySelectorAll<HTMLInputElement>('input[name="processing-mode"]').forEach((input) => {
  input.addEventListener("change", () => {
    updateModeUi();
    savePreferences();
  });
});

document.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    applyTheme(input.value as ThemePreference);
    savePreferences();
  });
});

for (const id of ["target-mb", "audio-bitrate", "video-codec", "encoder-preference", "preset", "concurrency", "resolution", "framerate", "keep-audio"]) {
  $(id).addEventListener("change", () => {
    syncSettingsMirrors(true);
    savePreferences();
    renderQueue();
  });
}
$("advanced-toggle").addEventListener("toggle", () => savePreferences());

for (const id of ["settings-target-mb", "settings-audio", "settings-codec", "settings-encoder", "settings-preset", "settings-concurrency", "settings-resolution", "settings-framerate", "settings-keep-audio"]) {
  $(id).addEventListener("change", () => {
    syncSettingsMirrors(false);
    savePreferences();
    updateModeUi();
  });
}

$("queue-filters").onclick = (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-filter]");
  if (!button?.dataset.filter) return;
  queueFilter = button.dataset.filter as QueueFilter;
  renderQueue();
};

$("file-list").onclick = (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>("tr[data-id]");
  if (!row?.dataset.id) return;
  const item = items.get(row.dataset.id);
  if (!item) return;
  const action = target.closest<HTMLButtonElement>("[data-action]")?.dataset.action;
  if (!action) {
    selectItem(item.id);
    return;
  }
  event.stopPropagation();
  if (action === "cancel") getApi().cancelItem(item.id);
  else if (action === "retry") {
    items.set(item.id, {
      ...item,
      status: "queued",
      error: undefined,
      result: undefined,
      settings: readSettings(),
      progress: { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" }
    });
    renderQueue();
  } else if (action === "open" && item.result) void getApi().openFile(item.result.outputPath).then((error) => { if (error) toast(error, "error"); });
  else if (action === "reveal" && item.result) void getApi().showInFolder(item.result.outputPath);
  else if (action === "save" && item.result) {
    void getApi().saveCopy(item.result.outputPath).then((path) => { if (path) toast("Kopie opgeslagen.", "ok"); });
  } else if (action === "remove" && item.status !== "running") {
    items.delete(item.id);
    dismissed.add(item.id);
    if (selectedId === item.id) selectedId = null;
    renderQueue();
  }
};

$("file-list").oninput = (event) => {
  const input = event.target as HTMLInputElement;
  if (!(input instanceof HTMLInputElement) || !input.classList.contains("item-target")) return;
  const row = input.closest<HTMLElement>("tr[data-id]");
  const item = row?.dataset.id ? items.get(row.dataset.id) : null;
  if (!item || item.status !== "queued" || batchRunning) return;
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) {
    toast("Doelgrootte moet groter zijn dan 0 MB.", "error");
    return;
  }
  items.set(item.id, {
    ...item,
    targetOverridden: true,
    settings: { ...effectiveSettings(item), targetMb: value }
  });
  renderDetails();
};

$("select-button").onclick = () => { void getApi().selectFiles().then(addFiles); };
$("compress-button").onclick = () => { void startBatch().catch((error: Error) => toast(error.message, "error")); };
$("cancel-button").onclick = () => getApi().cancelBatch();
$("retry-failed").onclick = () => {
  for (const item of items.values()) {
    if (item.status === "failed" || item.status === "cancelled") {
      items.set(item.id, {
        ...item,
        status: "queued",
        error: undefined,
        result: undefined,
        progress: { status: "analyzing", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Wachtend" }
      });
    }
  }
  renderQueue();
};
$("clear-completed").onclick = () => {
  for (const [id, item] of items) if (item.status === "completed") items.delete(id);
  if (selectedId && !items.has(selectedId)) selectedId = null;
  renderQueue();
};
$("clear-button").onclick = () => {
  for (const [id, item] of items) if (item.status !== "running") items.delete(id);
  if (selectedId && !items.has(selectedId)) selectedId = null;
  renderQueue();
};
$("reset-targets").onclick = () => {
  let count = 0;
  const globalTarget = Number($<HTMLInputElement>("target-mb").value) || 50;
  for (const item of items.values()) {
    if (item.status === "queued" && item.targetOverridden) {
      items.set(item.id, { ...item, targetOverridden: false, settings: { ...item.settings, targetMb: globalTarget } });
      count += 1;
    }
  }
  toast(count ? `${count} doelgrootte${count === 1 ? "" : "s"} teruggezet.` : "Geen afwijkende doelgroottes.", count ? "ok" : "info");
  renderQueue();
};

$("ffmpeg-recheck").onclick = () => { void getApi().recheckFfmpeg().then(applyFfmpegStatus); };
$("ffmpeg-select").onclick = () => { void getApi().selectFfmpeg().then(applyFfmpegStatus).catch((error: Error) => toast(error.message, "error")); };
$("ffmpeg-install-button").onclick = () => {
  installing = true;
  $("ffmpeg-install").classList.remove("hidden");
  void getApi().installFfmpeg().then((status) => {
    installing = false;
    applyFfmpegStatus(status);
    toast(status.available ? "FFmpeg geïnstalleerd." : status.message, status.available ? "ok" : "error");
  }).catch((error: Error) => {
    installing = false;
    toast(error.message, "error");
  });
};

const runUpdateCheck = () => { void getApi().checkForUpdates().then(applyUpdateState).catch((error: Error) => toast(error.message, "error")); };
const runUpdateDownload = () => { void getApi().downloadUpdate().then(applyUpdateState).catch((error: Error) => toast(error.message, "error")); };
const runUpdateInstall = () => { void getApi().installUpdate(); };
$("check-updates").onclick = runUpdateCheck;
$("update-check").onclick = runUpdateCheck;
$("settings-update-check").onclick = runUpdateCheck;
$("update-download").onclick = runUpdateDownload;
$("settings-update-download").onclick = runUpdateDownload;
$("update-install").onclick = runUpdateInstall;
$("settings-update-install").onclick = runUpdateInstall;
$("update-later").onclick = () => $("update-panel").classList.add("hidden");
$("history-clear").onclick = () => {
  historyEntries.length = 0;
  saveHistory();
  renderHistory();
};
$("about-copy").onclick = async () => {
  const text = Array.from($("about-list").querySelectorAll("dt")).map((dt, index) => {
    const dd = $("about-list").querySelectorAll("dd")[index];
    return `${dt.textContent}: ${dd?.textContent ?? ""}`;
  }).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Diagnostiek gekopieerd.", "ok");
  } catch {
    toast("Kopiëren mislukt.", "error");
  }
};

let dragDepth = 0;
const dropZone = $("drop-zone");
window.addEventListener("dragenter", (event) => { event.preventDefault(); dragDepth++; dropZone.classList.add("dragging"); });
window.addEventListener("dragover", (event) => { event.preventDefault(); });
window.addEventListener("dragleave", (event) => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) dropZone.classList.remove("dragging"); });
window.addEventListener("drop", (event) => { event.preventDefault(); dragDepth = 0; dropZone.classList.remove("dragging"); void addFiles(filePaths(event.dataTransfer)); });

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (document.body.dataset.theme === "system") applyTheme("system");
});

loadPreferences();
loadHistory();
updateModeUi();
renderQueue();
renderHistory();
navigate("converter");

void getApi().getAppInfo().then((info) => {
  appInfo = info;
  $("sidebar-version").textContent = `v${info.version}`;
  renderAbout();
}).catch(() => {
  $("sidebar-version").textContent = "v?";
});

void getApi().ffmpegStatus().then(applyFfmpegStatus).catch((error: Error) => {
  $("ffmpeg-status").textContent = `Controle mislukt: ${error.message}`;
});
void getApi().getUpdateStatus().then(applyUpdateState).catch(() => undefined);

window.setInterval(() => {
  if (ffmpegState === "checking") void getApi().ffmpegStatus().then(applyFfmpegStatus).catch(() => undefined);
}, 500);

window.setTimeout(() => {
  if (ffmpegState === "checking") {
    $("ffmpeg-status").textContent = "De controle duurt te lang. Probeer opnieuw.";
  }
}, 20_000);

if (!window.videoCompressor) {
  $("ffmpeg-panel").classList.add("is-bad");
  $("sidebar-ffmpeg").dataset.state = "error";
  $("sidebar-ffmpeg").textContent = "Preload ontbreekt";
  $("ffmpeg-status").textContent = "De applicatie-API is niet geladen. Start via Electron.";
}
