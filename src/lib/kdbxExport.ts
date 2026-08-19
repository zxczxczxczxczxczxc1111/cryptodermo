/**
 * Экспорт в формат KDBX (19.08.2026) - совсем отдельный от «Экспорт» (JSON,
 * `importExport.ts`) путь: тот пишет открытый, нешифрованный файл ради
 * ручного бэкапа/переноса между собственными базами cryptodermo, этот -
 * зашифрованный файл в чужом, но открытом формате (KeePass 2), который
 * открывают бесплатные офлайн-клиенты под iOS (KeePassium, Strongbox) и
 * Android/десктоп (KeePassXC, KeePassDX) без единой строчки мобильного кода
 * в этом проекте.
 *
 * Библиотека `kdbxweb` (не своя реализация - формат KDBX сложнее, чем
 * оправдано писать руками, в отличие от AES-GCM в `aes_gcm.py`, где
 * стандартная библиотека Python не давала выбора вовсе).
 *
 * ФОРМАТ ФАЙЛА - KDBX3 с AES-KDF, а не более новый KDBX4 с Argon2 по
 * умолчанию. Осознанное решение: `kdbxweb` не реализует Argon2 сам, для
 * KDBX4 нужна отдельная WASM-реализация третьей стороны
 * (`CryptoEngine.setArgon2Impl`) - та же дилемма, что уже разобрана и
 * отклонена для собственного формата `vault.dat` (см. память проекта,
 * "PBKDF2 против Argon2id"), только теперь она пришла бы вместе с чужим
 * форматом, а не по нашему выбору. KDBX3 читают ВСЕ те же целевые
 * клиенты (KeePassXC, Strongbox, KeePassium, KeePassDX) без урезаний -
 * выигрыша в совместимости у KDBX4 здесь нет, а цена (WASM-зависимость
 * ради одной функции экспорта) реальна.
 *
 * ПРОВЕРКА ЗАВИСИМОСТИ (19.08.2026): `npm audit` находит high severity
 * уязвимости в `@xmldom/xmldom` (транзитивная зависимость `kdbxweb`) - XML-
 * инъекция через небезопасную сериализацию CDATA/DocumentType/
 * ProcessingInstruction/комментариев. Проверено по исходникам `kdbxweb`
 * (`node_modules/kdbxweb/dist/kdbxweb.js`): ни один из этих узлов не
 * используется вообще - все текстовые значения полей идут через
 * `node.textContent = text` (`XmlUtils.setText`), а это простой текстовый
 * узел, который xmldom экранирует корректно и в уязвимых версиях тоже.
 * Живой смоук-тест (не в тестах проекта, разовая проверка) с полями,
 * специально содержащими `]]>` и `<script>`, прошёл без повреждения XML.
 * Форс через `package.json` `overrides` на исправленную версию xmldom
 * попробован и ОТКЛОНЁН - `kdbxweb@2.1.1` использует конструктор
 * `DOMParser`, несовместимый с API исправленной версии (`onError` вместо
 * `errorHandler`), падает при загрузке любого файла. Вывод: уязвимость
 * реальна в дереве зависимостей, но недостижима через то, как её вызывает
 * `kdbxweb` - перепроверить при обновлении `kdbxweb` на версию, где
 * появится новый мажор `@xmldom/xmldom`.
 *
 * ОТДЕЛЬНАЯ ПРОВЕРКА (19.08.2026): сборка фронта (`vite build`) предупреждает
 * `Module "crypto" has been externalized for browser compatibility` -
 * UMD-обёртка `kdbxweb` в самом начале файла безусловно вызывает
 * `require("crypto")` (Node-модуль, которого нет в браузере/WebView).
 * Юнит-тесты этого не ловят - они выполняются в Node, где `crypto` есть
 * всегда, независимо от того, действительно ли до него доходит выполнение в
 * браузере. Проверено живым запуском в браузерном dev-режиме Vite (не
 * Node): собраны и обратно прочитаны реальные 15 записей мок-базы, пароль
 * и адрес сайта совпали посимвольно, кириллица в названиях не повреждена,
 * ни одной ошибки в консоли, связанной с `crypto`/`kdbxweb`/`xmldom`.
 * Вывод: путь через Node `crypto` в браузерной сборке не достигается на
 * практике (это часть UMD-заглушки на случай CommonJS-окружения, реальное
 * шифрование KDBX3/AES-KDF идёт через `crypto.subtle`), предупреждение
 * безопасно игнорировать.
 */
