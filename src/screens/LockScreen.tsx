/**
 * Экран блокировки/создания базы (тикет 06, R47/R74/R75/R94.1/R95/R95.1).
 *
 * Один экран для обоих случаев - различаются наличием `vault.dat` по текущему
 * пути (`checkExistingVault` ниже). Компонент сам по себе - тонкая обвязка
 * состояния формы вокруг трёх экспортированных async-функций
 * (`submitUnlock`/`submitCreate`/`submitRecovery`), в которых сосредоточена
 * вся значимая логика. Разделение сделано намеренно: в проекте нет
 * DOM-окружения для тестов (jsdom/happy-dom не установлены, устанавливать
 * новую зависимость без отдельного вопроса пользователю нельзя - R31), а
 * значит компонент нельзя отрендерить в автотесте. Три функции ниже -
 * обычный async-код без JSX/хуков, их можно и нужно проверить unit-тестами
 * напрямую (см. `LockScreen.test.ts`) - это и есть "шов", о котором просит
 * тикет: "проверяй через факт вызова onUnlock с корректным VaultStore".
 * Сам JSX-компонент (вёрстка, состояние формы) проверен глазами и сборкой
 * (`tsc`/`vite build`), не автотестом - см. отчёт по тикету.
 *
 * Тикет 13 (R54/R73/R76/R77/R78/R79/R80/R81/R107, спецификация §16)
 * добавляет фоновый canvas - медленно дрейфующую сеть узлов и линий. Тот же
 * принцип разделения: вся математика (позиции узлов, easing 400ms-разлёта,
 * сглаживание скорости при busy, прогресс "потери связей" на ошибке,
 * проверка prefers-reduced-motion) - чистые экспортированные функции ниже,
 * протестированные напрямую в LockScreen.test.ts; сама отрисовка на canvas
 * и подписки (resize/onResized/matchMedia) - императивный код внутри
 * компонента, проверен чтением и сборкой, тем же способом, что и раньше.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { VaultStore } from "../lib/vaultStore";
import { DecryptError } from "../lib/crypto";
import { FormatError } from "../lib/vaultFormat";
import { readVault, type BackupInfo } from "../lib/tauriApi";
import "../tokens.css";
import "./LockScreen.css";

/** Единый текст ошибки на неверный пароль/битый файл - AES-GCM не различает
 * эти два случая криптографически (R94.1), дословно из брифа/ticket. */
export const UNLOCK_ERROR_MESSAGE = "Не удалось открыть базу: неверный пароль или файл повреждён";

/** Текст на неожиданный сбой записи при создании новой базы - не сама
 * DecryptError/FormatError (эти два кейса относятся только к открытию
 * существующей базы), а ошибка файлового слоя (диск занят, нет прав и т.п.). */
export const CREATE_SAVE_ERROR_MESSAGE =
  "Не удалось сохранить базу по этому пути. Проверьте, что каталог доступен для записи, и попробуйте снова";

/** Текстовый индикатор процесса деривации ключа (R75) - идёт РЯДОМ с
 * фоновой canvas-анимацией сети (тикет 13, спецификация §16, см. ниже), не
 * вместо неё: сеть уплотняется и ускоряется, но без текста не всегда
 * понятно, что именно происходит - без спиннера и прогресс-бара, дословно
 * из брифа. */
export const DERIVING_LABEL = "Проверяю...";

/** Текст на неожиданную ошибку (не DecryptError/FormatError и не сбой
 * записи при создании - у обоих есть свой текст выше), которую компонент не
 * пытается интерпретировать - см. правило "не изобретай поведение для
 * неизвестного сбоя" (CLAUDE.md §1). R85 - без "Произошла ошибка". */
export const UNEXPECTED_ERROR_MESSAGE =
  "Не удалось выполнить операцию. Попробуйте ещё раз";

/**
 * Опечатка в новом мастер-пароле при СОЗДАНИИ базы не видна сразу (в отличие
 * от разблокировки, где неверный пароль тут же выдаёт себя отказом
 * расшифровки) - для офлайн-хранилища с приоритетом "данные не теряются"
 * это риск необратимой блокировки. Решение оркестратора (2026-08-16): поле
 * повтора пароля только в ветке создания, тот же текст и в подсказке под
 * полем, и в возвращаемой ошибке `submitCreate` (защита на обоих уровнях -
 * кнопка неактивна, пока поля не совпадают, но и сама функция проверяет это
 * заново, а не полагается только на UI). */
export const PASSWORD_MISMATCH_MESSAGE = "Пароли не совпадают";

/**
 * Есть ли уже файл базы по данному пути - определяет режим экрана
 * (разблокировка/создание, R95). Любая ошибка чтения (файла нет, нет прав и
 * т.п.) трактуется как "файла ещё нет" - тот же принцип, что и в
 * `VaultStore.save()` (см. комментарий там же): различать конкретную причину
 * не задача этого экрана, а Rust-команда не даёт для этого структурированной
 * информации.
 */
