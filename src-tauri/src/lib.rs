mod offline_identity;
mod event_reminders;

use std::{path::PathBuf, sync::Arc};
use tauri::{Manager, path::BaseDirectory};

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::error!("AgendaJuventud: the main window is unavailable.");
        return;
    };
    if let Err(error) = window.show() {
        log::warn!("AgendaJuventud: could not show the main window ({error}).");
    }
    if let Err(error) = window.unminimize() {
        log::warn!("AgendaJuventud: could not restore the main window ({error}).");
    }
    if let Err(error) = window.set_focus() {
        log::warn!("AgendaJuventud: could not focus the main window ({error}).");
    }
}

#[cfg(desktop)]
fn create_system_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };

    let open = MenuItem::with_id(
        app,
        "open",
        "Abrir AgendaJuventud",
        true,
        None::<&str>,
    )?;
    let exit = MenuItem::with_id(
        app,
        "exit",
        "Salir completamente",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&open, &exit])?;
    let icon = app.default_window_icon().cloned().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "The application tray icon is not configured.",
        )
    })?;
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("AgendaJuventud")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "exit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    app.manage(tray);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();
  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
      show_main_window(app);
    }));
  }
  builder
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      let local_data_dir: Option<PathBuf> = match app.path().app_local_data_dir() {
        Ok(path) => Some(path),
        Err(error) => {
          log::warn!("Event reminders: local delivery history is unavailable ({error}).");
          None
        }
      };
      let sound_path = match app
        .path()
        .resolve("resources/agenda-reminder.wav", BaseDirectory::Resource)
      {
        Ok(path) if path.is_file() => Some(path),
        Ok(_) => {
          log::error!("Event reminders: the bundled WAV sound file is missing.");
          None
        }
        Err(error) => {
          log::error!("Event reminders: the bundled WAV sound file could not be resolved ({error}).");
          None
        }
      };
      if sound_path.is_none() {
        log::warn!("Event reminders will use the default Windows notification sound.");
      }

      let reminder_manager = Arc::new(event_reminders::EventReminderManager::new(
        local_data_dir,
        sound_path,
      ));
      app.manage(reminder_manager.clone());
      if let Err(error) = event_reminders::start_worker(app.handle().clone(), reminder_manager) {
        log::error!("Event reminders: the native background worker could not start ({error}).");
      }
      #[cfg(desktop)]
      create_system_tray(app)?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      offline_identity::save_offline_identity,
      offline_identity::load_offline_identity,
      offline_identity::is_offline_account_suspended,
      offline_identity::set_offline_account_suspension,
      offline_identity::clear_offline_identity,
      event_reminders::replace_event_reminders,
    ])
    .on_window_event(|window, event| {
      if window.label() != "main" {
        return;
      }
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if let Err(error) = window.hide() {
          log::warn!("AgendaJuventud: the main window could not be hidden ({error}).");
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
