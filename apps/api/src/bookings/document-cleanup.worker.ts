import { Inject, Injectable, type BeforeApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { cleanupDocumentObjects, DocumentStorage } from './document-storage';

/** Reconciles abandoned uploads/deleted files without requiring a separate cron.
 * The durable journal and 24-hour grace period are shared across app instances;
 * repeated deletes are idempotent. Never expires referenced booking documents.
 */
@Injectable()
export class DocumentCleanupWorker implements OnModuleInit, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly stop = new AbortController();
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(DocumentStorage) private readonly storage: DocumentStorage,
  ) {}

  onModuleInit() {
    if (this.storage.cloud && process.env.NODE_ENV !== 'test') this.schedule(60000);
  }

  private schedule(delay: number) {
    if (this.stop.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.running = this.sweep();
      void this.running;
    }, delay);
    this.timer.unref();
  }

  private async sweep() {
    let delay = 3600000;
    try {
      const result = await cleanupDocumentObjects(this.db, this.storage, 10, this.stop.signal);
      if (this.stop.signal.aborted) return;
      if (result.failed) {
        console.error('Document cleanup has pending retries; check storage connectivity and permissions.');
        delay = 300000;
      } else if (result.removed === 10) delay = 60000;
    } catch {
      if (!this.stop.signal.aborted) console.error('Document cleanup could not run; it will retry automatically.');
      delay = 300000;
    } finally { this.schedule(delay); }
  }

  async beforeApplicationShutdown() {
    this.stop.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
