# cryptodermo

Личный офлайн-менеджер паролей под Windows: Tauri v2 + React 19 + TypeScript на фронте, минимальный Rust-слой только для файловых операций. Одна база - `vault.dat` (PBKDF2-SHA256 + AES-256-GCM), живёт рядом с `.exe`. В сеть приложение ходит ровно в двух местах, оба выключены по умолчанию и запускаются вручную: проверка обновлений (`updateCheck.ts`) и проверка паролей на утечки (`breachCheck.ts`). Данные базы не уходят никуда.

## Команды

| Команда | Что делает |
|---|---|
| `npm install` | Установить зависимости фронта |
| `npm run tauri dev` | Запустить приложение локально (окно + hot reload) |
| `npm run tauri build` | Собрать бандл/`.exe` под Windows x64 |
| `npm run build` | Только фронт: `tsc` + `vite build` в `dist/`, без Tauri-бандла - быстрая проверка типов и сборки |
| `npm test` | Все тесты фронта (`vitest run`) - на момент проверки 17 файлов / 222 теста, зелёные |
| `npx vitest run src/lib/crypto.test.ts` | Один файл тестов (путь - любой `*.test.ts`/`*.test.js` рядом с исходником) |
| `npx tsc --noEmit` | Только проверка типов |
| `cargo check` (в `src-tauri/`) | Быстрая проверка Rust-части без генерации бинарника |
| `cargo test` (в `src-tauri/`) | Тесты Rust-части (сейчас один - атомарность записи при симулированном прерывании) |
| `python aes_gcm_test.py` (в корне) | Векторы FIPS-197 / NIST SP 800-38D для `aes_gcm.py` - 13 тестов |

Rust-тулчейн может не быть в `PATH` напрямую - на этой машине он нашёлся в `~/.cargo/bin` (`rustc 1.97.1`, `cargo 1.97.1`), нужно временно добавить в `PATH`, если `cargo`/`rustc` не находятся.

`npm run tauri build` кладёт результат в `src-tauri/target/release/`: портативный `cryptodermo.exe` (самодостаточный, DLL рядом не нужна - приложение задумано портативным, R29) прямо в `release/`, плюс инсталляторы в `release/bundle/msi/*.msi` и `release/bundle/nsis/*-setup.exe`.

## Структура

```
src/
├── lib/          crypto, vaultFormat, vaultStore, tauriApi, pinLock, settingsConfig,
│                 clipboard, importExport - вся бизнес-логика и крипто, у каждого файла
│                 рядом свой *.test.ts (кроме crossCompat - см. «Тесты»)
├── screens/      LockScreen, List, Editor, Settings - полноэкранные, монтируются из App.tsx
├── components/   AppShell, RecordCard, PasswordGenerator, RecentList, StatusBar/StatusDot,
│                 ImportExportPanel - переиспользуемые куски экранов
├── hooks/        useAutoLock.ts - таймер бездействия + блокировка при сворачивании
├── fonts/        JetBrains Mono (latin/cyrillic-подмножества, woff2) + лицензия
├── tokens.css    единственный источник цветов/отступов/радиусов/переходов
└── App.tsx       сведение экранов (стейт-машина Screen), main.tsx - точка входа React
src-tauri/
├── src/vault_fs.rs        5 Tauri-команд: read_vault, write_vault_atomic, list_backups,
│                          rotate_backups, exe_dir - весь Rust-код проекта, кроме проводки
├── src/lib.rs / main.rs   регистрация команд, точка входа бинарника
├── capabilities/default.json   core:default + dialog:allow-open/allow-save
└── tauri.conf.json        productName, окно, bundle/иконки
emergency-decrypt.py   автономный аварийный дешифратор (Python stdlib, без pip)
aes_gcm.py             AES+GCM с нуля для emergency-decrypt.py (в stdlib Python нет AES)
emergency-decrypt.bat  обёртка над emergency-decrypt.py для тех, кто не хочет открывать консоль
FORMAT.md              спецификация формата vault.dat - независимый парсер пишется по нему
```

## Ключевые файлы

