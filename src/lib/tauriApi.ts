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
// Нужна здесь, чтобы `writeVaultAtomic` передавала байты базы одной
// компактной строкой, а не массивом из миллионов отдельных JSON-чисел
// (см. комментарий у самой функции).
import { bytesToBase64 } from "./base64";

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
 *
 * Rust-команда отдаёт байты через `tauri::ipc::Response` - настоящий
 * бинарный ответ IPC, а не JSON-массив чисел (19.08.2026, найдено внешним
 * ревью: старый путь через обычный `Vec<u8>` сериализовался в JSON-массив,
 * на большой базе с вложениями это миллионы отдельных чисел в тексте).
 * `invoke()` в этом случае резолвится настоящим `ArrayBuffer` - это
 * поведение самого Tauri v2 (content-type ответа не `application/json`,
 * фронтовый рантайм Tauri берёт `response.arrayBuffer()`), а не что-то,
 * что реализует этот модуль.
 */
export async function readVault(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_vault", { path });
  return new Uint8Array(buffer);
}

/**
 * Атомарно записать байты в файл: временный файл + fsync + переименование
 * поверх боевого. Прямой записи в `path` не существует ни на одном шаге -
 * см. комментарии в `write_vault_atomic` в Rust-коде.
 *
 * Байты уходят как base64-строка, а не JSON-массив чисел (19.08.2026, тот же
 * повод, что у `readVault` выше). Настоящий "сырой" путь IPC Tauri (payload
 * ArrayBuffer/Uint8Array целиком, без обёртки `{path, bytes}`) потребовал бы
 * передавать `path` отдельно через HTTP-заголовок запроса, а значения
 * заголовков ограничены ASCII - путь к базе с кириллицей в имени пользователя
 * (обычное дело на этой машине) такой заголовок бы сломал. Base64-строка
 * этого ограничения не имеет и всё равно вчетверо компактнее текущего
 * `Array.from(bytes)` (~×1.33 от размера байт вместо ~×4 у JSON-массива
 * чисел с запятыми). Rust-сторона декодирует её вручную (`base64_decode` в
 * `vault_fs.rs`) - без новой Cargo-зависимости, тот же принцип, что у
 * hand-rolled `aes_gcm.py`.
 */
export async function writeVaultAtomic(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await invoke<void>("write_vault_atomic", {
    path,
    bytes: bytesToBase64(bytes),
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

/**
 * Запущено ли приложение в режиме быстрого доступа (ярлык с `--quick`).
 *
 * Аргументы командной строки в webview не попадают, поэтому их читает
 * Rust-команда. Ошибку не пробрасываем наверх: неизвестный режим должен
 * означать обычный запуск, а не белый экран.
 */
export async function quickMode(): Promise<boolean> {
  try {
    return await invoke<boolean>("quick_mode");
  } catch (err) {
    console.error("tauriApi: не удалось определить режим запуска", err);
    return false;
  }
}
