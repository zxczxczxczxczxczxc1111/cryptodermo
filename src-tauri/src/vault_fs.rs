// Файловый слой приложения: ровно пять Tauri-команд, которые умеет
// вызывать фронтенд (JS/TS) через `invoke()`. Больше в Rust-части ничего нет
// и не должно появляться - вся остальная логика (шифрование, формат файла,
// модель данных) живёт в TypeScript, потому что WebCrypto прекрасно работает
// прямо в WebView и не нуждается в Rust.
//
// Если вы не пишете на Rust каждый день: этот файл читается сверху вниз как
// обычный код - `Result<T, E>` здесь означает "либо успех со значением T,
// либо ошибка E", это способ Rust сказать "операция может провалиться, и
// вызывающий код обязан это учесть" (в отличие от исключений в JS/Python).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Единая ошибка файлового слоя. Файловые операции (`std::io::Error`)
/// преобразуются в `VaultFsError` бесплатно через `#[from]` и оператор `?`
/// (см. функции ниже). Второй вариант - `write_vault_atomic` получает байты
/// базы как base64-строку (см. её комментарий), и эта строка может оказаться
/// битой (не от пользователя - от самого приложения, но лучше явная ошибка,
/// чем незаметно испорченные данные, см. R07).
#[derive(Debug, thiserror::Error)]
pub enum VaultFsError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("invalid base64 in write_vault_atomic bytes argument: {0}")]
    InvalidBase64(String),
}

// Tauri по умолчанию не умеет отдавать `std::io::Error` в JS как читаемый
// текст - без ручной реализации `Serialize` на стороне JS пришёл бы либо
// "[object Object]", либо ошибка сериализации. Реализуем `Serialize` вручную
// и отдаём просто текст ошибки: у нас один вариант ошибки, усложнять до
// структуры {kind, message}, как в примере из документации Tauri v2, пока
// незачем - это можно добавить позже, если у ошибок появятся разные виды,
// которые UI должен различать.
impl Serialize for VaultFsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Описание одного файла резервной копии - то, что отдаёт `list_backups`.
/// Дата в виде миллисекунд от Unix-эпохи (`modified_at_ms`), а не готовой
/// строки: форматирование в читаемую дату - задача UI (`new Date(ms)` на
/// стороне JS), это избавляет Rust-часть от лишней зависимости на форматирование
/// дат ради одной строки.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// Полный путь к файлу.
    pub path: String,
    /// Имя файла без каталога - удобно показывать в списке в UI.
    pub filename: String,
    /// Размер файла в байтах.
    pub size: u64,
    /// Время последнего изменения файла, миллисекунды от Unix-эпохи (UTC).
    pub modified_at_ms: u64,
}

/// Значение одного символа стандартного алфавита base64 (RFC 4648 §4, тот
/// же, что уже используют `btoa`/`atob` на стороне JS в `vaultFormat.ts` и
/// других модулях - не URL-safe вариант). `None` - символ не из алфавита (и
/// не паддинг `=`, тот обрабатывается отдельно в `base64_decode`).
fn base64_char_value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Декодировать base64-строку в байты. Ручная реализация вместо Cargo-крейта
/// (R31 - новая зависимость отдельным вопросом пользователю) - тот же
/// принцип, что уже применён к `aes_gcm.py`: стандартный, опубликованный
/// алгоритм (RFC 4648), реализованный дословно, не изобретённая своя схема.
///
/// `write_vault_atomic` получает от JS байты базы этой строкой (см. её
/// комментарий и комментарий в `tauriApi.ts`) - альтернатива JSON-массиву из
/// потенциально миллионов отдельных чисел.
fn base64_decode(input: &str) -> Result<Vec<u8>, VaultFsError> {
    let bytes = input.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err(VaultFsError::InvalidBase64(format!(
            "length {} is not a multiple of 4",
            bytes.len()
        )));
    }

    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (chunk_index, chunk) in bytes.chunks(4).enumerate() {
        // '=' допустим только в последних одной-двух позициях последней
        // четвёрки символов - как и требует RFC 4648. Проверяем позицию
        // паддинга явно, а не просто считаем количество `=`, чтобы битая
        // строка вида "A=AA" не декодировалась молча во что-то произвольное.
        let is_last_chunk = chunk_index == bytes.len() / 4 - 1;
        let mut values = [0u8; 4];
        let mut pad_count = 0u8;
        // Как только внутри четвёрки встретился паддинг, все оставшиеся
        // символы этой же четвёрки обязаны быть паддингом тоже - строка вида
        // "AB=A" (данные ПОСЛЕ паддинга) невалидна, а не тихо декодируется.
        let mut seen_pad = false;
        for (i, &b) in chunk.iter().enumerate() {
            if b == b'=' {
                if !is_last_chunk || i < 2 {
                    return Err(VaultFsError::InvalidBase64(
                        "'=' padding only allowed at the end of the last group, after at least 2 data characters".to_string(),
                    ));
                }
                seen_pad = true;
                pad_count += 1;
                values[i] = 0;
            } else if seen_pad {
                return Err(VaultFsError::InvalidBase64(
                    "data character found after '=' padding".to_string(),
                ));
            } else {
                values[i] = base64_char_value(b).ok_or_else(|| {
                    VaultFsError::InvalidBase64(format!("unexpected character {:?}", b as char))
                })?;
            }
        }

        let n = (values[0] as u32) << 18
            | (values[1] as u32) << 12
            | (values[2] as u32) << 6
            | (values[3] as u32);
        out.push((n >> 16) as u8);
        if pad_count < 2 {
            out.push((n >> 8) as u8);
        }
        if pad_count < 1 {
            out.push(n as u8);
        }
    }

    Ok(out)
}