- `src/App.tsx` - стейт-машина экранов (`Screen` = list/editor/settings/importExport), автоблокировка, перехват закрытия окна (`onCloseRequested`), определение стартового `vaultPath`. Трогать при любом новом верхнеуровневом экране или изменении навигации.
- `src/lib/vaultStore.ts` - класс `VaultStore`: модель `Item`, `addItem`/`updateItem`/`deleteItem`/`search`/`save`, ротация бэкапов, защита от уменьшения числа записей (`ItemCountDecreasedError`). Трогать при любом изменении схемы записи - и синхронно обновлять `FORMAT.md` §6.
- `src/lib/crypto.ts` + `src/lib/vaultFormat.ts` - деривация ключа/шифрование (только `crypto.subtle`) и (де)сериализация контейнера `vault.dat`. Меняются редко и только вместе с `FORMAT.md`, `emergency-decrypt.py`, `aes_gcm.py` - иначе `vaultStore.crossCompat.test.js` покраснеет.
- `src/lib/tauriApi.ts` - единственная точка `invoke()` в проекте (проверено грепом - больше нигде `@tauri-apps/api/core` не импортируется). Новую Rust-команду сначала описываешь здесь.
- `src-tauri/src/vault_fs.rs` - реализация команд, регистрируются в `src-tauri/src/lib.rs`.
- `src/lib/pinLock.ts` + `src/lib/settingsConfig.ts` - envelope-шифрование ключа базы PIN-ом и схема `vault.settings.json` (`autoLockTimeoutMs`, `lastVaultPath`, `pin?`, `pinLockout?`, `pinSetupOffered?`).
- `src/screens/{LockScreen,List,Editor,Settings}.tsx` - по одному владельцу на экран, у каждого своя чистая логика вынесена в экспортированные функции + `*.test.ts` рядом.

## Архитектура

Rust (`src-tauri/src/vault_fs.rs`) - только файловый слой: 5 команд, ни шифрования, ни разбора JSON, ни бизнес-логики. Атомарная запись - `write tmp` → `fsync` → `rename` поверх боевого файла; `rename` в пределах одной ФС атомарен на уровне ОС, поэтому прерывание процесса в любой момент до/после не оставляет «половинчатого» файла (проверено автотестом с симуляцией прерывания).

Фронт вызывает Rust только через `src/lib/tauriApi.ts` (типизированные обёртки 1:1 с командами) - остальной код не знает имён команд как строк. Официальные API Tauri (`@tauri-apps/api/window`, `@tauri-apps/plugin-dialog`) используются напрямую там, где нужны (`App.tsx`, `LockScreen.tsx`, `useAutoLock.ts`, `Editor.tsx`, `RecordCard.tsx`, `ImportExportPanel.tsx`) - правило «одна точка входа» касается только кастомных команд `vault_fs`, не официальных плагинов.

Цепочка разблокировки: `LockScreen` (пароль или PIN) → `VaultStore.loadFromBytes` (пароль) / `loadFromBytesWithRawKey` (PIN, через `pinLock.unwrapVaultKeyWithPin`) → `App` держит один экземпляр `VaultStore` в состоянии, пока не сработает `handleLock`. Экраны (`List`/`Editor`/`Settings`/`ImportExportPanel`) мутируют стор синхронно в памяти и сами вызывают `store.save(vaultPath)` - стор ничего не пишет на диск автоматически, кроме как через явный `save()`.

PIN - не альтернативный пароль, а обёртка того же 256-битного ключа (envelope encryption, `pinLock.ts`): реальный ключ передеривается из мастер-пароля через `deriveBits`, шифруется отдельным AES-256-GCM ключом из PIN (своя соль, `PIN_KDF_ITERATIONS = 600_000`), результат живёт в `vault.settings.json`. Смена мастер-пароля инвалидирует PIN-обёртку (её никто явно не чистит, но она шифрует байты старого ключа и просто перестаёт совпадать).

`vault.settings.json` - открытый (не шифруется) JSON рядом с базой, пишется теми же Rust-командами, что и сама база, не участвует в ротации `backups/`.

`emergency-decrypt.py`, `aes_gcm.py` и `emergency-decrypt.bat` копируются в каталог базы и в каждый бэкап при каждом успешном `save()` (`vaultStore.ts`, через Vite `?raw`-импорт исходных файлов из корня репозитория - гарантированно те же байты, что в репозитории, не переписанные вручную копии). Установщик NSIS эти файлы никак не трогает - они не часть бандла, а появляются только через `save()`, при первом же сохранении базы.

`AutoLockController` в `App.tsx` - невидимый компонент, ремонтируется через `key={timeoutMs}`, чтобы форсировать перечитывание таймаута `useAutoLock`-хуком без перезапуска всего приложения (хук читает `autoLockTimeoutMs` один раз при монтировании и не принимает его как живой параметр).

## Соглашения кода

