/**
 * Сторона основного окна в разговоре с маленьким окном быстрого доступа.
 *
 * Слушает запросы, отвечает названиями и сам выполняет копирование - см.
 * `lib/quickBridge.ts`, там объяснено, почему секреты не пересекают границу
 * между окнами.
 *
 * Живёт в основном окне и только пока база открыта: без хранилища отвечать
 * нечем, а притворяться, что поиск ничего не нашёл, значило бы врать.
 */
import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { VaultStore } from "../lib/vaultStore";
import { copyWithAutoClear } from "../lib/clipboard";
import { parseOtpauth, totpCode } from "../lib/totp";
import { totpField, MAX_RESULTS } from "../screens/QuickAccess";
import {
  QUICK_EVENTS,
  COPY_LABELS,
  buildQuickRows,
  type QuickCopyPayload,
  type QuickQueryPayload,
} from "../lib/quickBridge";

export function useQuickWindowServer(store: VaultStore | null): void {
  useEffect(() => {
    if (!store) return;
    let alive = true;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const offQuery = await listen<QuickQueryPayload>(QUICK_EVENTS.query, (event) => {
        // Ограничение применяется ПОСЛЕ разложения на пары: у записи с двумя
        // почтами две строки, и обрезать записи до разложения значило бы
        // потерять половину пар при полном списке.
        const results = buildQuickRows(store.search(event.payload.query ?? "")).slice(0, MAX_RESULTS);
        void emit(QUICK_EVENTS.results, { results });
      });

      const offCopy = await listen<QuickCopyPayload>(QUICK_EVENTS.copy, (event) => {
        void (async () => {
          const { id, kind } = event.payload;
          const item = store.search("").find((i) => i.id === id);
          if (!item) {
            void emit(QUICK_EVENTS.copied, { label: null, error: "Запись не найдена" });
            return;
          }
          try {
            let value: string | null = null;
            if (kind === "password" || kind === "login") {
              // Поле называется явно: «первое подходящее» - это ровно та
              // ошибка, из-за которой в записи с двумя парами копировалась
              // всегда первая.
              value = item.fields.find((f) => f.name === event.payload.field)?.value ?? null;
            } else {
              const field = totpField(item);
              // Код считается здесь же: маленькое окно не должно получать
              // секрет двухфакторки, из которого коды можно делать вечно.
              value = field ? await totpCode(parseOtpauth(field.value), Date.now() / 1000) : null;
            }
            if (value === null) {
              void emit(QUICK_EVENTS.copied, { label: null, error: "Нечего копировать" });
              return;
            }
            await copyWithAutoClear(value);
            void emit(QUICK_EVENTS.copied, { label: COPY_LABELS[kind] });
          } catch (err) {
            console.error("useQuickWindowServer: не удалось скопировать значение", err);
            void emit(QUICK_EVENTS.copied, { label: null, error: "Не удалось скопировать" });
          }
        })();
      });

      if (!alive) {
        offQuery();
        offCopy();
        return;
      }
      unlisteners.push(offQuery, offCopy);
    })();

    return () => {
      alive = false;
      for (const off of unlisteners) off();
    };
  }, [store]);
}
