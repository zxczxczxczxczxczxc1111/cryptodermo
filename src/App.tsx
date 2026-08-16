import { useState } from "react";
import { resourceDir, join } from "@tauri-apps/api/path";
import {
  readVault,
  writeVaultAtomic,
  listBackups,
  rotateBackups,
  type BackupInfo,
} from "./lib/tauriApi";
import "./App.css";

/**
 * ВРЕМЕННЫЙ отладочный экран, не постоянный UI приложения.
 *
 * Единственная задача этого файла в рамках тикета "Каркас проекта и
 * файловый слой" - руками (или глазами во время ревью) убедиться, что все
 * четыре Rust-команды (`read_vault`, `write_vault_atomic`, `list_backups`,
 * `rotate_backups`) действительно вызываются из JS через `invoke()` и
 * возвращают ожидаемые типы, включая читаемый текст ошибки при сбое.
 * Реальные экраны приложения (разблокировка, список записей и т.д.)
 * появятся в следующих тикетах и полностью заменят этот файл.
 */

/** Кодирует текст из textarea в байты - то, что реально пишется на диск. */
function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function App() {
  // Каталог рядом с exe (R29: база и бэкапы живут рядом с приложением, а не
  // в %AppData%). `resourceDir()` на Windows резолвится именно в каталог,
  // где лежит исполняемый файл - проверено по документации Tauri v2.
  const [baseDir, setBaseDir] = useState<string>("");
  const [vaultPath, setVaultPath] = useState<string>("");
  const [backupsDir, setBackupsDir] = useState<string>("");

  const [content, setContent] = useState("тестовое содержимое vault-debug.dat");
  const [output, setOutput] = useState<string>("(пока ничего не вызывалось)");
  const [backups, setBackups] = useState<BackupInfo[]>([]);

  async function ensurePaths(): Promise<{ vaultPath: string; backupsDir: string }> {
    if (vaultPath && backupsDir) {
      return { vaultPath, backupsDir };
    }
    const dir = await resourceDir();
    const vPath = await join(dir, "vault-debug.dat");
    const bDir = await join(dir, "backups-debug");
    setBaseDir(dir);
    setVaultPath(vPath);
    setBackupsDir(bDir);
    return { vaultPath: vPath, backupsDir: bDir };
  }

  async function handleWrite() {
    try {
      const { vaultPath: p } = await ensurePaths();
      await writeVaultAtomic(p, textToBytes(content));
      setOutput(`write_vault_atomic: успешно записано в ${p}`);
    } catch (err) {
      setOutput(`write_vault_atomic: ОШИБКА - ${String(err)}`);
    }
  }

  async function handleRead() {
    try {
      const { vaultPath: p } = await ensurePaths();
      const bytes = await readVault(p);
      setOutput(
        `read_vault: прочитано ${bytes.length} байт из ${p}\n\nсодержимое: ${bytesToText(bytes)}`,
      );
    } catch (err) {
      setOutput(`read_vault: ОШИБКА - ${String(err)}`);
    }
  }

  async function handleListBackups() {
    try {
      const { backupsDir: d } = await ensurePaths();
      const list = await listBackups(d);
      setBackups(list);
      setOutput(`list_backups: найдено файлов - ${list.length} (каталог ${d})`);
    } catch (err) {
      setOutput(`list_backups: ОШИБКА - ${String(err)}`);
    }
  }

  async function handleMakeBackupCopy() {
    // Debug-экран не реализует реальную бизнес-логику ротации (это дело
    // будущего тикета save-flow) - просто кладёт ещё одну копию текущего
    // содержимого в backups-debug/, чтобы было что ротировать кнопкой ниже.
    try {
      const { vaultPath: p, backupsDir: d } = await ensurePaths();
      const bytes = await readVault(p).catch(() => textToBytes(content));
      const backupPath = await join(d, `vault-debug-${Date.now()}.dat`);
      await writeVaultAtomic(backupPath, bytes);
      setOutput(`создана резервная копия: ${backupPath}`);
    } catch (err) {
      setOutput(`создание копии: ОШИБКА - ${String(err)}`);
    }
  }

  async function handleRotate() {
    try {
      const { backupsDir: d } = await ensurePaths();
      await rotateBackups(d, 2);
      setOutput(`rotate_backups: выполнено, оставлено не больше 2 файлов в ${d}`);
      await handleListBackups();
    } catch (err) {
      setOutput(`rotate_backups: ОШИБКА - ${String(err)}`);
    }
  }

  return (
    <main className="debug-screen">
      <h1>Vault - отладочный экран файлового слоя (временный)</h1>
      <p>
        Базовый каталог (рядом с exe): <code>{baseDir || "(нажмите любую кнопку ниже)"}</code>
      </p>

      <section>
        <label htmlFor="content">Содержимое для записи (vault-debug.dat)</label>
        <textarea
          id="content"
          rows={3}
          value={content}
          onChange={(e) => setContent(e.currentTarget.value)}
        />
        <button onClick={handleWrite}>write_vault_atomic</button>
        <button onClick={handleRead}>read_vault</button>
      </section>

      <section>
        <button onClick={handleMakeBackupCopy}>сделать копию в backups-debug/</button>
        <button onClick={handleListBackups}>list_backups</button>
        <button onClick={handleRotate}>rotate_backups (keep_n = 2)</button>
        <ul>
          {backups.map((b) => (
            <li key={b.path}>
              {b.filename} - {b.size} байт - {new Date(b.modifiedAtMs).toLocaleString()}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <label>Результат последнего вызова</label>
        <pre>{output}</pre>
      </section>
    </main>
  );
}

export default App;