- **Каждый модуль держит свою маленькую копию мелких приватных хелперов** (`dirOf`/`joinPath`, форматирование timestamp, `formatFileSize`) вместо общего экспорта - осознанное решение проекта (закреплено ещё в тикете 02), не забывчивость. Не выносить их в общий `utils.ts` без отдельного запроса.
- **Исключение 2 - `src/lib/quickSearch.ts`** (`MAX_RESULTS`, `NO_PIN_MESSAGE`, `totpField`): общее для окна по хоткею и палитры Ctrl+K, заведено 19.08.2026 при удалении режима `--quick` с согласия пользователя. Раньше эти символы жили в `QuickAccess.tsx`, и оба окна импортировали их из чужого экрана. В `quickBridge.ts` их класть нельзя: тот сознательно не зависит от `totp.ts`.
- **Исключение 1 - `src/lib/base64.ts`** (`base64ToBytes`/`bytesToBase64`): вынесено по прямому запросу пользователя 19.08.2026, когда пара оказалась скопирована в 11 файлов семнадцатью функциями. Новый код должен импортировать оттуда, а не заводить свою копию. Копия в `vaultStore.test.ts` оставлена намеренно - тест не должен зависеть от кода, который проверяет.
- **Один тип ошибки на класс отказа, а не попытка различить причину**: `DecryptError`, `FormatError`, `PinUnlockError` не различают «неверный пароль/PIN» и «повреждённые данные» - AES-GCM сам не даёт это различить на своём уровне, разделение дало бы ложное чувство точности.
- **Именованные константы вместо магических чисел** там, где значение может понадобиться подвинуть: `MAX_BACKUPS`, `MAX_ATTACHMENT_SIZE_BYTES`, `MAX_VAULT_SIZE_BYTES`, `DEFAULT_ITERATIONS`, `PIN_LOCKOUT_MAX_ATTEMPTS`/`PIN_LOCKOUT_DURATION_MS`/`PIN_KDF_ITERATIONS` - все экспортированы из своего модуля.
- **Логика решений вынесена в чистые функции без React/DOM**, компонент - тонкая обвязка поверх них (см. «Тесты» - это прямое следствие отсутствия jsdom). Новый экран или диалог сначала пишется как проверяемая чистая функция, JSX - потом.
- **CSS только через `var(--...)` из `src/tokens.css`** - ни одного хардкод-цвета/отступа в CSS компонентов.
- **Комментарии в коде и сообщения коммитов - по-русски**, идентификаторы/публичные API - по-английски. Это отличается от дефолтного глобального правила «код и комментарии на английском» - в этом проекте так исторически и последовательно, менять не нужно.
- **Новая зависимость - всегда отдельный вопрос пользователю**, не тихая установка (в коде это называется R31) - если кажется, что чего-то не хватает (типов, тестовой библиотеки), это повод спросить, а не `npm install`.

## Окружение

| Переменная | Где используется | Зачем |
|---|---|---|
| `VAULT_PASSWORD` | `emergency-decrypt.py` | Необязательная. Если задана - пароль берётся из неё вместо интерактивного `getpass` (нужно для автотестов/скриптов - так её использует `vaultStore.crossCompat.test.js`). Без неё - обычный интерактивный запрос, ничего не отображается при вводе. |
| `TAURI_DEV_HOST` | `vite.config.ts` | Необязательная, для мобильной разработки Tauri (хост/порт HMR). На обычной десктопной разработке не используется - дефолт `127.0.0.1`. |

## Тесты

Vitest (`vitest run`), конфиг - в `vite.config.ts` (`test.passWithNoTests: true`). Тестовые файлы лежат рядом с исходником (`Foo.ts` → `Foo.test.ts`), запускать один файл - `npx vitest run путь/до/Foo.test.ts`.

