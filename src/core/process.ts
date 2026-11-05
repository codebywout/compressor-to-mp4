import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class ManagedProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;

  constructor(command: string, args: string[]) {
    super();
    this.child = spawn(command, args, { windowsHide: true });
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString()));
    this.child.stdout.on("data", (chunk: Buffer) => this.emit("stdout", chunk.toString()));
    this.child.on("error", (error) => this.emit("error", error));
    this.child.on("close", (code, signal) => this.emit("close", code, signal));
  }

  cancel(): void {
    if (!this.child.killed) this.child.kill();
  }
}

export function runProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = new ManagedProcess(command, args);
    let output = "";
    process.on("stdout", (text: string) => output += text);
    process.on("stderr", (text: string) => output += text);
    process.on("error", reject);
    process.on("close", (code: number | null) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} is mislukt (exitcode ${code}). ${output.slice(-1200)}`));
    });
  });
}
