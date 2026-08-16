/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
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
  test: {
    passWithNoTests: true,
  },
}));
