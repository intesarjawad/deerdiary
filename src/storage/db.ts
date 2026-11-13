import { type IDBPDatabase, openDB } from 'idb';
import type { CamtrapDraft } from '../core/camtrapMetadata';
import type {
  Location,
  PhotoDatabase,
  PipelineStorage,
  Session,
  StorageBatch,
  StoredResult,
} from './schema';

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

/** Persists photo batches atomically, retaining this tab's results when storage fills. */
export class PhotoStorage implements PipelineStorage {
  private readonly results = new Map<string, StoredResult>();
  private readonly sessions = new Map<string, Session>();
  private readonly corrections = new Map<string, string>();
  private location: Location | undefined;
  memoryOnly = false;

  private constructor(private readonly database: IDBPDatabase<PhotoDatabase> | undefined) {
    this.memoryOnly = !database;
  }

  static async open(): Promise<PhotoStorage> {
    try {
      const database = await openDB<PhotoDatabase>('deerdiary', 1, {
        upgrade(db) {
          db.createObjectStore('files', { keyPath: 'key' });
          db.createObjectStore('results', { keyPath: 'key' });
          db.createObjectStore('corrections');
          db.createObjectStore('sessions', { keyPath: 'id' });
          db.createObjectStore('settings');
        },
        blocking() {
          database.close();
        },
      });
      return new PhotoStorage(database);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      return new PhotoStorage(undefined);
    }
  }

  async loadResults(keys: readonly string[]): Promise<StoredResult[]> {
    const database = this.database;
    const tx = database?.transaction('results');
    const [results] = await Promise.all([
      Promise.all(keys.map(async (key) => this.results.get(key) ?? (await tx?.store.get(key)))),
      tx?.done,
    ]);
    for (const result of results) if (result) this.results.set(result.key, result);
    return structuredClone(results.filter((result) => result !== undefined));
  }

  private async persist(write: (database: IDBPDatabase<PhotoDatabase>) => Promise<void>) {
    if (!this.database || this.memoryOnly) return;
    try {
      await write(this.database);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      this.memoryOnly = true;
    }
  }

  async saveBatch(batch: StorageBatch): Promise<void> {
    const previous =
      this.sessions.get(batch.session.id) ??
      (await this.database?.get('sessions', batch.session.id));
    const session = {
      ...batch.session,
      ...(previous?.camtrap ? { camtrap: previous.camtrap } : {}),
    };
    await this.persist(async (db) => {
      const tx = db.transaction(['files', 'results', 'sessions'], 'readwrite');
      await Promise.all([
        ...batch.files.map((file) => tx.objectStore('files').put(file)),
        ...batch.results.map((result) => tx.objectStore('results').put(result)),
        tx.objectStore('sessions').put(session),
        tx.done,
      ]);
    });
    for (const result of batch.results) this.results.set(result.key, structuredClone(result));
    this.sessions.set(session.id, structuredClone(session));
  }

  /** Saves incomplete export fields with the diary so reopening it restores the user's draft. */
  async saveCamtrapDraft(id: string, draft: CamtrapDraft): Promise<void> {
    const session = this.sessions.get(id) ?? (await this.database?.get('sessions', id));
    if (session === undefined)
      throw new Error('Open a saved session before saving export details.');
    const updated = structuredClone({ ...session, camtrap: draft });
    this.sessions.set(id, updated);
    await this.persist(async (db) => {
      const tx = db.transaction('sessions', 'readwrite');
      await Promise.all([tx.store.put(updated), tx.done]);
    });
  }

  async listSessions(): Promise<Session[]> {
    for (const session of (await this.database?.getAll('sessions')) ?? []) {
      if (!this.sessions.has(session.id)) this.sessions.set(session.id, session);
    }
    return structuredClone(Array.from(this.sessions.values()));
  }

  /**
   * Removes one diary in a single transaction. A result another diary also lists stays, because
   * dropping the same photos again reuses it; the caller names the corrections that are only this
   * diary's. Thumbnails live inside their result rows.
   */
  async deleteSession(id: string, correctionKeys: readonly string[]): Promise<void> {
    const sessions = await this.listSessions();
    const target = sessions.find((session) => session.id === id);
    if (!target) return;
    const shared = new Set(
      sessions.filter((session) => session.id !== id).flatMap((session) => session.fileKeys),
    );
    const resultKeys = target.fileKeys.filter((key) => !shared.has(key));
    await this.persist(async (db) => {
      const tx = db.transaction(['files', 'results', 'corrections', 'sessions'], 'readwrite');
      await Promise.all([
        ...resultKeys.flatMap((key) => [
          tx.objectStore('files').delete(key),
          tx.objectStore('results').delete(key),
        ]),
        ...correctionKeys.map((key) => tx.objectStore('corrections').delete(key)),
        tx.objectStore('sessions').delete(id),
        tx.done,
      ]);
    });
    for (const key of resultKeys) this.results.delete(key);
    for (const key of correctionKeys) this.corrections.delete(key);
    this.sessions.delete(id);
  }

  /** Writes an imported diary and its corrections together, replacing a diary with the same id. */
  async restoreSession(
    session: Session,
    results: readonly StoredResult[],
    corrections: Readonly<Record<string, string>>,
  ): Promise<void> {
    const entries = Object.entries(corrections);
    await this.persist(async (db) => {
      const tx = db.transaction(['results', 'corrections', 'sessions'], 'readwrite');
      await Promise.all([
        ...results.map((result) => tx.objectStore('results').put(result)),
        ...entries.map(([key, value]) => tx.objectStore('corrections').put(value, key)),
        tx.objectStore('sessions').put(session),
        tx.done,
      ]);
    });
    for (const result of results) this.results.set(result.key, structuredClone(result));
    for (const [key, value] of entries) this.corrections.set(key, value);
    this.sessions.set(session.id, structuredClone(session));
  }

  async loadLocation(): Promise<Location | undefined> {
    this.location ??= await this.database?.get('settings', 'location');
    return structuredClone(this.location);
  }

  async saveLocation(location: Location): Promise<void> {
    await this.persist(async (db) => {
      await db.put('settings', location, 'location');
    });
    this.location = structuredClone(location);
  }

  /** Corrections survive reloads but stay separate from the photo results they annotate. */
  async loadCorrections(): Promise<Record<string, string>> {
    const database = this.database;
    if (!database) return Object.fromEntries(this.corrections);
    const tx = database.transaction('corrections');
    const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll(), tx.done]);
    keys.forEach((key, index) => {
      const value = values[index];
      if (typeof value === 'string') this.corrections.set(key, value);
    });
    return Object.fromEntries(this.corrections);
  }

  async saveCorrection(key: string, value: string): Promise<void> {
    await this.persist(async (db) => {
      await db.put('corrections', value, key);
    });
    this.corrections.set(key, value);
  }

  /** Replaces the stored map, which is how a caller writes a correction and resets another. */
  async saveCorrections(corrections: Readonly<Record<string, string>>): Promise<void> {
    const entries = Object.entries(corrections);
    await this.persist(async (db) => {
      const tx = db.transaction('corrections', 'readwrite');
      const keys = await tx.store.getAllKeys();
      await Promise.all([
        ...keys.map((key) => tx.store.delete(key)),
        ...entries.map(([key, value]) => tx.store.put(value, key)),
        tx.done,
      ]);
    });
    this.corrections.clear();
    for (const [key, value] of entries) this.corrections.set(key, value);
  }

  async deleteCorrection(key: string): Promise<void> {
    await this.persist(async (db) => {
      await db.delete('corrections', key);
    });
    this.corrections.delete(key);
  }

  close(): void {
    this.database?.close();
  }
}