export async function checkExistingVault(vaultPath: string): Promise<Uint8Array | null> {
  try {
    return await readVault(vaultPath);
  } catch {
    return null;
  }
}

export type SubmitResult = { ok: true } | { ok: false; message: string };

/**
 * Попытка разблокировать существующую базу. Единственная точка, где вызывается
 * `onUnlock` в сценарии "верный пароль на существующей базе" - критерий
 * приёмки проверяется тестом именно на этом вызове (`LockScreen.test.ts`).
 *
 * `DecryptError`/`FormatError` от `VaultStore.loadFromBytes` превращаются в
 * единый текст (R94.1); любая другая ошибка не подменяется и уходит наверх -
 * выдумывать для неё текст не задача этой функции (см. правило "не
 * изобретай поведение").
 */
export async function submitUnlock(params: {
  existingBytes: Uint8Array;
  password: string;
  vaultPath: string;
  onUnlock: (store: VaultStore, vaultPath: string) => void;
}): Promise<SubmitResult> {
  const store = new VaultStore();
  try {
    await store.loadFromBytes(params.existingBytes, params.password);
  } catch (err) {
    if (err instanceof DecryptError || err instanceof FormatError) {
      return { ok: false, message: UNLOCK_ERROR_MESSAGE };
    }
    throw err;
  }
  params.onUnlock(store, params.vaultPath);
  return { ok: true };
}

/**
 * Создать новую базу и сразу сохранить её на диск (иначе после создания без
 * единой правки `vault.dat` физически не появится, и при следующем запуске
 * экран снова показал бы режим создания вместо разблокировки). Вызывающий
 * код (компонент) обязан заранее убедиться через свежий
 * `checkExistingVault`, что по этому пути ещё ничего нет - здесь этой
 * проверки нет намеренно: "определить" и "сделать" - разные ответственности,
 * компонент делает выбор (создавать или показать диалог конфликта, R95.1) до
 * вызова этой функции. Эта перепроверка закрывает только меньшую часть
 * гонки: самое большое окно - `deriveKey` внутри `createNewVault` (намеренно
 * ~0.5-1с) между перепроверкой и записью на диск - остаётся принятым
 * остаточным риском, не гарантией отсутствия конфликта.
 *
 * `passwordConfirm` проверяется ПЕРВЫМ делом, до `createNewVault`/`save` -
 * несовпадение не создаёт ни стор, ни файл на диске (см. тест "does not
 * create a vault..." в `LockScreen.test.ts`). Это подстраховка на уровне
 * функции поверх отключённой в UI кнопки - опечатка в новом мастер-пароле
 * иначе осталась бы незамеченной (в отличие от разблокировки, где неверный
 * пароль сразу выдаёт себя отказом расшифровки).
 */
export async function submitCreate(params: {
  vaultPath: string;
  password: string;
  passwordConfirm: string;
  onUnlock: (store: VaultStore, vaultPath: string) => void;
}): Promise<SubmitResult> {
  if (params.password !== params.passwordConfirm) {
    return { ok: false, message: PASSWORD_MISMATCH_MESSAGE };
  }
  const store = new VaultStore();
  await store.createNewVault(params.password);
  try {
    await store.save(params.vaultPath);
  } catch (err) {
    console.error("LockScreen: failed to persist newly created vault", err);
    return { ok: false, message: CREATE_SAVE_ERROR_MESSAGE };
  }
  params.onUnlock(store, params.vaultPath);
  return { ok: true };
}

/**
 * Восстановление после повреждения (R114i) - открыть конкретный файл бэкапа
 * тем же паролем. `vaultPath` в колбэке - путь к основной базе (не к файлу
 * бэкапа): следующий обычный save() должен писать в `vault.dat`, а не
 * перезаписывать сам бэкап (см. комментарий `loadFromBackupFile` в
 * vaultStore.ts - открытие бэкапа не заменяет боевой файл автоматически).
 */
