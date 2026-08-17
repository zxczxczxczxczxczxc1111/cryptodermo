// Кросс-компат тест: emergency-decrypt.py <-> приложение (interfaces.md,
// таблица "Швы для тестов"). Обязательный автотест по брифу: "приложение
// создаёт базу, аварийный скрипт её открывает, содержимое совпадает - тест
// должен падать, если формат изменился, а скрипт не обновили" (R26).
//
// Обычный .js-файл, а не .ts - намеренно. Тест порождает реальный процесс
// Python и пишет реальный файл на диск (`node:child_process`, `node:fs`),
// а в проекте нет пакета `@types/node` (и его установка - не эта ситуация:
// "отсутствующая зависимость - это BLOCKED", а не тихая установка, см.
// отчёт по тикету 05). Без типов Node `tsc` (часть `npm run build` /
// `npm run tauri build`, см. `beforeBuildCommand` в tauri.conf.json) не
// проходит на импортах `node:*`. `tsconfig.json` не включает `allowJs`,
// поэтому `.js`-файлы в `src/` попросту не участвуют в проверке типов - а
// Vitest подхватывает `*.test.js` тем же способом, что и `*.test.ts` (это
// его дефолтный `test.include`, отдельная настройка не нужна). Так тест
// реально запускается и проверяет то, что должен, не трогая tsc вообще.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultStore } from "./vaultStore";

// Доступен ли интерпретатор Python в этом окружении - проверяется один раз
// при загрузке модуля. На машине без Python тест явно помечается skipped с
// причиной, а не падает по ENOENT, маскируя реальную причину под "тест не
// прошёл".
const pythonCheck = spawnSync("python", ["--version"]);
const hasPython = pythonCheck.status === 0;

