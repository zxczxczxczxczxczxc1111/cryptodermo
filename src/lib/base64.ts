/**
 * base64 (стандартный алфавит RFC 4648) <-> байты.
 *
 * Единственное исключение из правила проекта "каждый модуль держит свою
 * маленькую копию мелких приватных хелперов" (см. CLAUDE.md, решение
 * тикета 02). Вынесено по прямому запросу пользователя (тикет 14 очереди
 * 19.08.2026): к тому моменту эта пара была скопирована в 11 файлов
 * семнадцатью функциями, все семантически идентичные - копия перестала
 * быть "маленькой локальной деталью" и превратилась в место, где правка
 * применяется в одиннадцати местах или нигде.
 *
 * `dirOf`/`joinPath` при этом ОСТАЮТСЯ копиями в своих файлах - решение
 * того же запроса дословно: "не трогать" (две строки в трёх местах,
 * выносить незачем).
 *
 * Без Node-специфичного `Buffer`: код работает и в webview Tauri, и в
 * браузерной заглушке разработки.
 */

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