export async function submitRecovery(params: {
  backupPath: string;
  password: string;
  vaultPath: string;
  onUnlock: (store: VaultStore, vaultPath: string) => void;
}): Promise<SubmitResult> {
  const store = new VaultStore();
  try {
    await store.loadFromBackupFile(params.backupPath, params.password);
  } catch (err) {
    if (err instanceof DecryptError || err instanceof FormatError) {
      return { ok: false, message: UNLOCK_ERROR_MESSAGE };
    }
    throw err;
  }
  params.onUnlock(store, params.vaultPath);
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Сеть на фоне экрана блокировки (тикет 13, R54/R73/R76/R77/R78/R79/R80/R81/
 * R107, спецификация §16). "Медленно дрейфующая монохромная сеть узлов и
 * линий, слабое свечение" - референс design-assets/lockscreen-network-
 * reference.gif. Ниже - вся математика (позиции узлов, easing 400ms-разлёта,
 * сглаживание скорости при busy, прогресс "потери связей" на ошибке,
 * prefers-reduced-motion), выделенная в чистые экспортированные функции и
 * протестированная напрямую (LockScreen.test.ts) - тот же приём, что и выше
 * для submitUnlock/submitCreate/submitRecovery: в проекте нет jsdom, сам
 * canvas не рендерится в автотесте, но числа, которые он использует, можно
 * и нужно проверить без DOM. Отрисовка на canvas и подписки на resize/
 * matchMedia/onResized - императивный код внутри компонента LockScreen
 * ниже, проверен чтением и сборкой (tsc/vite build), как и остальной JSX
 * этого файла.
 * ---------------------------------------------------------------------- */

/**
 * Число узлов сети (R80). Единственная ручка для слабой машины - позиции
 * (`nodePositionAt`) и перебор соединений между узлами в `drawFrame` оба
 * масштабируются от длины массива seed'ов (`generateNodeSeeds(NETWORK_NODE_COUNT)`),
 * больше нигде в файле число узлов не захардкожено. Уменьшение этой
 * константы напрямую уменьшает и число точек, и число проверяемых на кадр
 * пар (перебор соединений - O(n^2)), без правки остальной логики.
 */
export const NETWORK_NODE_COUNT = 48;

/** Длительность анимации "сеть расходится к краям и гаснет" при успешной
 * разблокировке, мс - дословно из спецификации §16 (R76: "за 400ms"). */
export const SUCCESS_DISPERSE_MS = 400;

/** Длительность анимации "сеть теряет связи и собирается заново" при ошибке
 * (R77). Бриф даёт только "на мгновение", точной цифры нет - craft-решение:
 * достаточно долго, чтобы быть заметной на глаз, короче секунды, чтобы не
 * казаться зависанием при повторном вводе пароля. */
export const ERROR_DISRUPT_MS = 700;

/**
 * Seed-параметры одного узла сети - две наложенные синусоиды на каждую ось
 * (амплитуда/угловая скорость/фаза), центрированные вокруг домашней точки
 * (cx, cy). Все координаты и амплитуды - доля ширины/высоты канваса (0..1),
 * не пиксели: перевод в пиксели - единственное, что зависит от реального
 * размера окна (см. drawFrame), сам seed от него не зависит.
 */
export interface NetworkNodeSeed {
  cx: number;
  cy: number;
  rx1: number;
  rx2: number;
  ry1: number;
  ry2: number;
  wx1: number;
  wx2: number;
  wy1: number;
  wy2: number;
  px1: number;
  px2: number;
  py1: number;
  py2: number;
}

/**
 * Позиция узла в момент виртуального времени `simulatedMs` - доля
 * ширины/высоты канваса. Чистая функция от (seed, t), без накопления
 * состояния кадр-за-кадром: положение узла в любой момент времени можно
 * посчитать заново, ничего не храня между кадрами - поэтому остановка
 * анимации (сворачивание окна, R79) и её возобновление не требуют отдельно
 * восстанавливать "скорость" или "направление", только продолжить считать
 * `simulatedMs` с того места, где остановились.
 *
 * Сумма двух гармоник на каждую ось (а не одна) - чтобы траектория не была
 * идеальным эллипсом вокруг (cx, cy): вторая, более быстрая и мелкая
 * гармоника даёт органичное "виляние" без обращения к случайности на каждом
 * кадре.
 */
export function nodePositionAt(seed: NetworkNodeSeed, simulatedMs: number): { x: number; y: number } {
  const x =
    seed.cx +
    seed.rx1 * Math.sin(seed.wx1 * simulatedMs + seed.px1) +
    seed.rx2 * Math.sin(seed.wx2 * simulatedMs + seed.px2);
  const y =
    seed.cy +
    seed.ry1 * Math.sin(seed.wy1 * simulatedMs + seed.py1) +
    seed.ry2 * Math.sin(seed.wy2 * simulatedMs + seed.py2);
  return { x, y };
}

/**
 * Случайные seed'ы для `count` узлов. Сама случайность не тестируется (нет
 * "правильного" случайного значения) - тестируется только то, что
 * запрошенное число узлов реально создаётся (см. LockScreen.test.ts) - это
 * единственное, от чего зависит R80: длина этого массива определяет и число
 * точек, и число пар в переборе соединений (`drawFrame`), это единственное
 * место, где `NETWORK_NODE_COUNT` используется.
 */
export function generateNodeSeeds(count: number): NetworkNodeSeed[] {
  const seeds: NetworkNodeSeed[] = [];
  for (let i = 0; i < count; i++) {
    seeds.push({
      cx: Math.random(),
      cy: Math.random(),
      rx1: 0.02 + Math.random() * 0.05,
      ry1: 0.02 + Math.random() * 0.05,
      rx2: 0.005 + Math.random() * 0.015,
      ry2: 0.005 + Math.random() * 0.015,
      wx1: 0.00006 + Math.random() * 0.00006,
      wy1: 0.00006 + Math.random() * 0.00006,
      wx2: 0.00015 + Math.random() * 0.00015,
      wy2: 0.00015 + Math.random() * 0.00015,
      px1: Math.random() * Math.PI * 2,
      py1: Math.random() * Math.PI * 2,
      px2: Math.random() * Math.PI * 2,
      py2: Math.random() * Math.PI * 2,
    });
  }
  return seeds;
}

/** Доля пройденного времени анимации в [0, 1] - общий зажим для
 * disperseProgress/disruptConnectionStrength, чтобы кадр rAF, который почти
 * никогда не попадает ровно в конец длительности, не экстраполировал
 * дальше конечного состояния. */
function animationProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= durationMs) return 1;
  return elapsedMs / durationMs;
}

