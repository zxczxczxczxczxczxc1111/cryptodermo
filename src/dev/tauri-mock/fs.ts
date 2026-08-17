/**
 * Файловая система в памяти для работы над интерфейсом без Tauri.
 *
 * Зачем это вообще есть: приложение в обычном браузере не рендерится дальше
 * заставки. `App.tsx` при монтировании зовёт `exeDir()` -> `invoke("exe_dir")`,
 * а `@tauri-apps/api/core` дёргает `window.__TAURI_INTERNALS__`, которого вне
 * Tauri не существует - летит `TypeError`, и вместо интерфейса видна одна
 * красная строка «Не удалось определить расположение базы». Ни `LockScreen`, ни
 * `AppShell` не монтируются никогда, то есть посмотреть на интерфейс глазами
 * невозможно в принципе.
 *
 * Модуль подключается ТОЛЬКО через `resolve.alias` в `vite.config.ts` при
 * `--mode mock` (скрипт `npm run dev:mock`). В обычный `npm run dev`,
 * `npm run tauri dev` и в собранный бандл он не попадает: на него нет ни одного
 * импорта из боевого кода.
 *
 * Фикстуры генерируются настоящим `VaultStore` и настоящим `setUpPin`, а не
 * заранее сохранённым файлом. Это сознательно: файл-фикстура разошёлся бы с
 * форматом при первой же его правке и начал бы врать, а сгенерированный
 * настоящим кодом расходиться не может.
 *
 * Состояние живёт только в памяти вкладки и сбрасывается при перезагрузке. Для
 * работы над дизайном это плюс, а не минус: каждый заход даёт одну и ту же
 * картинку, и вчерашние тестовые правки не искажают сегодняшние скриншоты.
 *
 * **Учётные данные фикстуры:** мастер-пароль `dev`, PIN `123456`.
 */
import { VaultStore, type NewItemInput } from "../../lib/vaultStore";
import { parseContainer } from "../../lib/vaultFormat";
import { setUpPin } from "../../lib/pinLock";
import type { VaultSettings } from "../../lib/settingsConfig";
import type { BackupInfo } from "../../lib/tauriApi";

/** Мастер-пароль фикстуры. */
export const MOCK_PASSWORD = "dev";
/** PIN фикстуры - шесть цифр, как значение по умолчанию из плана. */
export const MOCK_PIN = "123456";

/** Каталог, который отдаётся вместо настоящего каталога рядом с `.exe`. */
export const MOCK_EXE_DIR = "C:\\cryptodermo-mock";

const VAULT_PATH = `${MOCK_EXE_DIR}\\vault.dat`;
const SETTINGS_PATH = `${MOCK_EXE_DIR}\\vault.settings.json`;
const BACKUP_DIR = `${MOCK_EXE_DIR}\\backups`;

/** Содержимое «диска». Ключ - полный путь в том же виде, в каком его строит
 * приложение (обратные слэши, потому что `exe_dir` отдаёт windows-путь). */
const files = new Map<string, Uint8Array>();

/** Обещание первичного заполнения - чтобы параллельные `read_vault` на старте
 * не запустили генерацию дважды. */
let seeding: Promise<void> | null = null;

/** Одна запись фикстуры. Набор подобран так, чтобы на экране сразу были видны
 * все типы, длинные и короткие заголовки, записи с тегами и без, секретные и
 * несекретные поля - то есть ровно те случаи, на которых ломается вёрстка. */
