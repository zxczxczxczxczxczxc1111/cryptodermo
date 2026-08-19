/**
 * Сторона основного окна в разговоре о СОСТОЯНИИ БЛОКИРОВКИ с маленьким окном
 * быстрого доступа (19.08.2026).
 *
 * Отдельно от `useQuickWindowServer.ts`: тот отвечает только пока база уже
 * открыта, а этот хук - ровно наоборот, работает именно тогда, когда её нет.
 * Раньше при заблокированной базе хоткей поднимал ВСЁ основное окно с вводом
 * PIN, потому что маленькому окну спрашивать PIN было нечем и не у кого -
 * найдено и разобрано пользователем 19.08.2026 (долгое ожидание в трее почти
 * всегда означает, что успела сработать автоблокировка).
 *
 * Данные по-прежнему не пересекают границу между окнами ни разу: маленькое
 * окно присылает только цифры PIN, основное сообщает только успех/неудачу и
 * текст для человека - тот же принцип, что и у остального `quickBridge.ts`.
 */
import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { VaultStore } from "../lib/vaultStore";
import { readSettings, updateSettings } from "../lib/settingsConfig";
import {
  checkExistingVault,
  submitPinUnlock,
  pinLockoutRemainingMs,
} from "../screens/LockScreen";
import { isPinLockedOut, recordFailedPinAttempt, resetPinLockout } from "../lib/pinLock";
import { NO_PIN_MESSAGE } from "../lib/quickSearch";
import {
  QUICK_EVENTS,
  type QuickStateResultPayload,
  type QuickUnlockPayload,
  type QuickUnlockedPayload,
} from "../lib/quickBridge";

/** Ссылка, всегда указывающая на последнее значение - тот же приём, что в
 * `useGlobalHotkey.ts`: `store`/`vaultPath`/`onUnlock` меняются на каждый
 * рендер `App.tsx`, а пересоздавать подписку на каждый из них незачем. */
function useLatest<T>(value: T): { current: T } {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}

export function useQuickWindowUnlockGate(
  vaultPath: string | null,
  store: VaultStore | null,
  onUnlock: (store: VaultStore, vaultPath: string) => void,
): void {
  const stateRef = useLatest({ vaultPath, store, onUnlock });

  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const offState = await listen(QUICK_EVENTS.state, () => {
        void (async () => {
          const { vaultPath, store } = stateRef.current;
          if (store) {
            const payload: QuickStateResultPayload = { locked: false, hasPin: true };
            void emit(QUICK_EVENTS.stateResult, payload);
            return;
          }
          if (!vaultPath) {
            // Путь ещё не определён - доля секунды на самом старте
            // приложения (D03 в App.tsx). Отвечать "разблокировано" нечем и
            // некорректно; ближайший честный ответ - "PIN не настроен",
            // маленькое окно покажет сообщение вместо зависания.
            const payload: QuickStateResultPayload = { locked: true, hasPin: false };
            void emit(QUICK_EVENTS.stateResult, payload);
            return;
          }
          const settings = await readSettings(vaultPath);
          const now = new Date();
          const payload: QuickStateResultPayload = {
            locked: true,
            hasPin: Boolean(settings.pin),
            lockedOutRemainingMs: isPinLockedOut(settings.pinLockout, now)
              ? pinLockoutRemainingMs(settings.pinLockout, now)
              : undefined,
          };
          void emit(QUICK_EVENTS.stateResult, payload);
        })();
      });

      const offUnlock = await listen<QuickUnlockPayload>(QUICK_EVENTS.unlock, (event) => {
        void (async () => {
          // seq эхом уходит в каждый ответ - маленькое окно отбрасывает
          // устаревшие по нему, см. комментарий у QuickUnlockPayload.
          const respond = (payload: Omit<QuickUnlockedPayload, "seq">) => {
            void emit(QUICK_EVENTS.unlocked, { ...payload, seq: event.payload.seq });
          };

          const { vaultPath, store, onUnlock } = stateRef.current;
          if (store) {
            // Успели разблокировать не через маленькое окно, пока оно ждало
            // ввод (например, руками в основном окне) - подменять живой стор
            // с возможными несохранёнными правками чужой копией опасно,
            // просто подтверждаем то, что уже случилось.
            respond({ ok: true });
            return;
          }
          if (!vaultPath) {
            respond({ ok: false, message: "База ещё не определена" });
            return;
          }
          try {
            const settings = await readSettings(vaultPath);
            if (!settings.pin) {
              respond({ ok: false, message: NO_PIN_MESSAGE });
              return;
            }
            const now = new Date();
            if (isPinLockedOut(settings.pinLockout, now)) {
              respond({ ok: false, lockedOutRemainingMs: pinLockoutRemainingMs(settings.pinLockout, now) });
              return;
            }
            const bytes = await checkExistingVault(vaultPath);
            if (bytes === null) {
              respond({ ok: false, message: "База не найдена" });
              return;
            }
            const result = await submitPinUnlock({
              existingBytes: bytes,
              pinWrap: settings.pin,
              pin: event.payload.pin,
              vaultPath,
              onUnlock,
            });
            if (result.ok) {
              if (settings.pinLockout?.failedAttempts || settings.pinLockout?.lockedUntil) {
                await updateSettings(vaultPath, { pinLockout: resetPinLockout() });
              }
              respond({ ok: true });
              return;
            }
            if (!event.payload.counted) {
              // Тихая попытка - неудача не считается, счётчик не трогаем.
              respond({ ok: false, message: result.message });
              return;
            }
            const nextLockout = recordFailedPinAttempt(settings.pinLockout, now);
            await updateSettings(vaultPath, { pinLockout: nextLockout });
            const remaining = pinLockoutRemainingMs(nextLockout, now);
            respond({
              ok: false,
              message: result.message,
              lockedOutRemainingMs: remaining > 0 ? remaining : undefined,
            });
          } catch (err) {
            console.error("useQuickWindowUnlockGate: не удалось разблокировать по PIN", err);
            respond({ ok: false, message: "Не удалось разблокировать" });
          }
        })();
      });

      if (!alive) {
        offState();
        offUnlock();
        return;
      }
      unlisteners.push(offState, offUnlock);
    })();

    return () => {
      alive = false;
      for (const off of unlisteners) off();
    };
    // stateRef держит свежие store/vaultPath/onUnlock без пересоздания
    // подписки - см. комментарий у useLatest выше.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