/** Кадр анимации "сеть расходится и гаснет" (R76): `spread` - 0 в начале, 1
 * когда узлы долетели до предельного разлёта; `opacity` - 1 в начале (сеть
 * полностью видна), 0 когда погасла. */
export interface DisperseFrame {
  spread: number;
  opacity: number;
}

/**
 * Прогресс разлёта на успехе, дословно 400ms из спецификации §16 (R76).
 * `spread` - easeOutCubic (быстрый старт, плавное замедление - "расходится",
 * не выстреливает залпом). `opacity` - easeInCubic по убыванию (держится
 * видимой большую часть перехода, гаснет резче ближе к концу - иначе сеть
 * выглядела бы наполовину прозрачной половину всего перехода).
 */
export function disperseProgress(elapsedMs: number, durationMs: number): DisperseFrame {
  const t = animationProgress(elapsedMs, durationMs);
  return {
    spread: 1 - (1 - t) ** 3,
    opacity: 1 - t ** 3,
  };
}

/**
 * Сила связей (доля обычной дистанции соединения между узлами) во время
 * анимации ошибки (R77) - единственное, что меняется: позиции узлов не
 * трогаются (никакой тряски, дословно из тикета), цвет не меняется (никаких
 * красных рамок, тоже дословно). Один синус даёт симметричный провал: 1 в
 * начале (сеть ещё цела) -> 0 в середине (связи потеряны) -> 1 в конце
 * (собралась заново) - "на мгновение теряет связи и собирается заново"
 * одной формулой, без отдельной анимации на "разрыв" и на "сборку".
 */
export function disruptConnectionStrength(elapsedMs: number, durationMs: number): number {
  const t = animationProgress(elapsedMs, durationMs);
  return 1 - Math.sin(Math.PI * t);
}

/**
 * Плавно подтягивает текущую "интенсивность" сети (0 = состояние покоя, 1 =
 * идёт деривация ключа/busy) к целевому значению - экспоненциальное
 * сглаживание с постоянной времени `smoothingMs`, а не мгновенный скачок:
 * переход в busy и обратно должен выглядеть как "уплотняется и ускоряется"
 * (R75), а не как рывок на первом же кадре. `smoothingMs <= 0` трактуется
 * как "сглаживания нет" - мгновенный переход к target (защита от деления на
 * ноль в показателе экспоненты).
 */
export function stepIntensity(current: number, target: number, dtMs: number, smoothingMs: number): number {
  if (smoothingMs <= 0) return target;
  const decay = Math.exp(-dtMs / smoothingMs);
  return target + (current - target) * decay;
}

/**
 * Разрешена ли анимация (R78). Принимает результат
 * `matchMedia("(prefers-reduced-motion: reduce)").matches` отдельным
 * параметром вместо чтения `window` самой функцией - тот же приём, что и во
 * всех остальных чистых функциях этого файла (нет DOM в тестах). Значение,
 * которое не удалось определить (`matchMedia` недоступен вне настоящего
 * браузера), трактуется как "предпочтение не выставлено" - анимация
 * разрешена, тот же принцип "неизвестно = дефолт", что и в
 * `checkExistingVault` выше.
 */
export function isMotionAllowed(prefersReducedMotion: boolean | null | undefined): boolean {
  return prefersReducedMotion !== true;
}

/** Состояние спецэффекта поверх обычного дрейфа - переключается компонентом
 * при успехе (R76) и при ошибке (R77), само возвращается в "idle", когда
 * время анимации истекло (см. resolveAnimPhase/drawFrame). */
type NetworkAnimPhase =
  | { kind: "idle" }
  | { kind: "disperse"; startedAtMs: number }
  | { kind: "disrupt"; startedAtMs: number };

/** Числа, которые зависят от текущей фазы - вынесено из drawFrame, чтобы
 * сама фаза (disperseProgress/disruptConnectionStrength) оставалась чистой
 * и проверяемой отдельно, а drawFrame ничего не знал про "почему", только
 * про готовые числа для конкретного кадра. */
