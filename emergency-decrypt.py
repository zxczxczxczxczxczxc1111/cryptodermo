#!/usr/bin/env python3
"""emergency-decrypt.py - аварийный дешифратор базы Vault.

Делает ровно одно: берёт файл vault.dat, спрашивает мастер-пароль,
выводит расшифрованный JSON в stdout. Не импортирует ничего из src/
или src-tauri/ этого репозитория - независимая копия логики модулей
crypto.ts и vaultFormat.ts, написанная заново на Python (R24, R25,
R57 брифа). Если однажды приложение не соберётся или репозиторий
будет потерян - этого файла, `aes_gcm.py` рядом с ним и пароля
достаточно, чтобы прочитать данные. Точное описание формата -
FORMAT.md в корне репозитория, этот скрипт реализует его раздел 7
("Резюме для реализации с нуля") буквально.

Требует лежащий РЯДОМ файл `aes_gcm.py` (тот же каталог) - собственная
реализация AES (FIPS-197) и AES-GCM (NIST SP 800-38D) на чистом Python,
без стороннего пакета и без `pip install`. Оба файла копируются вместе
при каждом сохранении базы (см. `vaultStore.ts`, `save()`) - рядом с
`vault.dat` и в каждую резервную копию.

Почему собственная реализация AES-GCM, а не пакет из pip: условие тикета
запрещает и `pip install` ("только стандартная библиотека"), и написание
СВОЕЙ криптографии (R20, R32 проекта) - но стандартная библиотека Python
не содержит ни одного примитива AES (ни блочного шифра, ни тем более
режима GCM: ни в hashlib, ни в ssl, ни где-либо ещё в stdlib -
проверено). Разрешение этого противоречия, принятое пользователем
16.08.2026: R20/R32 запрещают ИЗОБРЕТАТЬ свою схему/алгоритм шифрования,
а не запрещают реализовать вручную СТАНДАРТНЫЙ, документированный
алгоритм (AES по FIPS-197, GCM по NIST SP 800-38D) - то же самое, что
делает любая библиотека, просто без внешней зависимости. `aes_gcm.py`
реализует эти два опубликованных стандарта дословно, без отклонений и
без собственных "упрощений", и проверен официальными тестовыми
векторами NIST/FIPS-197 (`aes_gcm_test.py`), а не только сверкой с этим
же проектом - см. комментарии в обоих файлах.

Всё в этом скрипте реализовано по-настоящему и работает: чтение файла,
разбор JSON-контейнера, проверка версии формата, деривация ключа
PBKDF2-HMAC-SHA256 (через hashlib.pbkdf2_hmac - это есть в стандартной
библиотеке и работает идентично crypto.subtle.deriveKey из crypto.ts
при тех же password/salt/iterations, потому что PBKDF2-HMAC-SHA256 -
это один и тот же стандартный алгоритм в обеих реализациях, не своя
криптография), и расшифровка тела AES-256-GCM через `aes_gcm.py`.

Пароль передаётся одним из двух способов:
  - переменная окружения VAULT_PASSWORD (удобно для автотестов и
    скриптов - не остаётся в списке процессов ОС, в отличие от
    аргумента командной строки);
  - если переменная не задана - интерактивный запрос через getpass
    (ничего не выводится на экран при вводе).

Использование:
    python emergency-decrypt.py <путь-к-vault.dat>
    python emergency-decrypt.py <путь-к-vault.dat> --unpack-attachments <каталог>

Флаг --unpack-attachments (§18 спецификации) распаковывает
attachments[].data каждой записи в отдельные файлы в указанном
каталоге (по одному файлу на вложение, имя - "<id записи>-<имя
вложения>", во избежание коллизий одинаковых имён файлов в разных
записях). Оба сегмента имени файла (id записи и имя вложения) взяты из
расшифрованного тела базы и очищены от разделителей каталогов/".."
перед записью на диск (см. `_sanitize_path_component`) - без этого
специально сконструированный vault.dat мог бы записать файл за
пределами указанного каталога (path traversal).
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
import sys
from typing import Any

try:
    from aes_gcm import gcm_decrypt, InvalidTagError
except ImportError as _import_error:  # pragma: no cover - тривиальная ветка
    sys.exit(
        "Error: aes_gcm.py not found next to emergency-decrypt.py. Both files "
        "are copied together on every vault save (see vaultStore.ts) - if you "
        "only copied emergency-decrypt.py by hand, copy aes_gcm.py too. "
        f"(import error: {_import_error})"
    )

# Единственная поддерживаемая версия формата контейнера - см. FORMAT.md §2.
# Если она когда-нибудь вырастет, а этот скрипт не обновят вместе с
# форматом - обязательный автотест кросс-совместимости (см. отчёт по
# тикету 05) должен упасть первым, раньше, чем это заметит живой пользователь
# в реальной аварии.
SUPPORTED_FORMAT_VERSION = 1

# Длина производного ключа AES-256 в байтах (256 бит) - см. FORMAT.md §3.
DERIVED_KEY_LENGTH_BYTES = 32

# Длина тега аутентификации AES-GCM в байтах (128 бит, дефолт WebCrypto) -
# см. FORMAT.md §4. Тег дописан в конец `ct` после base64-декодирования, не
# хранится отдельным полем.
GCM_TAG_LENGTH_BYTES = 16


class VaultFormatError(Exception):
    """Файл не является валидным контейнером этого формата - не JSON,
    отсутствует обязательное поле или неизвестная версия `v`. Аналог
    FormatError из vaultFormat.ts."""


class VaultDecryptError(Exception):
    """Пароль неверный или тело контейнера повреждено - AES-GCM не
    различает эти два случая на уровне проверки тега аутентификации, поэтому
    и здесь одна ошибка на оба варианта (см. crypto.ts, DecryptError)."""


def parse_container(raw_bytes: bytes) -> dict[str, Any]:
    """Разобрать байты файла в заголовок + сырые (ещё base64) поля.

    Буквально реализует FORMAT.md §7, шаги 1-2: прочитать как UTF-8 JSON,
    проверить обязательные поля и версию формата. Не пытается угадать
    структуру неизвестной версии - явный отказ вместо тихой порчи данных
    (R07: файл должен либо читаться правильно, либо явно отказывать).
    """
    try:
        text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise VaultFormatError("Invalid vault container: not valid UTF-8 text") from exc

    try:
        container = json.loads(text)
    except json.JSONDecodeError as exc:
        raise VaultFormatError("Invalid vault container: not valid JSON") from exc

    if not isinstance(container, dict):
        raise VaultFormatError("Invalid vault container: expected a JSON object")

    def require_str(obj: dict[str, Any], field: str) -> str:
        value = obj.get(field)
        if not isinstance(value, str):
            raise VaultFormatError(f'Invalid vault container: missing or malformed "{field}" field')
        return value

    def require_num(obj: dict[str, Any], field: str) -> int:
        value = obj.get(field)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise VaultFormatError(f'Invalid vault container: missing or malformed "{field}" field')
        return int(value)

    version = require_num(container, "v")
    if version != SUPPORTED_FORMAT_VERSION:
        raise VaultFormatError(
            f"Unsupported vault format version: {version} "
            f"(this script only supports version {SUPPORTED_FORMAT_VERSION})"
        )

    kdf = container.get("kdf")
    if not isinstance(kdf, dict):
        raise VaultFormatError('Invalid vault container: missing or malformed "kdf" field')
    alg = require_str(kdf, "alg")
    salt_b64 = require_str(kdf, "salt")

    params = kdf.get("params")
    if not isinstance(params, dict):
        raise VaultFormatError('Invalid vault container: missing or malformed "kdf.params" field')
    iterations = require_num(params, "iterations")

    cipher = require_str(container, "cipher")
    iv_b64 = require_str(container, "iv")
    ct_b64 = require_str(container, "ct")

    try:
        ciphertext_and_tag = base64.b64decode(ct_b64, validate=True)
    except (ValueError, base64.binascii.Error) as exc:  # type: ignore[attr-defined]
        raise VaultFormatError('Invalid vault container: malformed base64 in "ct" field') from exc

    return {
        "v": version,
        "kdf_alg": alg,
        "salt_b64": salt_b64,
        "iterations": iterations,
        "cipher": cipher,
        "iv_b64": iv_b64,
        "ciphertext_and_tag": ciphertext_and_tag,
    }


def derive_key(password: str, salt: bytes, iterations: int) -> bytes:
    """PBKDF2-HMAC-SHA256, FORMAT.md §3. Пароль берётся как есть, UTF-8
    байтами - никакой нормализации Unicode и обрезки пробелов, ровно как
    описано в FORMAT.md (важно для совместимости с deriveKey из crypto.ts:
    там пароль тоже кодируется TextEncoder без нормализации).

    `hashlib.pbkdf2_hmac` - часть стандартной библиотеки Python (модуль
    hashlib), не сторонний пакет.
    """
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        iterations,
        dklen=DERIVED_KEY_LENGTH_BYTES,
    )


def aes_256_gcm_decrypt(key: bytes, iv: bytes, ciphertext_and_tag: bytes) -> bytes:
    """Расшифровать тело контейнера AES-256-GCM (FORMAT.md §4) через
    `aes_gcm.py` (см. импорт в начале файла и комментарии там - реализация
    стандарта AES/GCM с нуля на чистом Python, без стороннего пакета).

    Тег дописан в конец `ciphertext_and_tag` (последние 16 байт, 128 бит -
    FORMAT.md §4), а не хранится отдельно - тот же формат, что и на выходе
    `crypto.subtle.encrypt` в crypto.ts. AAD не используется (пустая, как
    и в crypto.ts).
    """
    ciphertext, tag = ciphertext_and_tag[:-GCM_TAG_LENGTH_BYTES], ciphertext_and_tag[-GCM_TAG_LENGTH_BYTES:]
    try:
        return gcm_decrypt(key, iv, ciphertext, tag, aad=b"")
    except InvalidTagError as exc:
        raise VaultDecryptError("Decryption failed: wrong password or corrupted data") from exc


def decrypt_vault(container: dict[str, Any], password: str) -> list[Any]:
    """Полный путь: контейнер + пароль -> список записей Item[]
    (FORMAT.md §7, шаги 3-6)."""
    if container["kdf_alg"] != "PBKDF2-SHA256":
        raise VaultFormatError(f"Unsupported kdf.alg: {container['kdf_alg']}")
    if container["cipher"] != "AES-256-GCM":
        raise VaultFormatError(f"Unsupported cipher: {container['cipher']}")

    salt = base64.b64decode(container["salt_b64"], validate=True)
    iv = base64.b64decode(container["iv_b64"], validate=True)
    key = derive_key(password, salt, container["iterations"])

    # aes_256_gcm_decrypt поднимает свою VaultDecryptError сама (тег не
    # совпал - неверный пароль или битые данные); ничего дополнительно
    # оборачивать здесь не нужно.
    plaintext = aes_256_gcm_decrypt(key, iv, container["ciphertext_and_tag"])

    try:
        body = json.loads(plaintext.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VaultFormatError("Vault body is not valid JSON after decryption") from exc

    if not isinstance(body, list):
        raise VaultFormatError("Vault body must be a JSON array of items")

    return body


def _sanitize_path_component(value: Any) -> str:
    """Обезвредить один сегмент имени файла перед склейкой в путь (находка
    ревью тикета 05 - interfaces.md, "Из таска 05"): `unpack_attachments`
    ниже строит `safe_name = f"{item_id}-{name}"` из ДВУХ значений, оба
    взятые из расшифрованного тела базы - т.е. из данных пользователя, не
    доверенных слепо, даже если для того, чтобы вообще дойти до этого кода,
    уже нужен верный мастер-пароль (низкий, но не нулевой риск: например,
    вручную отредактированный или специально сконструированный vault.dat).
    Имя переменной "safe_name" в исходном коде было МАСКОЙ, а не защитой -
    ни `item_id`, ни `name` не проверялись перед `os.path.join`, так что
    значение вида "../../evil" в любом из них позволяло записать файл за
    пределами `out_dir`.

    Возвращает только последний сегмент пути, без разделителей каталогов и
    без `:`. Проверяются ОБА разделителя (`/` и `\\`) вручную, не
    `os.path.basename` сама по себе - `os.path.basename` на POSIX не
    считает `\\` разделителем, а этот скрипт обязан одинаково защищать
    вложения независимо от того, на какой ОС была создана база и на какой
    ОС сейчас запущен сам скрипт (тот же принцип, что `dirOf()`/
    `joinPath()` в `vaultStore.ts` - "понимает и /, и \\"). `..`/`.`/пустая
    строка (валидные, но опасные сами по себе имена - ссылки на
    родительский/текущий каталог) заменяются на "unnamed".

    `:` вычищается отдельно (не просто "ещё один запрещённый символ похожей
    формы") - находка второго раунда ревью: на NTFS `:` внутри сегмента
    имени файла - синтаксис Alternate Data Streams (`имя:поток`), а не
    directory traversal (за пределы `out_dir` `имя:поток` не выходит, `os.
    path.join`/`open()` создают его КАК ЧАСТЬ файла `имя` внутри `out_dir`,
    просто в скрытом потоке). Реально проверено (не гипотеза): вложение с
    `name = "evil:hidden_stream.txt"` до этой правки создавало на диске
    файл `out_dir/<id>-evil` со скрытым потоком `hidden_stream.txt`,
    читаемым через `Get-Item -Stream *`/`Get-Content -Stream` - тот же
    класс риска (запись куда пользователь не ожидал через несанитизированное
    имя), из-за которого эта функция вообще появилась (проект целится в
    Windows, R36), поэтому `:` заменяется на `_`, а не удаляется молча -
    так `evil:hidden.txt` становится `evil_hidden.txt`, читаемым обычным
    файлом, а не растворяется в соседнем сегменте.
    """
    text = value if isinstance(value, str) else str(value)
    candidate = text.replace("\\", "/").split("/")[-1].replace(":", "_")
    if candidate in ("", ".", ".."):
        candidate = "unnamed"
    return candidate


def unpack_attachments(items: list[Any], out_dir: str) -> list[str]:
    """§18: распаковать attachments[].data (base64) каждой записи в
    отдельные файлы в out_dir. Имя файла - "<id записи>-<имя вложения>",
    чтобы одинаковые имена файлов в разных записях не затирали друг друга -
    оба сегмента пропущены через `_sanitize_path_component` (см. выше)
    перед склейкой пути, иначе ".."/"/"/"\\" в любом из них позволили бы
    записать файл за пределами out_dir (path traversal, находка ревью
    тикета 05). Возвращает список путей записанных файлов (для итогового
    сообщения пользователю).
    """
    os.makedirs(out_dir, exist_ok=True)
    written: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        item_id = _sanitize_path_component(item.get("id", "unknown"))
        for attachment in item.get("attachments", []) or []:
            if not isinstance(attachment, dict):
                continue
            name = _sanitize_path_component(attachment.get("name", "unnamed"))
            data_b64 = attachment.get("data", "")
            safe_name = f"{item_id}-{name}"
            out_path = os.path.join(out_dir, safe_name)
            with open(out_path, "wb") as f:
                f.write(base64.b64decode(data_b64))
            written.append(out_path)
    return written


def read_password() -> str:
    """Взять пароль из VAULT_PASSWORD, если задана (автотесты/скрипты), иначе
    спросить интерактивно через getpass (ничего не выводится на экране)."""
    env_password = os.environ.get("VAULT_PASSWORD")
    if env_password is not None:
        return env_password
    return getpass.getpass("Master password: ")


def main(argv: list[str] | None = None) -> int:
    # Записи могут содержать любой Unicode-текст (заголовки, теги, заметки -
    # ничего не ограничено ASCII), а `json.dumps(..., ensure_ascii=False)`
    # ниже печатает его буквально, не экранируя `\uXXXX`. На Windows поток
    # stdout по умолчанию использует кодовую страницу консоли (например,
    # cp1252), которая НЕ покрывает произвольный Unicode (кириллицу и
    # многое другое) - без явной перенастройки печать такого текста падает
    # с UnicodeEncodeError на реальных данных, а не только в теории.
    # `reconfigure` - метод Python 3.7+, доступен всегда (без стороннего
    # пакета) для текстовых потоков.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description="Emergency decryptor for Vault's vault.dat - reads the file, "
        "asks for the master password, prints decrypted JSON to stdout.",
    )
    parser.add_argument("path", help="Path to vault.dat (or to a backup file in backups/)")
    parser.add_argument(
        "--unpack-attachments",
        metavar="DIR",
        help="Also decode attachments[].data of every item into files in this directory",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.path, "rb") as f:
            raw_bytes = f.read()
    except OSError as exc:
        print(f"Error: could not read {args.path}: {exc}", file=sys.stderr)
        return 1

    try:
        container = parse_container(raw_bytes)
    except VaultFormatError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    password = read_password()

    try:
        items = decrypt_vault(container, password)
    except (VaultFormatError, VaultDecryptError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(items, ensure_ascii=False, indent=2))

    if args.unpack_attachments:
        written = unpack_attachments(items, args.unpack_attachments)
        print(f"Unpacked {len(written)} attachment(s) into {args.unpack_attachments}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
