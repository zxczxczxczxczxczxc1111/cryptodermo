/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Версия приложения для показа в настройках.
 *
 * Берётся из package.json на этапе сборки, а не через `getVersion()` из
 * `@tauri-apps/api/app`: тот добавил бы ещё один IPC-вызов, который вне Tauri
 * падает и сделал бы экран настроек асинхронным ради одной строки.
 */
// @ts-expect-error process is a nodejs global
const appVersion = process.env.npm_package_version ?? "0.0.0";

/**
 * Абсолютный путь к файлу заглушки Tauri. Считается из `import.meta.url`, а не
 * через `path`/`fileURLToPath`, потому что в проекте нет `@types/node` и
 * добавлять его ради одной строчки конфига незачем (R31). На Windows
 * `pathname` даёт `/D:/...` - ведущий слэш перед буквой диска убирается, иначе
 * Vite не найдёт файл.
 */
function mockModulePath(name: string): string {
  return new URL(`./src/dev/tauri-mock/${name}.ts`, import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react()],

  /**
   * Режим `mock` (скрипт `npm run dev:mock`) подменяет три модуля Tauri
   * заглушками из `src/dev/tauri-mock/`, чтобы интерфейс можно было открыть в
   * обычном браузере. Без этого приложение не рендерится дальше заставки:
   * `App.tsx` при монтировании зовёт `invoke("exe_dir")`, а вне Tauri
   * `window.__TAURI_INTERNALS__` не существует.
   *
   * Подменяются именно три модуля, а не один `tauriApi.ts`: официальные
   * плагины импортируются боевым кодом напрямую, мимо него (это разрешено
   * архитектурой проекта, см. CLAUDE.md) - `@tauri-apps/api/window` в
   * `App.tsx`, `LockScreen.tsx`, `useAutoLock.ts`, `@tauri-apps/plugin-dialog`
   * в четырёх файлах.
   *
   * В `npm run dev`, `npm run tauri dev` и в собранном бандле подмена не
   * применяется: условие ложно, и на файлы заглушки нет ни одного импорта из
   * боевого кода.
   */
  resolve:
    mode === "mock"
      ? {
          alias: [
            { find: /^@tauri-apps\/api\/core$/, replacement: mockModulePath("core") },
            { find: /^@tauri-apps\/api\/window$/, replacement: mockModulePath("window") },
            { find: /^@tauri-apps\/plugin-dialog$/, replacement: mockModulePath("dialog") },
            { find: /^@tauri-apps\/plugin-opener$/, replacement: mockModulePath("opener") },
            {
              find: /^@tauri-apps\/plugin-global-shortcut$/,
              replacement: mockModulePath("global-shortcut"),
            },
            { find: /^@tauri-apps\/plugin-autostart$/, replacement: mockModulePath("autostart") },
            {
              find: /^@tauri-apps\/plugin-clipboard-manager$/,
              replacement: mockModulePath("clipboard-manager"),
            },
          ],
        }
      : undefined,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    // В режиме `mock` порт другой, чтобы заглушку можно было держать открытой
    // одновременно с настоящим `tauri dev` и сравнивать их бок о бок.
    // `strictPort` ниже иначе уронил бы вторую из двух команд.
    port: mode === "mock" ? 1430 : 1420,
    strictPort: true,
    // На части машин (в т.ч. на этой) "localhost" резолвится в IPv6 (::1)
    // раньше IPv4, и Vite слушает только IPv6-адрес. Проверка готовности
    // dev-сервера в `tauri dev` стучится по IPv4 (127.0.0.1) и никогда не
    // получает ответ - окно не открывается, `tauri dev` зависает на
    // "Waiting for your frontend dev server to start". Явный IPv4-хост
    // убирает эту гонку резолвинга.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Раннер тестов фронта - Vitest (стандартный выбор для проектов на Vite,
  // переиспользует этот же конфиг и не требует отдельного сборщика).
  // `passWithNoTests` нужен именно сейчас: в этом тикете у фронта ещё нет
  // ни одного шва, который требует автотеста (см. interfaces.md), поэтому
  // тестовых файлов пока нет - и `vitest run` не должен считать это ошибкой.
  // Когда появятся первые тесты (модуль `crypto` и т.д.), эта настройка
  // перестанет на что-либо влиять.
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },

  test: {
    passWithNoTests: true,
  },
}));
