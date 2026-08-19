/**
 * Подмена `@tauri-apps/api/core` для режима `--mode mock` (см. `fs.ts`).
 *
 * Покрывает ровно те пять команд, которые объявлены в `src/lib/tauriApi.ts` -
 * если там появится шестая, здесь честно упадёт с понятной ошибкой, а не
 * молча вернёт `undefined`.
 *
 * `write_vault_atomic` получает `bytes` base64-строкой, а не `number[]`
 * (19.08.2026, см. комментарий у `writeVaultAtomic` в `tauriApi.ts`) - здесь
 * декодируется через нативный `atob` (доступен только в браузере, но этот
 * файл и так подключается лишь в режиме `--mode mock`, где браузер и есть
 * среда исполнения). `read_vault` менять не пришлось: `mockReadFile` уже
 * отдаёт обычный массив чисел, а `new Uint8Array(numberArray)` строит из
 * него правильные байты тем же путём, что и из настоящего `ArrayBuffer`.
 */
import {
  mockReadFile,
  mockWriteFile,
  mockListBackups,
  mockRotateBackups,
  mockExeDir,
} from "./fs";
// Общий модуль (`src/lib/base64.ts`) - чистый leaf без Tauri-зависимостей,
// подмена `@tauri-apps/api/core` этим файлом цикла не создаёт.
import { base64ToBytes } from "../../lib/base64";

/** Задержка, имитирующая настоящий IPC. Без неё интерфейс в браузере ведёт
 * себя заметно бодрее, чем в живом окне, и состояния загрузки невозможно ни
 * увидеть, ни нарисовать. */
const IPC_DELAY_MS = 25;

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, IPC_DELAY_MS));
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await delay();
  switch (cmd) {
    case "read_vault":
      return (await mockReadFile(args?.path as string)) as T;
    case "write_vault_atomic":
      return (await mockWriteFile(args?.path as string, Array.from(base64ToBytes(args?.bytes as string)))) as T;
    case "list_backups":
      return (await mockListBackups(args?.dir as string)) as T;
    case "rotate_backups":
      return (await mockRotateBackups()) as T;
    case "exe_dir":
      return mockExeDir() as T;
    // Режим быстрого доступа в браузере включается адресом `?quick`: аргументов
    // командной строки у вкладки нет, а посмотреть на окошко глазами надо.
    case "quick_mode":
      return (new URLSearchParams(window.location.search).has("quick")) as T;
    default:
      throw new Error(
        `mock: команда "${cmd}" не реализована в заглушке. Добавь её в src/dev/tauri-mock/core.ts`,
      );
  }
}
