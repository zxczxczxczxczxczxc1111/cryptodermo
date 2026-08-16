/**
 * Криптомодуль (`crypto` из interfaces.md): деривация ключа из мастер-пароля
 * и симметричное шифрование тела базы. Только стандартные примитивы
 * браузерного WebCrypto (`crypto.subtle`) - PBKDF2-SHA256 для деривации,
 * AES-256-GCM для шифрования. Свои алгоритмы здесь не реализуются ни в
 * каком виде (R20, R32) - весь модуль тонкая обёртка над `SubtleCrypto`.
 *
 * Ключ никогда не покидает модуль как сырые байты: `deriveKey` возвращает
 * `CryptoKey` с `extractable: false`, поэтому даже случайная попытка
 * сериализовать возвращённый объект (например, в `localStorage`) не даёт
 * прочитать ключевой материал - WebCrypto физически не отдаёт его наружу
 * (R34).
 */

/** Длина IV для AES-GCM в байтах - рекомендация NIST SP 800-38D (96 бит). */
const GCM_IV_LENGTH_BYTES = 12;

/** Длина ключа AES-256 в битах. */
const AES_KEY_LENGTH_BITS = 256;

/**
 * Нижняя граница числа итераций PBKDF2 по рекомендации OWASP из брифа
 * (R40). `benchmarkIterations` никогда не возвращает меньше этого значения,
 * даже если экстраполяция по замеру на конкретной машине предложила бы
 * меньше (машина заметно быстрее той, что использовалась для нижней
 * границы OWASP).
 */
const OWASP_MIN_ITERATIONS = 600_000;

/**
 * Итоговое число итераций PBKDF2 для новых баз, зафиксированное измерением
 * на машине разработки (не взято из головы, R41). Замер тем же методом, что
 * и `benchmarkIterations` (медиана 7 калибровочных прогонов по 1 000 000
 * итераций, экстраполяция до цели 750мс - середина диапазона 0.5-1с из
 * брифа), дал 5 031 237. Число округлено вниз до круглого вида с небольшим
 * запасом против случайной просадки производительности машины - и
 * отдельно, вручную, а не через `benchmarkIterations`, перепроверено
 * прямыми прогонами именно на 5 000 000 итерациях: медиана 6 прогонов -
 * 804.7мс (разброс 739.6-828.5мс), внутри целевого диапазона. Методика и
 * все числа - в `FORMAT.md` §5.
 */
export const DEFAULT_ITERATIONS = 5_000_000;

/**
 * Единая ошибка расшифровки. AES-GCM проверяет тег аутентификации при
 * расшифровке и не различает на своём уровне "неверный ключ" и "повреждённые
 * данные" - `crypto.subtle.decrypt` в обоих случаях просто бросает
 * `OperationError` без дополнительных деталей. Поэтому и здесь ошибка одна:
 * попытка различить причину дала бы ложное чувство точности, а не реальную
 * информацию (R94.1 - UI показывает один и тот же текст в обоих случаях).
 */
export class DecryptError extends Error {
  constructor(
    message = "Decryption failed: wrong password or corrupted data",
  ) {
    super(message);
    this.name = "DecryptError";
  }
}

/**
 * Импортировать пароль как ключевой материал PBKDF2. Общая часть между
 * `deriveKey` и `benchmarkIterations` - вынесена, чтобы не дублировать
 * `importKey` с одинаковыми параметрами.
 */
async function importPasswordKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
}

/**
 * Деривация ключа шифрования из мастер-пароля через PBKDF2-SHA256 (R40).
 * `salt` и `iterations` приходят из заголовка контейнера (см.
 * `vaultFormat.ts`) - при разблокировке существующей базы используются
 * ровно те значения, что записаны в её заголовке, не текущий
 * `DEFAULT_ITERATIONS`.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const passwordKey = await importPasswordKey(password);

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH_BITS },
    // extractable: false - см. комментарий модуля выше и R34.
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Зашифровать байты AES-256-GCM. Случайный IV на каждый вызов (обязательное
 * условие безопасности AES-GCM - переиспользование IV с тем же ключом
 * ломает конфиденциальность и аутентичность). IV не секрет, он идёт в
 * открытый заголовок контейнера рядом с шифротекстом.
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH_BYTES));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext as BufferSource,
  );
  return { iv, ciphertext: new Uint8Array(ciphertextBuffer) };
}

/**
 * Расшифровать AES-256-GCM. Бросает `DecryptError` вместо того, чтобы дать
 * упасть исходному `OperationError` из WebCrypto - вызывающий код (UI)
 * должен ловить один известный тип ошибки, а не разбираться в деталях
 * SubtleCrypto.
 */
export async function decrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  try {
    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plaintextBuffer);
  } catch {
    throw new DecryptError();
  }
}

/** Число калибровочных прогонов, из которых берётся медиана - см. FORMAT.md §5. */
const CALIBRATION_TRIALS = 7;

/** Число итераций PBKDF2 в одном калибровочном прогоне - см. FORMAT.md §5. */
const CALIBRATION_ITERATIONS = 1_000_000;

/**
 * Однократный замер (R41): сколько итераций PBKDF2 укладывается в целевое
 * время (`targetMs`) на этой машине. Не вызывается на каждой разблокировке -
 * используется один раз при создании новой базы (или в настройках при явном
 * запросе пересчитать), результат сохраняется в заголовке контейнера и
 * дальше берётся оттуда.
 *
 * Метод: один разогревочный прогон PBKDF2 по `CALIBRATION_ITERATIONS`
 * итераций (не учитывается - первый вызов обычно медленнее следующих из-за
 * прогрева движка), затем `CALIBRATION_TRIALS` учитываемых прогонов, из
 * времени которых берётся медиана. Медиана времени на одну итерацию даёт
 * линейную экстраполяцию до `targetMs` (PBKDF2 линеен по числу итераций -
 * каждая итерация независимый раунд HMAC, экстраполяция корректна без
 * подбора в несколько шагов).
 *
 * Медиана нескольких прогонов на достаточно большом числе итераций - не
 * один короткий замер - потому, что единичный короткий прогон на практике
 * оказался слишком шумным: на машине разработки один прогон на 200 000
 * итераций между разными запусками давал оценку итогового числа итераций с
 * разбросом почти в 2 раза (эта же машина делит CPU с другими процессами).
 * Результат не может быть меньше `OWASP_MIN_ITERATIONS` - если машина
 * настолько быстрая, что экстраполяция предложила бы меньше, нижняя граница
 * OWASP всё равно соблюдается.
 */
export async function benchmarkIterations(
  password: string,
  salt: Uint8Array,
  targetMs: number,
): Promise<number> {
  const passwordKey = await importPasswordKey(password);

  const runCalibration = async (): Promise<number> => {
    const start = performance.now();
    await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt as BufferSource,
        iterations: CALIBRATION_ITERATIONS,
        hash: "SHA-256",
      },
      passwordKey,
      { name: "AES-GCM", length: AES_KEY_LENGTH_BITS },
      false,
      ["encrypt", "decrypt"],
    );
    return performance.now() - start;
  };

  await runCalibration(); // разогрев, результат не учитывается

  const samples: number[] = [];
  for (let i = 0; i < CALIBRATION_TRIALS; i++) {
    samples.push(await runCalibration());
  }
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  const medianMs =
    samples.length % 2 === 0
      ? (samples[mid - 1] + samples[mid]) / 2
      : samples[mid];

  const msPerIteration = medianMs / CALIBRATION_ITERATIONS;
  const estimated = Math.round(targetMs / msPerIteration);
  return Math.max(estimated, OWASP_MIN_ITERATIONS);
}