import * as kdbxweb from "kdbxweb";
import type { Item, ItemField } from "./vaultStore";
import { looksLikeTotp } from "./totp";
import { isOpenableUrl } from "./openExternal";
// Для вложений: `Attachment.data` в нашей модели уже base64, `kdbxweb`
// ждёт сырые байты.
import { base64ToBytes } from "./base64";

/** Одна запись KeePass, которую предстоит создать - результат разбора
 * `Item` на группы аккаунтов (см. `splitItemIntoKdbxEntries` ниже), ДО
 * классификации полей на стандартные/пользовательские слоты KDBX. */
export type KdbxEntryInput = {
  title: string;
  fields: ItemField[];
  note: string;
  tags: string[];
};

/**
 * Разбить запись на одну или несколько записей KeePass - по одной на
 * аккаунт внутри записи (см. `group` у `ItemField`, тот же принцип, что уже
 * применён в `quickBridge.ts#buildQuickRows` для быстрого доступа: человек
 * уже сказал через `group`, что к чему относится, догадываться поверх его
 * разметки не нужно). Поля вне аккаунтов - общий контекст записи (обычно
 * адрес сайта) - копируются в КАЖДУЮ производную запись, названную
 * `"<название> · <аккаунт>"`, той же схемой именования, что уже
 * используется быстрым поиском.
 *
 * Запись без аккаунтов (обычный случай) даёт ровно одну запись KeePass со
 * своими полями как есть.
 */
export function splitItemIntoKdbxEntries(item: Item): KdbxEntryInput[] {
  const named = item.fields.filter((f) => f.group && f.group.trim() !== "");
  if (named.length === 0) {
    return [{ title: item.title, fields: item.fields, note: item.note, tags: item.tags }];
  }

  const loose = item.fields.filter((f) => !f.group || f.group.trim() === "");
  const groupNames: string[] = [];
  for (const f of named) {
    const name = f.group as string;
    if (!groupNames.includes(name)) groupNames.push(name);
  }

  return groupNames.map((name) => ({
    title: `${item.title} · ${name}`,
    fields: [...item.fields.filter((f) => f.group === name), ...loose],
    note: item.note,
    tags: item.tags,
  }));
}

/** Результат классификации полей одной производной записи на стандартные
 * слоты KeePass (Password/UserName/URL/otp) и всё остальное - произвольные
 * пользовательские поля этой записи. */
export type ClassifiedKdbxFields = {
  password: string | null;
  username: string | null;
  url: string | null;
  /** Секрет двухфакторки как есть (`otpauth://...`) - поле по имени `otp`,
   * которое распознают KeePassXC, Strongbox и KeePassDX для показа живого
   * кода, тот же неформальный стандарт, которым уже пользуется вся
   * экосистема KeePass-совместимых клиентов. */
  otp: string | null;
  custom: { name: string; value: string; secret: boolean }[];
};

/**
 * Разложить плоский список полей одной записи по стандартным слотам KeePass
 * (Password/UserName/URL) плюс отдельно двухфакторку - один проход, каждое
 * поле попадает РОВНО в одно место (стандартный слот или `custom`), чтобы
 * то же значение не продублировалось дважды при сборке записи KeePass.
 *
 * Правила (в порядке проверки для каждого поля):
 * 1. Первое секретное поле, не похожее на TOTP-секрет, - пароль.
 * 2. Поле, похожее на TOTP-секрет (`looksLikeTotp`) - двухфакторка.
 * 3. Первое поле, чьё значение выглядит адресом сайта (`isOpenableUrl`),
 *    если адрес ещё не занят, - URL.
 * 4. Первое оставшееся несекретное поле - логин.
 * 5. Всё остальное - пользовательское поле KeePass, секретные значения
 *    заворачиваются в `ProtectedValue` при сборке (не здесь - эта функция
 *    работает со строками, сборка kdbxweb - отдельная функция ниже).
 */
