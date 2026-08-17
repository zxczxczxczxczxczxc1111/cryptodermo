/**
 * Подмена `@tauri-apps/api/core` для режима `--mode mock` (см. `fs.ts`).
 *
 * Покрывает ровно те пять команд, которые объявлены в `src/lib/tauriApi.ts` -
 * если там появится шестая, здесь честно упадёт с понятной ошибкой, а не
 * молча вернёт `undefined`.
 */
import {
  mockReadFile,
  mockWriteFile,
  mockListBackups,
  mockRotateBackups,
  mockExeDir,
} from "./fs";

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
      return (await mockWriteFile(args?.path as string, args?.bytes as number[])) as T;
    case "list_backups":
      return (await mockListBackups(args?.dir as string)) as T;
    case "rotate_backups":
      return (await mockRotateBackups()) as T;
    case "exe_dir":
      return mockExeDir() as T;
    default:
      throw new Error(
        `mock: команда "${cmd}" не реализована в заглушке. Добавь её в src/dev/tauri-mock/core.ts`,
      );
  }
}
