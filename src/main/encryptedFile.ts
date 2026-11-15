// A JSON file encrypted with the OS key store via safeStorage (DPAPI on Windows,
// Keychain on macOS). Writes are atomic (temp file + rename) and serialized.
//
// Two different failures are kept apart on purpose:
//  - the key store refuses (macOS asks for Keychain access after an update of an app
//    that has no Developer ID signature, and the user may press "Deny"): the file is
//    left untouched and writes are blocked, so nothing overwrites data we could not read;
//  - the file itself is damaged: it is moved aside for recovery and we start empty.

import { safeStorage } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const MAGIC_ENC = 'TBENC1\n';
const MAGIC_PLAIN = 'TBRAW1\n';

export class EncryptedJsonFile<T extends object> {
  private writing: Promise<void> = Promise.resolve();
  /** false only on systems without a key store (some Linux setups) */
  encrypted = true;
  /** true when stored data could not be decrypted: writes are refused until restart */
  locked = false;

  constructor(
    private readonly file: string,
    private readonly label: string,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /** Returns the stored object, or null if there is none or it could not be read. */
  async read(): Promise<{ data: T; reEncrypt: boolean } | null> {
    if (!existsSync(this.file)) return null;
    const raw = readFileSync(this.file);
    const head = raw.subarray(0, MAGIC_ENC.length).toString('utf8');
    let json: string;
    let reEncrypt = false;
    if (head === MAGIC_ENC) {
      try {
        const r = await safeStorage.decryptStringAsync(raw.subarray(MAGIC_ENC.length));
        json = r.result;
        reEncrypt = r.shouldReEncrypt;
      } catch (e) {
        this.locked = true;
        console.error(`Нет доступа к ключу шифрования (${this.label})`, e);
        this.onError(
          `Нет доступа к ключу шифрования, ${this.label} не загружены. ` +
            (process.platform === 'darwin'
              ? 'Перезапустите приложение и в запросе связки ключей нажмите «Разрешить всегда».'
              : 'Перезапустите приложение.') +
            ' Данные не удалены.',
        );
        return null;
      }
    } else if (head === MAGIC_PLAIN) {
      json = raw.subarray(MAGIC_PLAIN.length).toString('utf8');
      reEncrypt = true; // encrypt it as soon as the key store is available
    } else {
      this.moveAside(new Error('unknown format'));
      return null;
    }
    try {
      return { data: JSON.parse(json) as T, reEncrypt };
    } catch (e) {
      this.moveAside(e);
      return null;
    }
  }

  private moveAside(e: unknown) {
    const backup = `${this.file}.broken-${Date.now()}`;
    try {
      renameSync(this.file, backup);
    } catch {
      /* ignore */
    }
    console.error(`Файл повреждён (${this.label}), сохранён как`, backup, e);
    this.onError(`Файл (${this.label}) был повреждён и сохранён отдельно: ${backup}`);
  }

  /** Snapshots the data now; the write happens in order after earlier writes. */
  write(data: T): void {
    if (this.locked) return;
    const json = JSON.stringify(data);
    this.writing = this.writing.then(async () => {
      try {
        this.encrypted = await safeStorage.isAsyncEncryptionAvailable();
        const payload = this.encrypted
          ? Buffer.concat([Buffer.from(MAGIC_ENC), await safeStorage.encryptStringAsync(json)])
          : Buffer.from(MAGIC_PLAIN + json);
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, payload, { mode: 0o600 });
        renameSync(tmp, this.file);
      } catch (e) {
        console.error(`Не удалось сохранить ${this.label}`, e);
        this.onError(`Не удалось сохранить ${this.label}: нет доступа к ключу шифрования.`);
      }
    });
  }

  flush(): Promise<void> {
    return this.writing;
  }
}
