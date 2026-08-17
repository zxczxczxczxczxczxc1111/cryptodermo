// Точка входа Rust-части приложения. Всё, что здесь есть, - это регистрация
// пяти команд файлового слоя из `vault_fs.rs`. Больше Rust-код ничего не
// делает: шифрование, разбор формата файла и вся бизнес-логика - в
// TypeScript (см. `src/lib/`), потому что WebCrypto и JSON прекрасно
// работают прямо в WebView.

mod vault_fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Глобальное сочетание регистрируется на стороне фронта: там же лежит
        // и настройка, и решение, что делать по нажатию.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Автозапуск. Флаг `--autostart` передаётся самой системе при старте:
        // по нему приложение понимает, что его подняли вместе с Windows, а не
        // руками, и не лезет на передний план (см. main.tsx).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            vault_fs::read_vault,
            vault_fs::write_vault_atomic,
            vault_fs::list_backups,
            vault_fs::rotate_backups,
            vault_fs::exe_dir,
            vault_fs::quick_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
