"""emergency_decrypt_attachments_test.py - regression test for the
path-traversal fix in emergency-decrypt.py's `unpack_attachments` (found in
ticket 05's review, closed in ticket 11: `attachments[].name` and the
item's `id` are untrusted data read from inside the encrypted vault body -
they were being concatenated straight into a filesystem path without
stripping directory separators / ".." segments first).

Tests emergency-decrypt.py through its actual public interface - the CLI
(see interfaces.md's "Выставляет" column for this module: "CLI: путь к
файлу -> пароль -> JSON на stdout; опциональный флаг - распаковать
attachments[].data в файлы рядом") - via a real subprocess, the same style
already established by vaultStore.crossCompat.test.js for the JS<->Python
seam. Not by importing private functions: emergency-decrypt.py's filename
has a hyphen, so it isn't import-able as a normal Python module anyway, and
its documented contract is the CLI, not any particular internal function
name.

Run: `python emergency_decrypt_attachments_test.py` (stdlib unittest, no
pip install - same rule as the rest of this project's Python code, see
aes_gcm_test.py).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

from aes_gcm import gcm_encrypt

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
ITERATIONS = 1000  # быстро для теста - это не про стойкость пароля здесь
PASSWORD = "test password for the attachment unpack test"


def build_vault_bytes(items: list) -> bytes:
    """Собрать валидный контейнер vault.dat (FORMAT.md) с заданными
    `items` в теле - независимая от emergency-decrypt.py реализация
    шифрующей стороны (то же самое, что делает `VaultStore.toBytes()` в
    vaultStore.ts), написанная прямо здесь на Python через `aes_gcm.py`,
    чтобы этот тест не зависел от Node/Vitest."""
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac("sha256", PASSWORD.encode("utf-8"), salt, ITERATIONS, dklen=32)
    iv = os.urandom(12)
    plaintext = json.dumps(items).encode("utf-8")
    ciphertext, tag = gcm_encrypt(key, iv, plaintext)
    container = {
        "v": 1,
        "kdf": {
            "alg": "PBKDF2-SHA256",
            "params": {"iterations": ITERATIONS},
            "salt": base64.b64encode(salt).decode("ascii"),
        },
        "cipher": "AES-256-GCM",
        "iv": base64.b64encode(iv).decode("ascii"),
        "ct": base64.b64encode(ciphertext + tag).decode("ascii"),
    }
    return json.dumps(container).encode("utf-8")


def run_unpack(vault_path: str, out_dir: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "VAULT_PASSWORD": PASSWORD}
    return subprocess.run(
        [sys.executable, "emergency-decrypt.py", vault_path, "--unpack-attachments", out_dir],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )


class UnpackAttachmentsSanitizationTest(unittest.TestCase):
    """R44/§18, находка ревью тикета 05: `name`/`id записи` не
    санитизировались перед `os.path.join` - значение вида "../../evil"
    позволяло записать файл за пределами каталога, указанного
    `--unpack-attachments`."""

    def test_malicious_attachment_name_does_not_escape_output_directory(self):
        secret_content = b"should never leave the output directory"
        item = {
            "id": "item-1",
            "attachments": [
                {
                    "id": "att-1",
                    # Три уровня "../", не два: unpack_attachments склеивает
                    # "{item_id}-{name}" БЕЗ разделителя пути между ними, так
                    # что первый сегмент name ("..") сливается с хвостом
                    # item_id в один нечистый сегмент "item-1-.." - тот
                    # сегмент не равен ".." буквально и потому не считается
                    # "подняться на уровень" сам по себе, съедая один уровень
                    # у атаки. Проверено вручную на нарочно невосстановленной
                    # версии функции: с двумя уровнями путь "случайно"
                    # схлопывался обратно ровно в out_dir (ложноотрицательный
                    # тест), с тремя - реально уходит на уровень выше out_dir.
                    "name": "../../../evil.txt",
                    "mimeType": "text/plain",
                    "size": len(secret_content),
                    "data": base64.b64encode(secret_content).decode("ascii"),
                }
            ],
        }
        vault_bytes = build_vault_bytes([item])

        with tempfile.TemporaryDirectory() as tmp:
            vault_path = os.path.join(tmp, "vault.dat")
            with open(vault_path, "wb") as f:
                f.write(vault_bytes)

            # out_dir - вложенный подкаталог (два уровня внутри tmp), чтобы
            # реальный уход на уровень выше out_dir (см. комментарий у
            # "name" выше) остался внутри контролируемого tmp, но всё ещё
            # ЗА ПРЕДЕЛАМИ out_dir - сильная проверка, не только "не попал в
            # out_dir", а "не попал вообще никуда за пределами ожидаемого"
            # внутри всего временного дерева.
            out_dir = os.path.join(tmp, "unpack", "target")
            os.makedirs(out_dir, exist_ok=True)

            result = run_unpack(vault_path, out_dir)
            self.assertEqual(result.returncode, 0, msg=result.stderr)

            escaped_path = os.path.join(tmp, "evil.txt")
            self.assertFalse(os.path.exists(escaped_path))

            # Внутри всего временного каталога не должно быть НИ ОДНОГО
            # файла "evil.txt" за пределами out_dir - если бы санитайзинг
            # подменял только часть строки, а не весь опасный сегмент, эта
            # более широкая проверка всё равно поймала бы утечку.
            for root, _dirs, files in os.walk(tmp):
                if root == out_dir:
                    continue
                self.assertNotIn(
                    "evil.txt",
                    files,
                    msg=f"attachment escaped the output directory into {root}",
                )

            # А внутри out_dir должен появиться РОВНО один файл, с тем же
            # содержимым, что и исходное вложение - санитайзинг обязан
            # обезвредить путь, не тихо потерять данные.
            written = os.listdir(out_dir)
            self.assertEqual(len(written), 1, msg=f"unexpected files: {written}")
            with open(os.path.join(out_dir, written[0]), "rb") as f:
                self.assertEqual(f.read(), secret_content)

    def test_malicious_item_id_does_not_escape_output_directory(self):
        # То же самое, но вредоносный сегмент - в id записи, не в имени
        # вложения: unpack_attachments склеивает "{item_id}-{name}" в ОДНУ
        # строку до единственного os.path.join, так что разделители в
        # item_id способны выйти за пределы out_dir точно так же, как и в
        # name - проверяется отдельно, чтобы не полагаться на то, что фикс
        # имени неявно закрывает и эту дыру.
        secret_content = b"item id traversal payload"
        item = {
            "id": "../../evil-id",
            "attachments": [
                {
                    "id": "att-1",
                    "name": "innocent.txt",
                    "mimeType": "text/plain",
                    "size": len(secret_content),
                    "data": base64.b64encode(secret_content).decode("ascii"),
                }
            ],
        }
        vault_bytes = build_vault_bytes([item])

        with tempfile.TemporaryDirectory() as tmp:
            vault_path = os.path.join(tmp, "vault.dat")
            with open(vault_path, "wb") as f:
                f.write(vault_bytes)

            out_dir = os.path.join(tmp, "unpack", "target")
            os.makedirs(out_dir, exist_ok=True)

            result = run_unpack(vault_path, out_dir)
            self.assertEqual(result.returncode, 0, msg=result.stderr)

            for root, _dirs, files in os.walk(tmp):
                if root == out_dir:
                    continue
                self.assertNotIn(
                    "innocent.txt",
                    files,
                    msg=f"attachment escaped the output directory into {root}",
                )

            written = os.listdir(out_dir)
            self.assertEqual(len(written), 1, msg=f"unexpected files: {written}")
            with open(os.path.join(out_dir, written[0]), "rb") as f:
                self.assertEqual(f.read(), secret_content)

    def test_malicious_attachment_name_does_not_create_an_alternate_data_stream(self):
        # Второй раунд ревью: ":" в attachments[].name - на NTFS не
        # directory traversal (не выходит за пределы out_dir), а синтаксис
        # Alternate Data Streams ("имя:поток") - создаёт СКРЫТЫЙ поток
        # внутри обычного файла "имя" внутри out_dir. Ревьюер реально
        # создал и прочитал такой поток (Get-Item -Stream */Get-Content
        # -Stream) до фикса - этот тест воспроизводит ровно тот же
        # сценарий и проверяет, что скрытого потока не появляется.
        secret_content = b"visible attachment content"
        hidden_payload = b"this must never end up in a hidden NTFS stream"
        item = {
            "id": "item-ads",
            "attachments": [
                {
                    "id": "att-1",
                    "name": "evil:hidden_stream.txt",
                    "mimeType": "text/plain",
                    "size": len(hidden_payload),
                    "data": base64.b64encode(hidden_payload).decode("ascii"),
                }
            ],
        }
        vault_bytes = build_vault_bytes([item])

        with tempfile.TemporaryDirectory() as tmp:
            vault_path = os.path.join(tmp, "vault.dat")
            with open(vault_path, "wb") as f:
                f.write(vault_bytes)
            out_dir = os.path.join(tmp, "out")

            result = run_unpack(vault_path, out_dir)
            self.assertEqual(result.returncode, 0, msg=result.stderr)

            written = os.listdir(out_dir)
            self.assertEqual(len(written), 1, msg=f"unexpected files: {written}")
            # ":" обязано быть вычищено из итогового имени файла - иначе
            # оно само по себе снова открывает синтаксис ADS.
            self.assertNotIn(":", written[0])
            self.assertEqual(written[0], "item-ads-evil_hidden_stream.txt")

            written_path = os.path.join(out_dir, written[0])
            with open(written_path, "rb") as f:
                self.assertEqual(f.read(), hidden_payload)

            # Воспроизводим ровно то, что сделал ревьюер: БЕЗ фикса
            # os.path.join(out_dir, "item-ads-evil:hidden_stream.txt")
            # создаёт на диске обычный файл "item-ads-evil" со скрытым
            # потоком "hidden_stream.txt". Ни такого файла, ни тем более
            # потока на нём быть не должно - если бы фикс не работал,
            # следующие проверки не прошли бы.
            legacy_unsanitized_path = os.path.join(out_dir, "item-ads-evil")
            self.assertFalse(os.path.exists(legacy_unsanitized_path))

            if sys.platform == "win32":
                with self.assertRaises(OSError):
                    with open(f"{legacy_unsanitized_path}:hidden_stream.txt", "rb"):
                        pass


class UnpackAttachmentsContentTest(unittest.TestCase):
    """Не только "не сбегает" - но и содержимое (для обычных, не вредоносных
    имён) остаётся побайтово тем же, что и до распаковки (R44.2)."""

    def test_unpacked_file_content_matches_original_bytes(self):
        original = bytes(range(256)) * 4  # не текст - проверяет двоичную точность, не только ASCII
        item = {
            "id": "item-xyz",
            "attachments": [
                {
                    "id": "att-1",
                    "name": "photo.png",
                    "mimeType": "image/png",
                    "size": len(original),
                    "data": base64.b64encode(original).decode("ascii"),
                }
            ],
        }
        vault_bytes = build_vault_bytes([item])

        with tempfile.TemporaryDirectory() as tmp:
            vault_path = os.path.join(tmp, "vault.dat")
            with open(vault_path, "wb") as f:
                f.write(vault_bytes)
            out_dir = os.path.join(tmp, "out")

            result = run_unpack(vault_path, out_dir)
            self.assertEqual(result.returncode, 0, msg=result.stderr)

            written = os.listdir(out_dir)
            self.assertEqual(len(written), 1)
            self.assertEqual(written[0], "item-xyz-photo.png")
            with open(os.path.join(out_dir, written[0]), "rb") as f:
                self.assertEqual(f.read(), original)


if __name__ == "__main__":
    unittest.main()
