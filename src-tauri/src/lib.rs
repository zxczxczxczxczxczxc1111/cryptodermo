use tauri::{
    menu::{Menu, MenuItem},
    Emitter,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

/// Значок в области уведомлений.
///
/// Нужен не для красоты: глобальное сочетание клавиш держит живой процесс, а
/// закрытое приложение процессом не является. Без значка единственным способом
/// оставить программу в памяти было бы висящее на экране окно.
///
/// Меню намеренно из двух пунктов. «Открыть» - то же, что щелчок по значку,
/// продублировано потому, что не все ищут действие в левой кнопке. «Выйти» -
/// единственный способ завершить процесс, когда закрытие окна настроено на
/// сворачивание: иначе программа стала бы неубиваемой из интерфейса.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("иконка приложения").clone())
        .tooltip("cryptodermo")
        .menu(&menu)
        // Левая кнопка не должна открывать меню: по ней ожидают само окно.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Поднять окно из свёрнутого или скрытого состояния.
///
/// Три вызова, а не один: скрытое окно нужно показать, свёрнутое - развернуть,
/// и только потом отдать ему фокус. Пропустив любой шаг, получаешь окно,
/// которое «мигнуло и осталось внизу».
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// Точка входа Rust-части приложения. Всё, что здесь есть, - это регистрация
// пяти команд файлового слоя из `vault_fs.rs`. Больше Rust-код ничего не
// делает: шифрование, разбор формата файла и вся бизнес-логика - в
// TypeScript (см. `src/lib/`), потому что WebCrypto и JSON прекрасно
// работают прямо в WebView.

mod vault_fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ПЕРВЫМ плагином, так требует документация: он должен перехватить
        // повторный запуск до того, как приложение начнёт что-либо делать.
        //
        // Без него каждый запуск ярлыка плодил новый процесс, и в панели задач
        // накапливались одинаковые значки (замечено пользователем 17.08.2026).
        // Теперь второй запуск не создаёт процесс, а передаёт свои аргументы
        // первому: ярлык быстрого доступа поднимает маленькое окно, обычный -
        // основное.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|arg| arg == "--quick") {
                let _ = app.emit("single-instance:quick", ());
            } else {
                show_main_window(app);
            }
        }))
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
        .setup(|app| {
            build_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
