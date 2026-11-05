import { Compressor } from "./compressor";
import { BatchItem, BatchUpdate, CompressionProgress } from "../shared/types";

export type BatchListener = (update: BatchUpdate) => void;

export class BatchManager {
  private items = new Map<string, BatchItem>();
  private active = new Map<string, Compressor>();
  private cancelled = false;
  private running = false;
  private listener: BatchListener | null = null;

  constructor(private readonly ffmpegPath: string, private readonly concurrency = 1) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Paralleliteit moet minstens 1 zijn.");
  }

  async start(items: BatchItem[], listener: BatchListener): Promise<BatchItem[]> {
    if (this.running) throw new Error("Er draait al een batch.");
    this.running = true;
    this.listener = listener;
    this.cancelled = false;
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
    }
  }

  cancelAll(): void {
    this.cancelled = true;
    for (const compressor of this.active.values()) compressor.cancel();
  }

  cancelItem(id: string): void {
    this.items.get(id) && this.active.get(id)?.cancel();
    const item = this.items.get(id);
    if (item?.status === "queued") {
      item.status = "cancelled";
      item.progress = this.progress("cancelled", "Geannuleerd");
      if (this.listener) this.emit(this.listener, item);
    }
  }

  private async worker(listener: BatchListener): Promise<void> {
    while (!this.cancelled) {
      const item = [...this.items.values()].find((candidate) => candidate.status === "queued");
      if (!item) return;
      item.status = "running";
      this.emit(listener, item);
      const compressor = new Compressor();
      this.active.set(item.id, compressor);
      try {
        // MP4 altijd naast het bronbestand, zonder aparte uitvoermap.
        item.result = await compressor.compress(this.ffmpegPath, item.inputPath, item.metadata, item.settings, (progress) => {
          item.progress = progress;
          this.emit(listener, item);
        });
        item.status = "completed";
        item.progress = this.progress("completed", "Voltooid", 100);
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

  private summary(): BatchUpdate["summary"] {
    const summary = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const item of this.items.values()) summary[item.status]++;
    return summary;
  }
}
