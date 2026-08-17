import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface JsonFileLoggerEntry {
  timestamp: string;
  event: string;
  [key: string]: unknown;
}

export class JsonFileLogger {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async write(entry: JsonFileLoggerEntry): Promise<void> {
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    }).catch(() => undefined);
    await this.queue;
  }
}
