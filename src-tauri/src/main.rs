#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod discovery;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
const REPOSITORY: &str = "https://github.com/RiccardoCherchi/flutrace";

struct Lifecycle {
    ready: AtomicBool,
    closing: AtomicBool,
}

#[tauri::command]
fn frontend_ready(state: tauri::State<Lifecycle>) {
    state.ready.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn finish_exit(app: tauri::AppHandle) {
    app.exit(0);
}

fn request_shutdown(app: &tauri::AppHandle) {
    if app
        .state::<Lifecycle>()
        .closing
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let _ = app.emit("flutrace-shutdown", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        // A stalled VM or webview must not prevent the user from quitting.
        std::thread::sleep(std::time::Duration::from_secs(12));
        handle.exit(0);
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            #[cfg(target_os = "macos")]
            if let Some(tauri::menu::MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
                let about = tauri::menu::PredefinedMenuItem::about(
                    app,
                    Some("About Flutrace"),
                    Some(tauri::menu::AboutMetadata {
                        name: Some("Flutrace".into()),
                        version: Some(app.package_info().version.to_string()),
                        short_version: Some(String::new()),
                        icon: app.default_window_icon().cloned(),
                        // AppKit centres the copyright line; credits render as large left-aligned text.
                        copyright: Some("Network inspector for Flutter.\n© 2026 Riccardo".into()),
                        ..Default::default()
                    }),
                )?;
                // Tauri's default macOS app menu starts with About.
                app_menu.remove_at(0)?;
                app_menu.prepend(&about)?;
            }
            #[cfg(target_os = "macos")]
            if let Some(tauri::menu::MenuItemKind::Submenu(help)) =
                menu.get(tauri::menu::HELP_SUBMENU_ID)
            {
                help.append(&tauri::menu::MenuItem::with_id(
                    app,
                    "github",
                    "Flutrace on GitHub",
                    true,
                    None::<&str>,
                )?)?;
            }
            Ok(menu)
        })
        .on_menu_event(|_, _event| {
            // The GitHub item is only added to the macOS menu.
            #[cfg(target_os = "macos")]
            if _event.id() == "github" {
                let _ = std::process::Command::new("/usr/bin/open")
                    .arg(REPOSITORY)
                    .spawn();
            }
        })
        .manage(discovery::Discovery::default())
        .manage(Lifecycle {
            ready: AtomicBool::new(false),
            closing: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            finish_exit,
            discovery::start_discovery,
            discovery::discovery_snapshot
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<Lifecycle>().ready.load(Ordering::SeqCst) {
                    api.prevent_close();
                    request_shutdown(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("could not build Flutrace")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<discovery::Discovery>().stop();
            }
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                if app.state::<Lifecycle>().ready.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    request_shutdown(app);
                }
            }
        });
}
