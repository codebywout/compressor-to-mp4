import { Compressor } from "./compressor";
import { EMPTY_HARDWARE, HardwareCapabilities } from "./encoders";
import { OutputPathAllocator } from "./output-paths";
import { selectNextQueuedItem } from "./scheduler";
import { BatchItem, BatchRuntimeInfo, BatchSummary, BatchUpdate, CompressionProgress } from "../shared/types";

export type BatchListener = (update: BatchUpdate) => void;

export interface BatchManagerOptions {
  hardware?: HardwareCapabilities;
  runtime?: BatchRuntimeInfo;
}

export class BatchManager {
  private items = new Map<string, BatchItem>();
  private active = new Map<string, Compressor>();
  private cancelled = false;
  private running = false;
  private listener: BatchListener | null = null;
  private readonly outputAllocator = new OutputPathAllocator();
  private readonly hardware: HardwareCapabilities;
  private readonly runtime: BatchRuntimeInfo;

  constructor(
    private readonly ffmpegPath: string,
    private readonly concurrency = 1,
    options: BatchManagerOptions = {},
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Paralleliteit moet minstens 1 zijn.");
    this.hardware = options.hardware ?? EMPTY_HARDWARE;
    this.runtime = options.runtime ?? {
      concurrency,
      concurrencyMode: "manual",
      encoderFamily: "cpu",
      encoderLabel: "CPU"
    };
  }

  async start(items: BatchItem[], listener: BatchListener): Promise<BatchItem[]> {
    if (this.running) throw new Error("Er draait al een batch.");
    this.running = true;
    this.listener = listener;
    this.cancelled = false;
    this.outputAllocator.clear();
    this.items = new Map(items.map((item) => [
      item.id,
      item.status === "failed" || item.status === "cancelled" ? { ...item } : { ...item, status: "queued" }
    ]));
    this.emitAll(listener);
    try {
      await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, () => this.worker(listener)));
      return [...this.items.values()];
    } finally {
      this.running = false;
      this.active.clear();
      this.listener = null;
      this.outputAllocator.clear();
    }
  }

  cancelAll(): void {
    this.cancelled = true;
    for (const compressor of this.active.values()) compressor.cancel();
  }

  cancelItem(id: string): void {
    this.active.get(id)?.cancel();
    const item = this.items.get(id);
    if (item?.status === "queued") {
      item.status = "cancelled";
      item.progress = this.progress("cancelled", "Geannuleerd");
      if (this.listener) this.emit(this.listener, item);
    }
  }

  private claimNext(): BatchItem | null {
    const next = selectNextQueuedItem(this.items.values());
    if (!next) return null;
    next.status = "running";
    return next;
  }

  private async worker(listener: BatchListener): Promise<void> {
    while (!this.cancelled) {
      const item = this.claimNext();
      if (!item) return;
      this.emit(listener, item);
      const compressor = new Compressor();
      this.active.set(item.id, compressor);
      try {
        item.result = await compressor.compress(
          this.ffmpegPath,
          item.inputPath,
          item.metadata,
          item.settings,
          (progress) => {
            item.progress = progress;
            this.emit(listener, item);
          },
          { outputAllocator: this.outputAllocator, hardware: this.hardware }
        );
        if (!item.result?.outputPath) {
          item.status = "failed";
          item.error = "Uitvoerbestand ontbreekt na verwerking.";
          item.progress = this.progress("error", item.error);
        } else {
          item.status = "completed";
          const fallbackNote = item.result.performance?.fellBackToCpu ? " · fallback CPU" : "";
          const encoderNote = item.result.performance?.encoderLabel
            ? ` · ${item.result.performance.encoderLabel}`
            : "";
          item.progress = this.progress("completed", `Voltooid${encoderNote}${fallbackNote}`, 100);
          if (item.result.performance?.encoderLabel) {
            item.progress.encoderLabel = item.result.performance.encoderLabel;
          }
        }
      } catch (error) {
        const message = (error as Error).message;
        item.status = message.includes("geannuleerd") ? "cancelled" : "failed";
        item.error = message;
        item.progress = this.progress(item.status === "cancelled" ? "cancelled" : "error", message);
      } finally {
        this.active.delete(item.id);
        this.emit(listener, item);
      }
    }
    for (const item of this.items.values()) {
      if (item.status === "queued") {
        item.status = "cancelled";
        item.progress = this.progress("cancelled", "Geannuleerd");
        this.emit(listener, item);
      }
    }
  }

  private progress(status: CompressionProgress["status"], message: string, percent = 0): CompressionProgress {
    return { status, percent, speed: "", etaSeconds: null, bitrate: "", message };
  }

  private emit(listener: BatchListener, item: BatchItem): void {
    listener({ item: { ...item }, summary: this.summary() });
  }

  private emitAll(listener: BatchListener): void {
    for (const item of this.items.values()) this.emit(listener, item);
  }

  private summary(): BatchSummary {
    const summary: BatchSummary = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      runtime: this.runtime
    };
    for (const item of this.items.values()) summary[item.status]++;
    return summary;
  }
}