export function classifyKdbxFields(fields: ItemField[]): ClassifiedKdbxFields {
  let password: string | null = null;
  let username: string | null = null;
  let url: string | null = null;
  let otp: string | null = null;
  const custom: ClassifiedKdbxFields["custom"] = [];

  for (const field of fields) {
    if (password === null && field.secret && !looksLikeTotp(field.value)) {
      password = field.value;
      continue;
    }
    if (otp === null && looksLikeTotp(field.value)) {
      otp = field.value;
      continue;
    }
    if (url === null && isOpenableUrl(field.value)) {
      url = field.value;
      continue;
    }
    if (username === null && !field.secret) {
      username = field.value;
      continue;
    }
    custom.push({ name: field.name, value: field.value, secret: field.secret });
  }

  return { password, username, url, otp, custom };
}

/**
 * Собрать файл KDBX3 из записей базы. `masterPassword` - ОТДЕЛЬНЫЙ пароль
 * для этого конкретного файла, не пароль от cryptodermo: экспортированный
 * файл живёт в другом приложении на другом устройстве, у него своя граница
 * защиты (спрашивается отдельно в `ImportExportPanel.tsx`, никогда не
 * подставляется автоматически из мастер-пароля основной базы).
 *
 * Вложения записи (`item.attachments`) прикрепляются только к ПЕРВОЙ
 * производной записи, если запись разошлась на несколько аккаунтов - иначе
 * один и тот же файл дублировался бы в экспорте по числу аккаунтов,
 * раздувая размер без пользы (вложение относится к записи целиком, не к
 * конкретному аккаунту, разложить его по аккаунтам нечем).
 *
 * История изменений (`item.history`) не переносится - KDBX хранит историю
 * как полные снимки записи целиком, а не то же самое построчное изменение
 * полей, что и `vault.dat`; экспорт задуман как мост в другое приложение,
 * не как полная зеркальная копия, для которой уже есть «Экспорт» (JSON).
 */
export async function buildKdbxFile(
  items: Item[],
  masterPassword: string,
  databaseName: string,
): Promise<ArrayBuffer> {
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(masterPassword));
  const db = kdbxweb.Kdbx.create(credentials, databaseName);
  db.setVersion(3);
  db.setKdf(kdbxweb.Consts.KdfId.Aes);
  const rootGroup = db.getDefaultGroup();

  for (const item of items) {
    const derived = splitItemIntoKdbxEntries(item);
    for (let i = 0; i < derived.length; i++) {
      const input = derived[i];
      const entry = db.createEntry(rootGroup);
      entry.fields.set("Title", input.title);
      entry.fields.set("Notes", input.note);
      entry.tags = input.tags;

      const classified = classifyKdbxFields(input.fields);
      if (classified.username !== null) entry.fields.set("UserName", classified.username);
      if (classified.password !== null) {
        entry.fields.set("Password", kdbxweb.ProtectedValue.fromString(classified.password));
      }
      if (classified.url !== null) entry.fields.set("URL", classified.url);
      if (classified.otp !== null) entry.fields.set("otp", classified.otp);
      for (const field of classified.custom) {
        entry.fields.set(field.name, field.secret ? kdbxweb.ProtectedValue.fromString(field.value) : field.value);
      }

      if (i === 0) {
        for (const attachment of item.attachments) {
          const binary = await db.createBinary(kdbxweb.ProtectedValue.fromBinary(base64ToBytes(attachment.data)));
          entry.binaries.set(attachment.name, binary);
        }
      }
    }
  }

  return db.save();
}

/** `YYYY-MM-DD-HHmmss` из локального времени машины - та же маленькая копия
 * (и то же намеренное решение "локальное время, не UTC"), что уже есть в
 * `importExport.ts`/`vaultStore.ts`: пользователь видит "недавние" файлы в
 * порядке, совпадающем с часами на этой же машине. */
function formatTimestampForFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Имя файла по умолчанию для экспорта в KDBX - с датой, тот же принцип,
 * что у `buildExportFilename`/`buildManualCopyFilename` в `importExport.ts`:
 * несколько экспортов подряд в одну папку не должны молча затирать друг
 * друга. */
export function buildKdbxExportFilename(date: Date): string {
  return `cryptodermo-export-${formatTimestampForFilename(date)}.kdbx`;
}