/// Путь к временному файлу для атомарной записи: `<целевой файл>.tmp`.
/// Ровно то, что описано в брифе ("пишем vault.dat.tmp") - фиксированное имя,
/// не случайное: если предыдущая запись была прервана и `.tmp`-файл остался
/// на диске, следующая попытка сохранения его просто перезапишет.
fn tmp_path_for(target_path: &Path) -> PathBuf {
    let mut tmp = target_path.as_os_str().to_owned();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

/// Первая половина атомарной записи: пишет байты во временный файл рядом с
/// целевым и принудительно сбрасывает их на диск (`sync_all` - это и есть
/// fsync). Вынесена в отдельную функцию из двух соображений:
/// 1. её же использует автотест ниже, чтобы честно остановиться ровно в
///    точке "процесс прерван между записью tmp-файла и переименованием", не
///    вызывая rename;
/// 2. `write_vault_atomic` от этого не усложняется - просто "записать tmp,
///    переименовать".
fn write_temp_and_sync(target_path: &Path, bytes: &[u8]) -> Result<PathBuf, VaultFsError> {
    // Каталога назначения может ещё не быть на диске - например, самая
    // первая запись `backups/vault-<дата>.dat` при том, что каталог
    // `backups/` ещё никогда не создавался. Отдельной Rust-команды "создать
    // каталог" в проекте нет и не будет (их ровно четыре), поэтому
    // create_dir_all здесь - единственное место, где каталог для базы и её
    // бэкапов вообще может появиться. `create_dir_all` не ошибается, если
    // каталог уже существует.
    if let Some(parent) = target_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp_path = tmp_path_for(target_path);
    {
        // Блок `{ ... }` нужен, чтобы `file` гарантированно закрылся (drop)
        // до того, как мы попробуем переименовать файл ниже. На Windows
        // переименование файла с открытым хендлом иногда ведёт себя не так,
        // как ожидается, поэтому явно закрываем файл первым делом.
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    Ok(tmp_path)
}

/// Команда: прочитать базу целиком как сырые байты. Расшифровкой и разбором
/// JSON занимается TypeScript (`vault-format`, `crypto`) - Rust просто читает
/// файл с диска, ему не нужно (и не должно) знать про формат содержимого.
///
/// Возвращает `tauri::ipc::Response` - настоящий бинарный ответ IPC вместо
/// обычной сериализации `Vec<u8>` в JSON-массив чисел (19.08.2026, найдено
/// внешним ревью: на базе, раздутой вложениями, это были бы миллионы
/// отдельных чисел в тексте). На стороне JS `invoke()` в этом случае
/// резолвится `ArrayBuffer` - см. `readVault` в `tauriApi.ts`.
#[tauri::command]
pub fn read_vault(path: String) -> Result<tauri::ipc::Response, VaultFsError> {
    let bytes = std::fs::read(&path)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Команда: атомарно записать байты в целевой файл.
///
/// Порядок ровно такой, как в брифе: записать во временный файл рядом с
/// целевым -> сбросить на диск (fsync) -> переименовать временный файл поверх
/// боевого (`std::fs::rename`). Прямой записи в целевой путь здесь нет и не
/// может появиться - единственный способ изменить содержимое `target_path` в
/// этой функции - переименование.
///
/// Почему это безопасно при сбое посреди работы: `std::fs::rename` в пределах
/// одной файловой системы - атомарная операция на уровне ОС (на Windows это
/// `MoveFileExW` с заменой существующего файла). Она либо происходит целиком,
/// либо не происходит вовсе - не может произойти "наполовину". Значит,
/// какая бы точка ни оказалась последней перед тем, как процесс убьют:
/// - если это точка ДО переименования (например, запись tmp-файла или fsync
///   не успели закончиться) - `target_path` вообще не тронут, там всё ещё
///   старая версия целиком;
/// - если переименование уже случилось - на диске уже новая версия целиком.
/// Смешанного, "наполовину записанного" состояния целевого файла быть не
/// может. Это же свойство проверяет автотест `write_vault_atomic_*` ниже.
///
/// `bytes` приходит base64-строкой, не JSON-массивом чисел (19.08.2026, тот
/// же повод, что у `read_vault` выше) - декодируется вручную `base64_decode`
/// перед записью. Подробное обоснование, почему не "сырой" IPC-путь Tauri
/// (потребовал бы передавать `path` через HTTP-заголовок, а значения
/// заголовков ограничены ASCII - путь с кириллицей его бы сломал), - в
/// комментарии `writeVaultAtomic` в `tauriApi.ts`.
#[tauri::command]
pub fn write_vault_atomic(path: String, bytes: String) -> Result<(), VaultFsError> {
    let bytes = base64_decode(&bytes)?;
    let target_path = Path::new(&path);
    let tmp_path = write_temp_and_sync(target_path, &bytes)?;
    std::fs::rename(&tmp_path, target_path)?;
    Ok(())
}

/// Общий обход каталога: путь и метаданные каждого ФАЙЛА внутри `dir_path`
/// (вложенные каталоги пропускаются). Если каталога ещё нет на диске -
/// пустой список, а не ошибка: это нормальная ситуация до первого сохранения
/// (например, самый первый запуск приложения, `backups/` ещё не создавался).
///
/// И `list_backups`, и `rotate_backups` начинают с одного и того же шага
/// "список файлов с метаданными в каталоге" и дальше просто по-разному
/// используют результат (одна показывает его в UI, другая сортирует и
/// удаляет лишнее) - поэтому сам обход вынесен сюда, чтобы не дублировать
/// одинаковый цикл `read_dir` + `entry?` + `metadata()?` + пропуск не-файлов
/// в двух местах.
fn read_dir_files(dir_path: &Path) -> Result<Vec<(PathBuf, std::fs::Metadata)>, VaultFsError> {
    if !dir_path.exists() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    for entry in std::fs::read_dir(dir_path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            // Пропускаем вложенные каталоги, если такие когда-нибудь
            // появятся - и список бэкапов, и ротация должны видеть только
            // файлы.
            continue;
        }
        result.push((entry.path(), metadata));
    }
    Ok(result)
}

/// Команда: список файлов в каталоге бэкапов с их размером и датой
/// изменения. Не заглядывает внутрь файлов и не фильтрует по имени - каталог
/// может содержать не только `vault-<дата>.dat`, но и, например, копию
/// `emergency-decrypt.py` (см. спецификацию §5); команда общего назначения,
/// как и остальные три, и переиспользуется в том числе для каталога с
/// `vault.settings.json`.
#[tauri::command]
pub fn list_backups(dir: String) -> Result<Vec<BackupInfo>, VaultFsError> {
    let dir_path = Path::new(&dir);
    let mut result = Vec::new();
    for (path, metadata) in read_dir_files(dir_path)? {
        let modified_at_ms = metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        result.push(BackupInfo {
            filename: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            size: metadata.len(),
            modified_at_ms,
        });
    }
    Ok(result)
}

/// Команда: оставить в каталоге только `keep_n` самых свежих файлов (по дате
/// изменения), остальные удалить.
///
/// Если удалить лишний старый файл не получилось (например, он занят другим
/// процессом) - это НЕ должно проваливать всю операцию. По приоритетам
/// проекта важнее всего "данные не теряются": отказ сохранить новую версию
/// базы из-за того, что не удалился старый бэкап, нарушает этот приоритет,
/// а лишний старый бэкап, оставшийся на диске чуть дольше, - нет. Поэтому
/// такие ошибки только логируются (`eprintln!`) и не прерывают цикл.
#[tauri::command]
pub fn rotate_backups(dir: String, keep_n: u32) -> Result<(), VaultFsError> {
    let dir_path = Path::new(&dir);
    let mut files: Vec<(PathBuf, SystemTime)> = Vec::new();
    for (path, metadata) in read_dir_files(dir_path)? {
        files.push((path, metadata.modified()?));
    }

    // Сортируем от самых новых к самым старым.
    files.sort_by(|a, b| b.1.cmp(&a.1));

    let keep_n = keep_n as usize;
    if files.len() <= keep_n {
        return Ok(()); // и так укладываемся в лимит
    }

    for (path, _modified) in files.into_iter().skip(keep_n) {
        if let Err(err) = std::fs::remove_file(&path) {
            eprintln!(
                "rotate_backups: не удалось удалить старый бэкап {}: {}",
                path.display(),
                err
            );
        }
    }

    Ok(())
}

/// Команда: каталог, в котором лежит исполняемый файл приложения. Нужен как
/// путь по умолчанию к `vault.dat` при самом первом запуске - когда
/// `vault.settings.json` ещё не существует и `lastVaultPath` неизвестен. По
/// R29 ("приложение и база живут рядом, никакого раскидывания по AppData без
/// явного согласия") это должен быть каталог рядом с `.exe`, а не системная
/// папка профиля.
///
/// `executableDir()` из `@tauri-apps/api/path` на Windows явно не
/// поддерживается (проверено по документации Tauri v2) - единственный
/// надёжный способ получить каталог `.exe` на Windows - `std::env::current_exe()`
/// на стороне Rust, как и показано в примере из официальной документации
/// Tauri.
/// Запущено ли приложение в режиме быстрого доступа.
///
/// Ярлык быстрого доступа передаёт `--quick`, и по этому флагу фронт решает,
/// показывать обычное окно или маленькое окошко поиска. Читать аргументы
/// приходится на стороне Rust: в webview их нет, а тащить ради одного флага
/// отдельный плагин командной строки незачем.
///
/// Сравнение точное, без префиксов: любой другой аргумент (их приложению
/// никто не передаёт) должен вести к обычному запуску, а не к неожиданному
/// режиму.
#[tauri::command]
pub fn quick_mode() -> bool {
    std::env::args().any(|arg| arg == "--quick")
}

#[tauri::command]
pub fn exe_dir() -> Result<String, VaultFsError> {
    let exe_path = std::env::current_exe()?;
    // `parent()` возвращает `None`, только если путь состоит из одного
    // корневого компонента без каталога (для пути к исполняемому файлу это
    // практически невозможно) - но `Option` есть в сигнатуре std, значит
    // случай нужно явно обработать, а не разворачивать `unwrap()`.
    let parent = exe_path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "у пути исполняемого файла нет родительского каталога",
        )
    })?;
    Ok(parent.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Уникальный временный каталог для одного теста - `cargo test` по
    /// умолчанию гоняет тесты параллельно в разных потоках одного процесса,
    /// поэтому нельзя использовать один и тот же путь на диске для всех
    /// тестов сразу. Уникальность берём из времени в наносекундах - для
    /// одного тестового процесса этого достаточно.
    fn unique_test_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("vault_fs_test_{label}_{nanos}"));
        std::fs::create_dir_all(&dir).expect("не удалось создать временный каталог для теста");
        dir
    }

    /// Тот же алфавит, что и у `base64_char_value` в продакшен-коде выше -
    /// нужен здесь отдельной константой, потому что кодировщик (в отличие от
    /// декодера) есть только у тестов, см. `base64_encode` ниже.
    const BASE64_ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    /// Кодировщик base64, нужен только тестам - `write_vault_atomic` теперь
    /// принимает байты этой строкой (см. её комментарий), а не `Vec<u8>`
    /// напрямую, и тестам нужно как-то её получить. Продакшен-коду кодировщик
    /// не нужен: JS-сторона кодирует сама (`bytesToBase64` в `tauriApi.ts`),
    /// Rust только декодирует.
    fn base64_encode(input: &[u8]) -> String {
        let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
        for chunk in input.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = *chunk.get(1).unwrap_or(&0) as u32;
            let b2 = *chunk.get(2).unwrap_or(&0) as u32;
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(BASE64_ALPHABET[((n >> 18) & 0x3F) as usize] as char);
            out.push(BASE64_ALPHABET[((n >> 12) & 0x3F) as usize] as char);
            out.push(if chunk.len() > 1 {
                BASE64_ALPHABET[((n >> 6) & 0x3F) as usize] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                BASE64_ALPHABET[(n & 0x3F) as usize] as char
            } else {
                '='
            });
        }
        out
    }

    #[test]
    fn base64_roundtrip_matches_original_bytes_for_various_lengths() {
        // 0, 1, 2, 3 байта - три случая паддинга (0/2/1 знаков `=`) плюс
        // пустая строка, и один случай побольше без паддинга вовсе.
        for len in [0usize, 1, 2, 3, 4, 5, 6, 300] {
            let input: Vec<u8> = (0..len as u32).map(|i| (i % 256) as u8).collect();
            let encoded = base64_encode(&input);
            let decoded = base64_decode(&encoded).expect("валидная base64-строка должна декодироваться");
            assert_eq!(decoded, input, "round-trip разошёлся для длины {len}");
        }
    }

    #[test]
    fn base64_decode_rejects_malformed_input() {
        assert!(base64_decode("A").is_err(), "длина не кратна 4");
        assert!(base64_decode("AB=A").is_err(), "данные после паддинга внутри группы");
        assert!(base64_decode("A=AA").is_err(), "паддинг не на последних позициях группы");
        assert!(base64_decode("AAA!").is_err(), "символ не из алфавита base64");
    }

    /// Главный автотест этого модуля: атомарная запись не оставляет "битую
    /// половину" файла, что бы ни случилось между записью tmp-файла и
    /// переименованием.
    ///
    /// Реальный "убить процесс точно между двумя системными вызовами" в
    /// рамках одного `cargo test` не воспроизвести детерминированно - момент
    /// SIGKILL/TerminateProcess нельзя прицельно поймать между двумя
    /// конкретными строками кода без гонки по времени, а флаковый тест хуже
    /// отсутствующего. Вместо этого тест честно вызывает ту же самую функцию
    /// `write_temp_and_sync`, которую использует `write_vault_atomic`
    /// изнутри, и НЕ вызывает переименование - для файловой системы это
    /// неотличимо от процесса, прерванного ровно в этой точке: `rename`
    /// либо был вызван, либо нет, и результат на диске зависит только от
    /// этого факта, а не от способа, которым процесс остановился.
    #[test]
    fn write_vault_atomic_never_leaves_corrupted_file_on_interruption() {
        let dir = unique_test_dir("atomic");
        let target = dir.join("vault.dat");

        // На диске уже лежит "старая" версия базы.
        std::fs::write(&target, b"old-content-v1").expect("setup: запись старой версии");

        // Симулируем прерывание процесса ПОСЛЕ записи+fsync tmp-файла, но ДО
        // переименования - вызываем только первый шаг.
        let new_bytes = b"new-content-v2-longer-than-old".to_vec();
        let tmp_path = write_temp_and_sync(&target, &new_bytes)
            .expect("запись во временный файл должна пройти успешно");
        assert!(tmp_path.exists(), "временный файл должен существовать");

        // Инвариант живучести: боевой файл на диске остался СТАРЫМ и ЦЕЛЫМ,
        // потому что rename ещё не произошёл.
        let after_interruption =
            std::fs::read(&target).expect("боевой файл должен читаться и после прерывания");
        assert_eq!(
            after_interruption, b"old-content-v1",
            "прерванная запись не должна портить или подменять боевой файл"
        );

        // Теперь выполняем ту же операцию целиком через публичную команду -
        // без прерывания. Байты идут base64-строкой - см. комментарий у
        // `write_vault_atomic`.
        write_vault_atomic(target.to_string_lossy().into_owned(), base64_encode(&new_bytes))
            .expect("полная атомарная запись должна пройти успешно");

        let after_full_write =
            std::fs::read(&target).expect("боевой файл должен читаться после записи");
        assert_eq!(
            after_full_write, new_bytes,
            "после завершённой записи боевой файл должен содержать новые данные целиком, без смешения со старыми"
        );

        // rename забрал имя tmp-файла себе - отдельного tmp-файла на диске
        // остаться не должно.
        assert!(
            !tmp_path.exists(),
            "временный файл должен исчезнуть после переименования"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
