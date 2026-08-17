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
    // Запись с двухфакторкой: без неё живой код в карточке проверить не на
    // чем. Секрет из приложения B к RFC 6238, то есть заведомо публичный.
    {
      type: "login",
      title: "GitHub",
      tags: ["Работа"],
      fields: [
        { name: "Логин", value: "johndoe@gmail.com", secret: false },
        { name: "Пароль", value: "Xk9#mQ2$vL8pR4wZ", secret: true },
        {
          name: "Двухфакторка",
          value: "otpauth://totp/GitHub:johndoe@gmail.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub",
          secret: true,
        },
        { name: "Сайт", value: "https://github.com", secret: false },
      ],
      note: "",
    },
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
      type: "note",
      title: "Договор аренды",
      tags: ["Личное", "Финансы"],
      fields: [],
      note: "Скан договора приложен файлом.",
      // Вложение нужно фикстуре, чтобы раздел «Вложения» в сайдбаре был не
      // пустым: без него фильтр по наличию вложений нечем проверить.
      attachments: [
        {
          id: "fixture-attachment-1",
          name: "dogovor.txt",
          mimeType: "text/plain",
          size: 32,
          data: btoa("Fixture attachment contents, 32b."),
        },
        // Картинка нужна, чтобы проверялась вторая ветка предпросмотра, а не
        // только текстовая.
        // Файл без предпросмотра - чтобы проверялось объяснение причины, а не
        // только успешные ветки.
        {
          id: "fixture-attachment-3",
          name: "arhiv.zip",
          mimeType: "application/zip",
          size: 64,
          data: "UEsDBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        },
        {
          id: "fixture-attachment-2",
          name: "skan.png",
          mimeType: "image/png",
          size: 2675,
          data: "iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAKOklEQVR4nO3afUzU9x3A8S+PKmjGw11TNXJNZ53rnMPWp2pBTk4zrAJKW1eqlYNaA2oqFRVEno6HVlawIizpEifoDqtx1aYWYzrUQWcUxEZb06lLxPmEGQdKLRFBWeDX3CgH9tqNNh/6fv3F/fjy/X0S8/5970AXPz+dAiCT6489AIDvj4ABwQgYEIyAAcEIGBCMgAHBCBgQjIABwQgYEIyAAcEIGBDM3ZlFFRUHB34SAN8wb9589W04gYHBfgI7/zwA8L9z/j0vJzAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCAYAQOCETAgGAEDghEwIBgBA4IRMCCY+wDt++STv0xMXOPu7t7RcT8tLb2hoeH556MWL1781Vdftba2WizZDQ0N2sqoqEWbNqWaTHNtNptSqq6u9uzZs2ZznPbdEyeOT58+o9fmwcFBW7YUPv30FKXUwi6R3t5eBQVbjh8//vbb+TqdTinl4eFhMBiefTbY1dV1w4b1EyZM6OjoSE3ddPXqVfs+I0aMSE7eEBo6236LXrsNHTo0Nzfb39/fy8u7uLikqqqqzxmUUs8880xmZvqNGzeUUqdPf1pUtM3xvo6zTZ8+bfXqVffu3XNzcy8oKDxz5oy22+jRozMy0jw9PVtbW9PSMmw22/Dhw/Pycn19fZqbb23cmHrnzh1n5h+gf1wM/oCzsy0JCatu3rw5Z45p3bq1+/a9P29e2JIlS9va2oKCns3NzYmLe1VbGRISYrVag4OD9u8/oJRqb293c3OfMmVKbW1tnzt7e3uvWPFaR0eHUsrX1zciIjwmxmwwGIqK3lmwICIpab22LCpq0ciRI5VSL774Qmtr68svLwkNDV23bu3rryfatyopKT58+HBo6GztpeNu0dEvffbZudLSUr1eb7Xumju3ynEGjU6n2759x969e+1XHO/rOJvFkmU2x127dm3MmDElJdvCwyO1BZmZGdu3bz9x4uT06dNWroy3WHJWrHitrq6urGxnTMyy5ctf3bLlHWfm///9e+In9hbaz89vyJAhSqmjR4+Vl+82m5dt3VrU1tamlKqu/uTKlSvu7l3PjqFDhw4bNmzfvvdnzQq2/2xJScnKlQn97ZyYuGbnzj93dnYqpXx8fHbv3v3gwYOGhgYfHx/7GhcXl5de+l15+W6l1Pz5z2mPhqqqqjNnzvbc6o031lqt5faXjrvt2/cXq9WqlBo79uc9c+05g0av1zU2/rvn5v3dt+dst27d1m7k4/OzYcOG2deMHz++pqbr+VVTUzt16jSlVFBQ0KFDh5RSFRWHgoODnZwfg95AncBbtxbt3FlaXV394Ycf1dTUjB079osv/mH/bmZmlvbFzJkzP/nk7/X19aNGjfbw8Ghvb1dKnTxZEx8fP3Xq1Jqaml7bPvXUJL1ef/jw4aysDKXUpW5Kqblz5xw7dsy+LCRk1uefn2tqalJKGQyPGY0hRmPI7dst+fn5PXdrbGzs+dJxt5aWFqXUW2/lmUymVatW9zmDRq/XBwQEmM0xt2+3bN6cf+XKlf7u23M2iyV7166yy5f/ZTAEJCauta+5cOGC0WisrKw0mUJ1On+llL+/f2Nj10eMxsZG7Yoz82PQG6gT+MCBD8LDI0+f/jQ5eX1CQryra983mj3buGDBc+Xl1kce0U+ePNl+vaTkD46HsKenZ1JSUm5ubq/rY8aMMZvNhYVd7yo1y5YtKy0t07728HC/fv16TEzswYMHLRbLt07uuFty8sb16zdERIQ/ZIbOzs7z588vXbrswIEPtLD7u2/P2ZKS1m7YkLxw4aKUlI0mU6h9TXp6Rnj4gh07to8aNUp7qDnPcX4MYgMSsK+vb2BgYEtLy/79B+Lili9e/GJ9/eXx43+hfdfFxSUvrysAV1fXxx4zREW9EB39cmrqppCQ/76Lrq2tffDg/rRpU3tuO2eOydvbKz9/c2npn7y8vN58s2sTLy+vgoLfp6enNzc3a8smTvz1l19+WV9fr7202ZoqK48opSorj4wbN+7hk/fabePGFDc3N6XUsWN/09649jmDUspqte7Z0/UB+MiRI088Ma6/+/aabdy4J7Q1H3/8V6MxxD7GvHlhSUnrzOa4o0ePaottNpt28Op0Ou0odmZ+DHoDdAJ3Fha+/eijj2ofzG7cuPHee3tWr17t6emplAoL+62np4f2XvT8+fPaD9TVnZ4x4xu/be4+hFf2vPLRRxUREQtjYmJjYmJbW1tTUlK7nwU5paVlZ89+Zl8WG2suK/v6iOt+Q35SO9snT55sv12fHHcbMWK49iuiSZMCtZAcZ9BWJiauCQmZ1Z3oxIsXL/R3316zXbpUP2lSoFIqMPA3169ft1+fMOFXwcFBSqnIyMiKiq6PvtXV1WFhYVrb1dXVTs6PQW9APgM3N9/KzMwqLCxoa7t7//6DtLT0ixf/aTAE7N27p7m5qampKSen6+AyGo0nT379Kffu3bs2W9Pjjz9u3+TUqbr29nYPj67U+xMZGTFz5kwfHx/tV74JCasCAgL0+kdOnaqzrykuLsnOzoqPX9HRcT8ry/KddisqKs7Ly4mOjm5vb9+0Kf0hP7ttW3FOTvYrryxta7uXkZHV530dZ7NYslNSkru/7ExPz7RfLyjYkpubHRsbe+7cOe1gf/fdP+bl5ZpModqfkZyc/yEDY3Bw8fPr+svkw1VUHOx+9s//QUYCfuoqnC6O/4kFCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCEbAgGAEDAhGwIBgBAwIRsCAYAQMCObu/NKKioMDOQmA74wTGBDMxc9P92PPAOB74gQGBCNgQDACBgQjYEAwAgYEI2BAMAIGBCNgQDACBgQjYEAwAgaUXP8BSDCjRbF1uoAAAAAASUVORK5CYII=",
        },
      ],
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