**Нет `jsdom`/`@testing-library/react`** - компоненты не монтируются и не рендерятся в тестах. Вся логика принятия решений (валидация форм, переходы состояний, парсинг, криптографические roundtrip'ы) вынесена в обычные экспортированные функции без React/DOM и покрыта тестами напрямую; сама JSX-разметка и живые эффекты (таймеры, подписки на окно) проверяются только чтением кода + `tsc`/`vite build`, не автотестом. Не пытаться добавить `jsdom`/`@testing-library` без отдельного согласования - см. «Соглашения кода».

`src/lib/vaultStore.crossCompat.test.js` - единственный тест-файл на `.js`, не `.ts`, намеренно: он использует `node:child_process`/`node:fs`/`node:os`, а в проекте нет `@types/node` и `tsconfig.json` не включает `allowJs` - так файл невидим для `tsc` (не ломает `npm run build`), но подхватывается дефолтным `test.include` Vitest наравне с `*.test.ts`. Он запускает реальный `python emergency-decrypt.py` на базе, только что созданной `VaultStore`, и сверяет вывод посимвольно - пропускается (`it.skipIf`), если `python` не найден в `PATH`, не падает ложно. На этой машине `python 3.11.9` есть, тест проходит.

`python aes_gcm_test.py` в корне - отдельно от Vitest/`npm test`, официальные векторы FIPS-197/NIST SP 800-38D для `aes_gcm.py`.

## Подводные камни

- **`productName` в `tauri.conf.json` и `[package] name`/`[lib] name` в `Cargo.toml` - два разных механизма.** Имя скомпилированного бинарника (`.exe`/`.dll`) берётся из `Cargo.toml`, не из `tauri.conf.json` - при ребренде Vault → cryptodermo это один раз пропустили: `productName`/заголовок окна/`package.json` переименовали, `Cargo.toml` остался `name = "vault"` - старое имя было видно в Task Manager при живом запуске (коммит `bdfa015`). `identifier` в `tauri.conf.json` (`com.vault.desktop`) осознанно НЕ переименован - невидимый технический ID, трогать не нужно.
- **`[lib] name = "cryptodermo_lib"` в `Cargo.toml`, не просто `"cryptodermo"`** - без суффикса `_lib` имя библиотеки совпадает с именем бинарника, что на Windows конфликтует при сборке (cargo issue #8519). Не убирать суффикс.
- **`vite.config.ts` явно слушает `127.0.0.1`, не `localhost`** - на части машин `localhost` резолвится в IPv6 раньше IPv4, а проверка готовности dev-сервера в `tauri dev` стучится по IPv4; без явного хоста `tauri dev` тихо зависает на «Waiting for your frontend dev server to start». Не убирать `host: host || "127.0.0.1"`.
- **Не пересобирать скаффолд через `create-tauri-app --force` в корне репозитория** - при непустой папке он способен снести `CLAUDE.md`, `.gitignore`.
- **`VaultStore` не может сузить тип приватных nullable-полей через void-метод** (`assertLoaded()` бросает, но TypeScript не сужает поля класса через отдельный вызов) - там, где `key`/`kdfInfo` нужны напрямую без `null` в типе, используется `getLoaded()`, возвращающий уже сужённый объект, а не `assertLoaded()` + прямое обращение к полю.
- **На Windows переименование файла с открытым хендлом ведёт себя не всегда предсказуемо** - `write_temp_and_sync` в `vault_fs.rs` явно оборачивает запись в блок `{ ... }`, чтобы файл гарантированно закрылся (drop) до `std::fs::rename`. Не убирать эту область видимости и не добавлять код, который держит хендл открытым через `rename`.
- **PBKDF2 не нормализует пароль по Unicode** (нет NFC/NFD/NFKC, байты берутся как есть) - сознательное решение ради кросс-платформенной совместимости ключа, подробности и обоснование в `FORMAT.md` §3, не «забытая» нормализация.
- **`onCloseRequested` в `App.tsx` не закрывает окно сам по себе**, вопреки официальному примеру Tauri v2 («если `preventDefault()` не вызван - Tauri закрывает окно после обработчика») - на этой версии `@tauri-apps/api` окно оставалось открытым (закрывалось только через диспетчер задач). Нужен явный `await getCurrentWindow().destroy()` в конце обработчика (не `close()` - тот сам заново эмитирует `close-requested`) + право `core:window:allow-destroy` в `capabilities/default.json` (без него `destroy()` тихо падает по permission). Коммит `2f517c1`.
- **`backgroundColor` в `app.windows[0]` (`tauri.conf.json`)** - без него окно на старте на 200-500мс показывает белый фон ОС, пока WebView не отрисует первый кадр (не только dev - то же в собранном билде). Выставлен в `#0a0c10` (значение `--bg`). Не убирать при правке конфига окна. Коммит `2f517c1`.
- **`src-tauri/target/` - это кэш сборки Rust, не источник правды** (debug+release профили, все зависимости, инкрементальная компиляция) - может разрастись до нескольких ГБ за сессию с частыми пересборками; безопасно удалить целиком (`cargo clean` или `rm -rf`), пересоберётся сама при следующем `cargo build`/`tauri dev`, ничего не теряется. В `.gitignore`, на GitHub не попадает.