describe("emergency-decrypt.py <-> app cross-compatibility", () => {
  it.skipIf(!hasPython)(
    "R26: the app creates a real vault.dat, emergency-decrypt.py (using aes_gcm.py - " +
      "the project's own from-scratch AES/GCM implementation, see aes_gcm.py's module " +
      "docstring for why a pip package couldn't be used) decrypts it with the same " +
      "password, and the printed JSON matches character-for-character what the app " +
      "wrote. This is the seam interfaces.md names 'emergency-decrypt.py <-> " +
      "приложение' - it must break the moment the container format or the vault body " +
      "schema changes without emergency-decrypt.py being updated to match.",
    async () => {
      const store = new VaultStore();
      const password = "correct horse battery staple";
      await store.createNewVault(password, 1000);
      // Несколько записей, секретные и несекретные поля, теги, заметка -
      // не пустая база и не один короткий блок: реальный JSON на несколько
      // блоков AES (проверяет многоблочный GCTR/inc32 в aes_gcm.py, не
      // только однoблочный частный случай).
      const item1 = store.addItem({
        type: "login",
        title: "cross-compat fixture: GitHub",
        tags: ["work", "dev"],
        fields: [
          { name: "username", value: "alice", secret: false },
          { name: "password", value: "hunter2-very-secret", secret: true },
        ],
        note: "some notes about this account, long enough to matter",
      });
      const item2 = store.addItem({
        type: "note",
        title: "cross-compat fixture: second item",
        tags: [],
        fields: [],
        note: "второй пункт с не-ASCII текстом - юникод должен пройти через UTF-8 туда и обратно без потерь",
      });
      // Не store.search("") - search() сортирует по updatedAt для отображения
      // (документированное поведение самого search(), см. vaultStore.ts), а
      // на диск items пишутся в порядке добавления (toBytes() сериализует
      // this.items как есть, без сортировки), и Python тоже ничего не
      // сортирует - сравнивать нужно с тем же порядком, что реально попал в
      // файл, иначе тест путает "не то сравнили" с "плохо расшифровали".
      const expectedItems = [item1, item2];
      const bytes = await store.toBytes();

      const dir = mkdtempSync(join(tmpdir(), "vault-cross-compat-"));
      const vaultPath = join(dir, "vault.dat");
      writeFileSync(vaultPath, bytes);

      try {
        const result = spawnSync("python", ["emergency-decrypt.py", vaultPath], {
          cwd: process.cwd(),
          env: { ...process.env, VAULT_PASSWORD: password },
          encoding: "utf-8",
        });

        expect(result.status, `script stderr: ${result.stderr}`).toBe(0);

        const decryptedItems = JSON.parse(result.stdout);

        // Структурное совпадение (порядок ключей в JSON.parse не важен для
        // deep-equal)...
        expect(decryptedItems).toEqual(expectedItems);
        // ...и посимвольное совпадение канонической формы (тот же
        // сериализатор с обеих сторон сравнения) - JSON.stringify детерминирован
        // для одинаковой структуры и порядка ключей, а порядок ключей у
        // decryptedItems совпадает с порядком у expectedItems, потому что
        // Python получает те же ключи в том же порядке из JSON.stringify,
        // которым их записал toBytes(), и json.dumps в скрипте не
        // пересортировывает ключи объекта (sort_keys не задан).
        expect(JSON.stringify(decryptedItems)).toBe(JSON.stringify(expectedItems));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // R44/§18, критерий приёмки тикета 11: "emergency-decrypt.py с флагом
  // распаковки вложений создаёт файлы вложений рядом с JSON, содержимое
  // совпадает с оригиналом". Отдельная от теста выше проверка - тот
  // проверяет обычный вывод JSON, этот - флаг --unpack-attachments и
  // именно байт-в-байт сравнение содержимого вложения (не JSON-строки
  // base64, а РЕАЛЬНЫЕ декодированные байты на диске), через реальный
  // формат, который пишет приложение (VaultStore.toBytes()), а не
  // сконструированный вручную JSON.
  it.skipIf(!hasPython)(
    "R44/§18: emergency-decrypt.py --unpack-attachments decodes attachments[].data into a file byte-for-byte identical to the original",
    async () => {
      const store = new VaultStore();
      const password = "attachment cross-compat password";
      await store.createNewVault(password, 1000);

      // Бинарные, не текстовые байты (все значения 0..255 несколько раз) -
      // сильнее проверка, чем случайный текстовый файл: ловит и проблемы
      // кодировки текста, и проблемы двоичного base64.
      const originalBytes = new Uint8Array(300);
      for (let i = 0; i < originalBytes.length; i++) originalBytes[i] = i % 256;
      let binary = "";
      for (let i = 0; i < originalBytes.length; i++) binary += String.fromCharCode(originalBytes[i]);
      const dataBase64 = btoa(binary);

      const item = store.addItem({
        type: "other",
        title: "cross-compat fixture: attachment",
        tags: [],
        fields: [],
        attachments: [
          {
            id: "att-1",
            name: "fixture.bin",
            mimeType: "application/octet-stream",
            size: originalBytes.length,
            data: dataBase64,
          },
        ],
      });

      const bytes = await store.toBytes();
      const dir = mkdtempSync(join(tmpdir(), "vault-cross-compat-attachments-"));
      const vaultPath = join(dir, "vault.dat");
      writeFileSync(vaultPath, bytes);
      const outDir = join(dir, "unpacked");

      try {
        const result = spawnSync(
          "python",
          ["emergency-decrypt.py", vaultPath, "--unpack-attachments", outDir],
          { cwd: process.cwd(), env: { ...process.env, VAULT_PASSWORD: password }, encoding: "utf-8" },
        );

        expect(result.status, `script stderr: ${result.stderr}`).toBe(0);

        const written = readdirSync(outDir);
        expect(written).toHaveLength(1);
        expect(written[0]).toBe(`${item.id}-fixture.bin`);

        const unpackedBytes = new Uint8Array(readFileSync(join(outDir, written[0])));
        expect(unpackedBytes).toEqual(originalBytes);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
