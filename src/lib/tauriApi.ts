/**
 * Единственная точка вызова Rust-команд файлового слоя (`vault_fs`) из UI.
 *
 * Модуль `tauri-bridge` из interfaces.md: остальной код приложения не должен
 * ни разу вызывать `invoke()` напрямую и не должен знать имена команд как
 * строки - только через типизированные функции этого файла. Это даёт две
 * вещи: опечатка в имени команды становится ошибкой TypeScript, а не
 * ошибкой в рантайме, и когда сигнатура Rust-команды меняется, менять нужно
 * только один файл.
 */
import { invoke } from "@tauri-apps/api/core";

/** Один файл резервной копии - зеркало `BackupInfo` из `src-tauri/src/vault_fs.rs`. */
export type BackupInfo = {
  /** Полный путь к файлу бэкапа. */
  path: string;
  /** Имя файла без каталога. */
  filename: string;
  /** Размер файла в байтах. */
  size: number;
  /** Время последнего изменения, миллисекунды от Unix-эпохи (UTC). */
  modifiedAtMs: number;
};

/**
 * Прочитать файл базы (или любой другой файл, например `vault.settings.json`)
 * целиком как сырые байты. Расшифровка и разбор JSON - не забота этой
 * функции и не забота Rust-команды за ней, этим занимается `vault-format` и
 * `crypto` уровнем выше.
 */
export async function readVault(path: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("read_vault", { path });
  return new Uint8Array(bytes);
}

/**
 * Атомарно записать байты в файл: временный файл + fsync + переименование
 * поверх боевого. Прямой записи в `path` не существует ни на одном шаге -
 * см. комментарии в `write_vault_atomic` в Rust-коде.
 */
export async function writeVaultAtomic(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await invoke<void>("write_vault_atomic", {
    path,
    bytes: Array.from(bytes),
  });
}

/**
 * Список файлов в каталоге бэкапов с размером и датой изменения. Пустой
 * массив, если каталога ещё нет (например, самый первый запуск).
 */
export async function listBackups(dir: string): Promise<BackupInfo[]> {
  return invoke<BackupInfo[]>("list_backups", { dir });
}

/**
 * Оставить в каталоге только `keepN` самых свежих файлов, остальные удалить.
 * Неудачное удаление отдельного старого файла не считается ошибкой всей
 * операции (см. комментарии в Rust-коде) - эта функция может завершиться
 * успешно, даже если на диске временно остался лишний старый файл.
 */
export async function rotateBackups(dir: string, keepN: number): Promise<void> {
  await invoke<void>("rotate_backups", { dir, keepN });
}

/**
 * Каталог, в котором лежит исполняемый файл приложения. Нужен как путь по
 * умолчанию к `vault.dat` при самом первом запуске, когда
 * `vault.settings.json` ещё не существует и `lastVaultPath` неизвестен - см.
 * комментарии в `exe_dir` в Rust-коде про то, почему это не
 * `executableDir()` из `@tauri-apps/api/path` (на Windows не поддерживается).
 */
export async function exeDir(): Promise<string> {
  return invoke<string>("exe_dir");
}
