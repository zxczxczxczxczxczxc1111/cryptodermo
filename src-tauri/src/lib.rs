// Точка входа Rust-части приложения. Всё, что здесь есть, - это регистрация
// четырёх команд файлового слоя из `vault_fs.rs`. Больше Rust-код ничего не
// делает: шифрование, разбор формата файла и вся бизнес-логика - в
// TypeScript (см. `src/lib/`), потому что WebCrypto и JSON прекрасно
// работают прямо в WebView.

mod vault_fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            vault_fs::read_vault,
            vault_fs::write_vault_atomic,
            vault_fs::list_backups,
            vault_fs::rotate_backups,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