function fixtureItems(): NewItemInput[] {
  const login = (title: string, user: string, tags: string[]): NewItemInput => ({
    type: "login",
    title,
    tags,
    fields: [
      { name: "Логин", value: user, secret: false },
      { name: "Пароль", value: "Xk9#mQ2$vL8pR4wZ", secret: true },
      { name: "Сайт", value: `https://${title.toLowerCase().replace(/\s+/g, "")}.com`, secret: false },
    ],
    note: "",
  });

  return [
    login("Binance", "binance@gmail.com", ["Криптовалюта", "Финансы"]),
    login("GitHub", "johndoe@gmail.com", ["Работа"]),
    login("Telegram", "+7 999 123 45 67", ["Личное"]),
    login("Cloudflare", "ops@example.com", ["Работа"]),
    login("Steam", "player_one", ["Личное"]),
    login("Почта Проton", "yesnolivedeath@proton.me", ["Личное", "Финансы"]),
    login("Очень длинное название сервиса, которое обязано где-то обрезаться", "user@example.com", [
      "Работа",
      "Личное",
      "Финансы",
      "Архив",
    ]),
    login("A", "a@b.c", []),
    {
      type: "card",
      title: "Visa Gold",
      tags: ["Финансы"],
      fields: [
        { name: "Номер карты", value: "4276 1234 5678 9012", secret: true },
        { name: "Срок действия", value: "05/28", secret: false },
        { name: "CVC", value: "123", secret: true },
      ],
      note: "Основная карта для покупок.",
    },
    {
      type: "card",
      title: "Tinkoff Black",
      tags: ["Финансы"],
      fields: [
        { name: "Номер карты", value: "5536 9876 5432 1098", secret: true },
        { name: "Срок действия", value: "11/27", secret: false },
      ],
      note: "",
    },
    {
      type: "note",
      title: "Личная заметка",
      tags: ["Личное"],
      fields: [],
      note:
        "Длинная заметка, чтобы было видно, как ведёт себя текст на нескольких строках.\n\n" +
        "Второй абзац здесь нужен, чтобы проверить межстрочный интервал и то, как " +
        "читается сплошной текст при базовом размере 14 пикселей.",
    },
    {
      type: "note",
      title: "Короткая заметка",
      tags: [],
      fields: [],
      note: "Одна строка.",
    },
    {
      type: "key",
      title: "SSH ключ рабочего сервера",
      tags: ["Работа"],
      fields: [
        { name: "Путь", value: "D:\\keys\\id_ed25519", secret: false },
        { name: "Passphrase", value: "correct-horse-battery-staple", secret: true },
      ],
      note: "",
    },
    {
      type: "other",
      title: "Лицензия на редактор",
      tags: ["Работа"],
      fields: [{ name: "Ключ", value: "XKCD1-l1I0O-8B8G6-QWERT", secret: true }],
      note: "Проверить различимость единицы, малой L и нуля на этом значении.",
    },
  ];
}

/** Собрать базу и настройки настоящим кодом приложения. */
async function seed(): Promise<void> {
  const store = new VaultStore();
  await store.createNewVault(MOCK_PASSWORD);
  for (const input of fixtureItems()) {
    store.addItem(input);
  }
  const bytes = await store.toBytes();
  files.set(VAULT_PATH, bytes);

  // PIN-обёртка строится тем же путём, что и в LockScreen: соль и число
  // итераций берутся из заголовка только что собранного контейнера.
  const { header } = parseContainer(bytes);
  const salt = Uint8Array.from(atob(header.kdf.salt), (ch) => ch.charCodeAt(0));
  const wrap = await setUpPin(MOCK_PASSWORD, salt, header.kdf.params.iterations, MOCK_PIN);

  const settings: VaultSettings = {
    autoLockTimeoutMs: 300_000,
    lastVaultPath: VAULT_PATH,
    pin: wrap,
    pinSetupOffered: true,
  };
  files.set(SETTINGS_PATH, new TextEncoder().encode(JSON.stringify(settings, null, 2)));

  // Две резервные копии, которые действительно лежат «на диске» - чтобы экран
  // восстановления открывал настоящий файл, а не падал на несуществующем пути.
  files.set(`${BACKUP_DIR}\\vault-2026-08-17T03-00-00.dat`, bytes);
  files.set(`${BACKUP_DIR}\\vault-2026-08-16T03-00-00.dat`, bytes);
}

/** Дождаться первичного заполнения (идемпотентно). */
async function ensureSeeded(): Promise<void> {
  if (!seeding) seeding = seed();
  return seeding;
}

export async function mockReadFile(path: string): Promise<number[]> {
  await ensureSeeded();
  const bytes = files.get(path);
  if (!bytes) {
    // Та же форма отказа, что у настоящей Rust-команды: файла нет - ошибка, а
    // не пустой массив. Иначе `parseContainer` получил бы ноль байт и код
    // пошёл бы по ветке «повреждённый файл» вместо «файла нет».
    throw new Error(`mock: файла нет: ${path}`);
  }
  return Array.from(bytes);
}

export async function mockWriteFile(path: string, bytes: number[]): Promise<void> {
  await ensureSeeded();
  files.set(path, new Uint8Array(bytes));
}

export async function mockListBackups(dir: string): Promise<BackupInfo[]> {
  await ensureSeeded();
  const prefix = dir.endsWith("\\") || dir.endsWith("/") ? dir : `${dir}\\`;
  const result: BackupInfo[] = [];
  let ageMs = 0;
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue;
    ageMs += 24 * 60 * 60 * 1000;
    result.push({
      path,
      filename: path.slice(prefix.length),
      size: bytes.byteLength,
      modifiedAtMs: Date.now() - ageMs,
    });
  }
  return result;
}

export async function mockRotateBackups(): Promise<void> {
  // Ротация на фикстурах ничего осмысленного не делает: копий всего две, и
  // удалять их между перезагрузками незачем.
  await ensureSeeded();
}

export function mockExeDir(): string {
  return MOCK_EXE_DIR;
}

/** Путь, который отдают подменённые диалоги сохранения и открытия файла. */
export function mockDialogPath(extension: string): string {
  return `${MOCK_EXE_DIR}\\dialog-result.${extension}`;
}