function resolveAnimPhase(
  phase: NetworkAnimPhase,
  nowMs: number,
): { spread: number; opacityMul: number; connectionStrength: number; expired: boolean } {
  if (phase.kind === "disperse") {
    const frame = disperseProgress(nowMs - phase.startedAtMs, SUCCESS_DISPERSE_MS);
    return { spread: frame.spread, opacityMul: frame.opacity, connectionStrength: 1, expired: false };
  }
  if (phase.kind === "disrupt") {
    const elapsed = nowMs - phase.startedAtMs;
    return {
      spread: 0,
      opacityMul: 1,
      connectionStrength: disruptConnectionStrength(elapsed, ERROR_DISRUPT_MS),
      expired: elapsed >= ERROR_DISRUPT_MS,
    };
  }
  return { spread: 0, opacityMul: 1, connectionStrength: 1, expired: false };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface NetworkColorRgb {
  r: number;
  g: number;
  b: number;
}

interface NetworkColors {
  node: NetworkColorRgb;
  line: NetworkColorRgb;
  glow: string;
}

/** rgb-фолбэки, если чтение переменной из CSS не удалось - совпадают со
 * значениями --text/--text-dim в tokens.css на момент написания. */
const FALLBACK_NODE_RGB: NetworkColorRgb = { r: 230, g: 234, b: 240 };
const FALLBACK_LINE_RGB: NetworkColorRgb = { r: 122, g: 132, b: 148 };

function parseCssColorToRgb(value: string): NetworkColorRgb | null {
  const trimmed = value.trim();
  const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (hexMatch) {
    const digits = hexMatch[1];
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((c) => c + c)
            .join("")
        : digits;
    const num = parseInt(full, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
  if (rgbMatch) {
    return { r: Number(rgbMatch[1]), g: Number(rgbMatch[2]), b: Number(rgbMatch[3]) };
  }
  return null;
}

function withAlpha(rgb: NetworkColorRgb, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamped})`;
}

/** Цвета сети из дизайн-токенов (R60 - никаких хардкод-цветов в компоненте):
 * --text для узлов (ярче, "светящаяся точка"), --text-dim для линий и
 * свечения (тусклее, "тонкая линия") - монохром, без --accent (тот
 * зарезервирован под осмысленные состояния интерфейса, R59, фон-дрейф
 * декоративен и ничего не означает). DOM-зависимо (getComputedStyle) - не
 * тестируется, тот же принцип, что и остальной JSX/canvas-код компонента. */
function readNetworkColors(): NetworkColors {
  const styles = getComputedStyle(document.documentElement);
  const node = parseCssColorToRgb(styles.getPropertyValue("--text")) ?? FALLBACK_NODE_RGB;
  const line = parseCssColorToRgb(styles.getPropertyValue("--text-dim")) ?? FALLBACK_LINE_RGB;
  const glowRaw = styles.getPropertyValue("--text-dim").trim();
  return { node, line, glow: glowRaw || "#7a8494" };
}

function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.round(canvas.clientWidth * dpr);
  const targetHeight = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

const NODE_RADIUS = 1.6;
const NODE_GLOW_BLUR = 7;
const NODE_BASE_ALPHA = 0.75;
const LINE_BASE_ALPHA = 0.35;
const DISPERSE_OUTWARD_FACTOR = 1.6;
const IDLE_CONNECTION_FRAC = 0.14;
const BUSY_CONNECTION_FRAC = 0.24;
const IDLE_TIME_MULTIPLIER = 1;
const BUSY_TIME_MULTIPLIER = 3;
const INTENSITY_SMOOTHING_MS = 250;

/**
 * Рисует один кадр сети и возвращает следующую фазу анимации (idle, если
 * прошлая фаза только что истекла - см. resolveAnimPhase). Сама функция не
 * читает никакого React-состояния - все числа приходят параметрами.
 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  seeds: NetworkNodeSeed[],
  simulatedMs: number,
  colors: NetworkColors,
  connectionDistanceFrac: number,
  phase: NetworkAnimPhase,
  nowMs: number,
): NetworkAnimPhase {
  const resolved = resolveAnimPhase(phase, nowMs);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  // Полная очистка каждый кадр (не полупрозрачная заливка "поверх
  // предыдущего кадра" - пробовалась как приём для шлейфа/трейла, отклонена:
  // узлы дрейфуют слишком медленно, почти не сдвигаясь между кадрами, а
  // значит и glow, и соединительные линии перерисовываются практически на
  // тех же пикселях каждый кадр - при source-over поверх не полностью
  // стёртого фона это математически гарантированно сходится к сплошной
  // непрозрачной кляксе за конечное число кадров, независимо от alpha
  // заливки (проверено и увидено на живом скриншоте - "дымчатые разводы",
  // не аккуратный дрейф). clearRect не даёт этой деградации накопиться.
  ctx.clearRect(0, 0, width, height);
  const nextPhase: NetworkAnimPhase = resolved.expired ? { kind: "idle" } : phase;
  if (width === 0 || height === 0) return nextPhase;

  const centerX = width / 2;
  const centerY = height / 2;
  const outwardScale = 1 + resolved.spread * DISPERSE_OUTWARD_FACTOR;

  const positions = seeds.map((seed) => {
    const { x, y } = nodePositionAt(seed, simulatedMs);
    return {
      x: centerX + (x * width - centerX) * outwardScale,
      y: centerY + (y * height - centerY) * outwardScale,
    };
  });

  const connectionDistance = Math.min(width, height) * connectionDistanceFrac * resolved.connectionStrength;

  if (connectionDistance > 0 && resolved.opacityMul > 0) {
    ctx.lineWidth = 1;
    ctx.shadowBlur = 0;
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dx = positions[i].x - positions[j].x;
        const dy = positions[i].y - positions[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < connectionDistance) {
          const alpha = (1 - dist / connectionDistance) * LINE_BASE_ALPHA * resolved.opacityMul;
          if (alpha <= 0.004) continue;
          ctx.strokeStyle = withAlpha(colors.line, alpha);
          ctx.beginPath();
          ctx.moveTo(positions[i].x, positions[i].y);
          ctx.lineTo(positions[j].x, positions[j].y);
          ctx.stroke();
        }
      }
    }
  }

  if (resolved.opacityMul > 0) {
    ctx.shadowBlur = NODE_GLOW_BLUR;
    ctx.shadowColor = colors.glow;
    ctx.fillStyle = withAlpha(colors.node, NODE_BASE_ALPHA * resolved.opacityMul);
    for (const pos of positions) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, NODE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  return nextPhase;
}

export interface LockScreenProps {
  /** Путь к файлу базы. Экран сам определяет разблокировку/создание по
   * наличию файла на этом пути (R95). */
  vaultPath: string;
  /**
   * Вызывается после успешной расшифровки существующей базы или создания
   * новой - это и есть событие "открывает список записей" (сам список
   * подключит другой тикет). Второй аргумент - путь, с которым в итоге
   * связан стор: как правило равен исходному `vaultPath`, но может
   * отличаться, если пользователь во время создания выбрал другое
   * расположение (сценарий "здесь уже есть база", R95.1).
   */
  onUnlock: (store: VaultStore, vaultPath: string) => void;
  /**
   * Необязательный запрос другого пути при конфликте создания (R95.1,
   * "выбрать другое место"). Если не передан, экран сам предлагает ввести
   * путь текстовым полем - минимальная рабочая версия без диалога ОС:
   * `@tauri-apps/plugin-dialog` предусмотрен спецификацией для этого сценария,
   * но не установлен ни в одном предыдущем тикете, а устанавливать новую
   * зависимость вне явного запроса пользователя - не в зоне этого тикета
   * (R31). Когда диалог появится, эту функцию достаточно передать пропом, не
   * трогая остальной компонент.
   */
  onPickAlternatePath?: () => Promise<string | null>;
}

type Phase = "checking" | "unlock" | "create" | "conflict";

export function LockScreen({ vaultPath, onUnlock, onPickAlternatePath }: LockScreenProps) {
  const [activePath, setActivePath] = useState(vaultPath);
  const [phase, setPhase] = useState<Phase>("checking");
  const [existingBytes, setExistingBytes] = useState<Uint8Array | null>(null);
  const [password, setPassword] = useState("");
  // Только для ветки создания (R95.1-смежное решение оркестратора,
  // 2026-08-16) - на разблокировке существующей базы повтор не нужен,
  // ошибку и так сразу показывает отказ расшифровки.
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [altPathInput, setAltPathInput] = useState(vaultPath);

  // --- Сеть на фоне (тикет 13, §16) ---------------------------------------
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const disperseTimeoutRef = useRef<number | null>(null);
  const animPhaseRef = useRef<NetworkAnimPhase>({ kind: "idle" });

  /**
   * Вызывается вместо прямой передачи пропа `onUnlock` в submitUnlock/
   * submitCreate/submitRecovery (R76) - запускает разлёт сети и держит
   * реальный `onUnlock` не дольше `SUCCESS_DISPERSE_MS`. Контракт наружу не
   * меняется: `onUnlock(store, vaultPath)` из пропсов вызывается ровно один
   * раз, как и раньше, просто чуть позже - чтобы разлёт успел доиграть.
   */
  function unlockAfterDisperse(unlockedStore: VaultStore, unlockedPath: string) {
    animPhaseRef.current = { kind: "disperse", startedAtMs: performance.now() };
    if (disperseTimeoutRef.current !== null) {
      clearTimeout(disperseTimeoutRef.current);
    }
    disperseTimeoutRef.current = setTimeout(() => {
      disperseTimeoutRef.current = null;
      onUnlock(unlockedStore, unlockedPath);
    }, SUCCESS_DISPERSE_MS);
  }

  /** Единая точка показа ошибки (R77) - и текст (как в тикете 06), и
   * визуальный "сеть теряет связи" на канвасе вместе, а не одно вместо
   * другого. */
  function reportError(message: string) {
    setError(message);
    animPhaseRef.current = { kind: "disrupt", startedAtMs: performance.now() };
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const seeds = generateNodeSeeds(NETWORK_NODE_COUNT);
    const colors = readNetworkColors();
    const mql: MediaQueryList | null =
      typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

    let reducedMotion = !isMotionAllowed(mql?.matches);
    let stoppedForMinimize = false;
    let rafId: number | null = null;
    let lastFrameTime: number | null = null;
    let virtualTimeMs = 0;
    let intensity = 0;

    // Обычные `function`-объявления здесь не годятся: они хойстятся, и TS
    // из-за этого не переносит внутрь них сужение типа `canvas`/`ctx` до
    // non-null (сделанное выше через `if (!canvas) return`) - поэтому все
    // замыкания ниже объявлены как `const`-стрелочные функции, в порядке
    // зависимостей друг от друга (используются уже после объявления).
    const renderCurrentFrame = () => {
      const connFrac = lerp(IDLE_CONNECTION_FRAC, BUSY_CONNECTION_FRAC, intensity);
      animPhaseRef.current = drawFrame(
        ctx,
        canvas,
        seeds,
        virtualTimeMs,
        colors,
        connFrac,
        animPhaseRef.current,
        performance.now(),
      );
    };

    const loop = () => {
      rafId = null;
      if (stoppedForMinimize || reducedMotion) return;
      const now = performance.now();
      const dt = lastFrameTime === null ? 0 : now - lastFrameTime;
      lastFrameTime = now;
      intensity = stepIntensity(intensity, busyRef.current ? 1 : 0, dt, INTENSITY_SMOOTHING_MS);
      const timeMultiplier = lerp(IDLE_TIME_MULTIPLIER, BUSY_TIME_MULTIPLIER, intensity);
      virtualTimeMs += dt * timeMultiplier;
      const connFrac = lerp(IDLE_CONNECTION_FRAC, BUSY_CONNECTION_FRAC, intensity);
      animPhaseRef.current = drawFrame(ctx, canvas, seeds, virtualTimeMs, colors, connFrac, animPhaseRef.current, now);
      rafId = requestAnimationFrame(loop);
    };

    const startLoop = () => {
      if (rafId !== null || reducedMotion || stoppedForMinimize) return;
      lastFrameTime = null;
      rafId = requestAnimationFrame(loop);
    };

    const stopLoop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const handleWindowResize = () => {
      resizeCanvasToDisplaySize(canvas, ctx);
      if (rafId === null) renderCurrentFrame();
    };

    const handleMotionChange = () => {
      reducedMotion = !isMotionAllowed(mql?.matches);
      if (reducedMotion) {
        stopLoop();
        renderCurrentFrame();
      } else {
        startLoop();
      }
    };

    resizeCanvasToDisplaySize(canvas, ctx);
    window.addEventListener("resize", handleWindowResize);
    mql?.addEventListener("change", handleMotionChange);

    if (reducedMotion) {
      renderCurrentFrame();
    } else {
      startLoop();
    }

    // R79: сигнал сворачивания окна - тот же приём (onResized + isMinimized),
    // что и в useAutoLock.ts (тикет 06). Продублирован здесь намеренно, а не
    // импортирован оттуда - useAutoLock.ts ничего не экспортирует для
    // переиспользования, таков принятый в проекте принцип для этого сигнала
    // (см. interfaces.md, "Из таска 06").
    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    getCurrentWindow()
      .onResized(async () => {
        try {
          const minimized = await getCurrentWindow().isMinimized();
          if (minimized) {
            stoppedForMinimize = true;
            stopLoop();
          } else if (stoppedForMinimize) {
            stoppedForMinimize = false;
            lastFrameTime = null;
            startLoop();
          }
        } catch {
          // Вне реального Tauri-рантайма window-API недоступен - как и в
          // useAutoLock.ts, тихо игнорируем, фон продолжает анимироваться.
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenResize = unlisten;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      stopLoop();
      window.removeEventListener("resize", handleWindowResize);
      mql?.removeEventListener("change", handleMotionChange);
      unlistenResize?.();
      if (disperseTimeoutRef.current !== null) {
        clearTimeout(disperseTimeoutRef.current);
        disperseTimeoutRef.current = null;
      }
    };
    // Пустой список зависимостей нарочно: канвас монтируется один раз вместе
    // с LockScreen, а LockScreen существует только пока приложение
    // заблокировано (App.tsx рендерит его лишь при store === null) - обычный
    // unmount-cleanup эффекта уже останавливает requestAnimationFrame,
    // отдельный сигнал "заблокировано" не нужен (см. отчёт по тикету).
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPhase("checking");
    setError(null);
    setBackups([]);
    checkExistingVault(activePath).then((bytes) => {
      if (cancelled) return;
      if (bytes !== null) {
        setExistingBytes(bytes);
        setPhase("unlock");
      } else {
        setExistingBytes(null);
        setPhase("create");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  async function handleUnlockSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || existingBytes === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitUnlock({
        existingBytes,
        password,
        vaultPath: activePath,
        onUnlock: unlockAfterDisperse,
      });
      if (!result.ok) {
        reportError(result.message);
        const recoveryList = await VaultStore.listBackupsForRecovery(activePath).catch(() => []);
        setBackups(recoveryList);
      }
    } catch (err) {
      console.error("LockScreen: unexpected error while unlocking", err);
      reportError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  async function handleRecoverClick() {
    if (busy || backups.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitRecovery({
        backupPath: backups[0].path,
        password,
        vaultPath: activePath,
        onUnlock: unlockAfterDisperse,
      });
      if (!result.ok) {
        reportError(result.message);
      }
    } catch (err) {
      console.error("LockScreen: unexpected error while recovering from a backup", err);
      reportError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const freshBytes = await checkExistingVault(activePath);
      if (freshBytes !== null) {
        // Кто-то успел создать файл по этому пути между первичной проверкой
        // и отправкой формы (R95.1) - перезаписи без выбора нет.
        setExistingBytes(freshBytes);
        setPhase("conflict");
        return;
      }
      const result = await submitCreate({
        vaultPath: activePath,
        password,
        passwordConfirm,
        onUnlock: unlockAfterDisperse,
      });
      if (!result.ok) {
        reportError(result.message);
      }
    } catch (err) {
      console.error("LockScreen: unexpected error while creating a new vault", err);
      reportError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  async function handleUseAlternatePath() {
    if (onPickAlternatePath) {
      const picked = await onPickAlternatePath();
      if (picked) {
        setActivePath(picked);
      }
      return;
    }
    if (altPathInput.trim() !== "") {
      setActivePath(altPathInput.trim());
    }
  }

  function handleConflictKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      setPhase("create");
      setExistingBytes(null);
    }
  }

  // Подсказка показывается только когда пользователь уже начал вводить
  // повтор (не сразу на пустом поле - иначе она мигала бы при каждом первом
  // символе). Кнопка "Создать" неактивна, пока оба поля не совпадают -
  // решение оркестратора от 2026-08-16 (см. PASSWORD_MISMATCH_MESSAGE).
  const passwordsMismatch = passwordConfirm.length > 0 && password !== passwordConfirm;
  const createDisabled =
    busy || password.length === 0 || passwordConfirm.length === 0 || passwordsMismatch;

  return (
    <div className="lock-screen">
      <canvas ref={canvasRef} className="lock-screen__canvas" aria-hidden="true" />
      <div className="lock-screen__panel">
        {phase === "checking" && (
          <p className="lock-screen__status" role="status">
            {DERIVING_LABEL}
          </p>
        )}

        {phase === "unlock" && (
          <form className="lock-screen__form" onSubmit={handleUnlockSubmit}>
            <label className="lock-screen__label" htmlFor="lock-screen-password">
              Мастер-пароль
            </label>
            <input
              id="lock-screen-password"
              type="password"
              className="lock-screen__input"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoFocus
              disabled={busy}
            />
            <button
              type="submit"
              className="lock-screen__submit"
              disabled={busy || password.length === 0}
            >
              {busy ? DERIVING_LABEL : "Открыть"}
            </button>
            {error && (
              <div className="lock-screen__error" role="alert">
                <p>{error}</p>
                {backups.length > 0 && (
                  <button
                    type="button"
                    className="lock-screen__recover"
                    onClick={handleRecoverClick}
                    disabled={busy}
                  >
                    Открыть последнюю рабочую копию
                  </button>
                )}
              </div>
            )}
          </form>
        )}

        {phase === "create" && (
          <form className="lock-screen__form" onSubmit={handleCreateSubmit}>
            <label className="lock-screen__label" htmlFor="lock-screen-password">
              Новый мастер-пароль
            </label>
            <input
              id="lock-screen-password"
              type="password"
              className="lock-screen__input"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoFocus
              disabled={busy}
            />
            <label className="lock-screen__label" htmlFor="lock-screen-password-confirm">
              Повторите пароль
            </label>
            <input
              id="lock-screen-password-confirm"
              type="password"
              className="lock-screen__input"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.currentTarget.value)}
              disabled={busy}
            />
            {passwordsMismatch && (
              <p className="lock-screen__hint" role="alert">
                {PASSWORD_MISMATCH_MESSAGE}
              </p>
            )}
            <button type="submit" className="lock-screen__submit" disabled={createDisabled}>
              {busy ? DERIVING_LABEL : "Создать"}
            </button>
            {error && (
              <p className="lock-screen__error" role="alert">
                {error}
              </p>
            )}
          </form>
        )}

        {phase === "conflict" && (
          <div className="lock-screen__conflict" onKeyDown={handleConflictKeyDown}>
            <p>Здесь уже есть база: открыть её или выбрать другое место.</p>
            <div className="lock-screen__conflict-actions">
              <button type="button" onClick={() => setPhase("unlock")}>
                Открыть
              </button>
              {!onPickAlternatePath && (
                <>
                  <label htmlFor="lock-screen-alt-path">Другой путь к файлу базы</label>
                  <input
                    id="lock-screen-alt-path"
                    className="lock-screen__input"
                    value={altPathInput}
                    onChange={(e) => setAltPathInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      // R89: Enter в этом поле - то же самое, что клик по
                      // "Выбрать другое место" (кнопка ниже), а не просто
                      // безмолвное нажатие клавиши без эффекта.
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleUseAlternatePath();
                      }
                    }}
                  />
                </>
              )}
              <button type="button" onClick={handleUseAlternatePath}>
                Выбрать другое место
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
