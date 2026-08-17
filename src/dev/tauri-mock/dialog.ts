/**
 * Подмена `@tauri-apps/plugin-dialog` для режима `--mode mock` (см. `fs.ts`).
 *
 * Боевой код импортирует только `open` и `save` (`App.tsx`, `Editor.tsx`,
 * `RecordCard.tsx`, `ImportExportPanel.tsx`).
 *
 * Нативного диалога в браузере нет, поэтому обе функции сразу возвращают путь
 * внутри файловой системы в памяти. Отмену выбора файла (возврат `null`) можно
 * получить, зажав Shift в момент вызова - иначе ветку «пользователь передумал»
 * невозможно ни увидеть, ни нарисовать.
 */
import { mockDialogPath } from "./fs";

type DialogOptions = {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
  multiple?: boolean;
};

/** Нажат ли Shift прямо сейчас - способ вручную попасть в ветку отмены. */
let shiftHeld = false;
window.addEventListener("keydown", (e) => {
  if (e.key === "Shift") shiftHeld = true;
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Shift") shiftHeld = false;
});

function extensionFrom(options?: DialogOptions): string {
  return options?.filters?.[0]?.extensions?.[0] ?? "dat";
}

export async function open(options?: DialogOptions): Promise<string | null> {
  if (shiftHeld) {
    console.info("mock: dialog.open() отменён (зажат Shift)");
    return null;
  }
  return options?.defaultPath ?? mockDialogPath(extensionFrom(options));
}

export async function save(options?: DialogOptions): Promise<string | null> {
  if (shiftHeld) {
    console.info("mock: dialog.save() отменён (зажат Shift)");
    return null;
  }
  return options?.defaultPath ?? mockDialogPath(extensionFrom(options));
}
