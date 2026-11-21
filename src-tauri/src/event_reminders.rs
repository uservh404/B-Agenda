use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;

const MAX_REMINDERS: usize = 10_000;
const MAX_DELIVERY_AGE_MS: u64 = 90 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventReminder {
    event_id: String,
    schedule_key: String,
    title: String,
    body: String,
    due_at_ms: u64,
    start_at_ms: u64,
    expires_at_ms: u64,
}

#[derive(Default, Deserialize, Serialize)]
struct DeliveryLedger {
    #[serde(default)]
    delivered_at_ms: HashMap<String, u64>,
}

#[derive(Default)]
struct ReminderState {
    user_id: Option<String>,
    reminders: HashMap<String, EventReminder>,
    delivered_at_ms: HashMap<String, u64>,
}

pub struct EventReminderManager {
    state: Mutex<ReminderState>,
    wake: Condvar,
    local_data_dir: Option<PathBuf>,
    sound_path: Option<PathBuf>,
}

impl EventReminderManager {
    pub fn new(local_data_dir: Option<PathBuf>, sound_path: Option<PathBuf>) -> Self {
        Self {
            state: Mutex::new(ReminderState::default()),
            wake: Condvar::new(),
            local_data_dir,
            sound_path,
        }
    }

    fn replace(
        &self,
        user_id: Option<String>,
        reminders: Vec<EventReminder>,
    ) -> Result<(), String> {
        if reminders.len() > MAX_REMINDERS {
            return Err("La lista de recordatorios excede el límite permitido.".to_string());
        }
        if user_id.is_none() && !reminders.is_empty() {
            return Err("No se pueden programar recordatorios sin una cuenta activa.".to_string());
        }
        if user_id.as_deref().is_some_and(|id| !is_uuid(id)) {
            return Err("La cuenta de recordatorios no es válida.".to_string());
        }

        let mut scheduled = HashMap::with_capacity(reminders.len());
        for reminder in reminders {
            validate_reminder(&reminder)?;
            let key = reminder.schedule_key.clone();
            if scheduled.insert(key, reminder).is_some() {
                return Err("La lista de recordatorios contiene duplicados.".to_string());
            }
        }

        let saved_ledger = user_id.as_deref().map(|id| self.load_ledger(id));
        let mut state = lock(&self.state);
        if state.user_id != user_id {
            state.delivered_at_ms = saved_ledger
                .unwrap_or_default()
                .delivered_at_ms
                .into_iter()
                .filter(|(_, delivered_at)| {
                    now_ms().saturating_sub(*delivered_at) <= MAX_DELIVERY_AGE_MS
                })
                .collect();
        }
        state.user_id = user_id;
        state.reminders = scheduled
            .into_iter()
            .filter(|(key, _)| !state.delivered_at_ms.contains_key(key))
            .collect();
        drop(state);
        self.wake.notify_all();
        Ok(())
    }

    fn ledger_path(&self, user_id: &str) -> Option<PathBuf> {
        self.local_data_dir
            .as_ref()
            .map(|directory| directory.join(format!("event-reminders-{user_id}.json")))
    }

    fn load_ledger(&self, user_id: &str) -> DeliveryLedger {
        let Some(path) = self.ledger_path(user_id) else {
            return DeliveryLedger::default();
        };
        match fs::read(path) {
            Ok(data) => match serde_json::from_slice::<DeliveryLedger>(&data) {
                Ok(ledger) => ledger,
                Err(error) => {
                    log::warn!("Event reminders: delivery history could not be decoded ({error}).");
                    DeliveryLedger::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                DeliveryLedger::default()
            }
            Err(error) => {
                log::warn!("Event reminders: delivery history could not be read ({:?}).", error.kind());
                DeliveryLedger::default()
            }
        }
    }

    fn mark_delivered(&self, user_id: &str, schedule_key: &str) {
        let ledger = {
            let mut state = lock(&self.state);
            if state.user_id.as_deref() != Some(user_id) {
                return;
            }
            state
                .delivered_at_ms
                .insert(schedule_key.to_string(), now_ms());
            state.reminders.remove(schedule_key);
            state
                .delivered_at_ms
                .retain(|_, delivered_at| now_ms().saturating_sub(*delivered_at) <= MAX_DELIVERY_AGE_MS);
            DeliveryLedger {
                delivered_at_ms: state.delivered_at_ms.clone(),
            }
        };
        self.save_ledger(user_id, &ledger);
    }

    fn save_ledger(&self, user_id: &str, ledger: &DeliveryLedger) {
        let Some(path) = self.ledger_path(user_id) else {
            log::warn!("Event reminders: local delivery history storage is unavailable.");
            return;
        };
        let result = (|| {
            let directory = path.parent().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing data directory")
            })?;
            fs::create_dir_all(directory)?;
            let data = serde_json::to_vec(ledger)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            fs::write(path, data)
        })();
        if let Err(error) = result {
            log::warn!("Event reminders: delivery history could not be saved ({:?}).", error.kind());
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit()
        })
}

fn validate_reminder(reminder: &EventReminder) -> Result<(), String> {
    if !is_uuid(&reminder.event_id)
        || reminder.schedule_key.is_empty()
        || reminder.schedule_key.len() > 160
        || reminder.schedule_key.chars().any(char::is_control)
        || reminder.title.trim().is_empty()
        || reminder.title.len() > 512
        || reminder.body.trim().is_empty()
        || reminder.body.len() > 2_048
        || reminder.due_at_ms == 0
        || reminder.start_at_ms < reminder.due_at_ms
        || reminder.expires_at_ms < reminder.due_at_ms
    {
        return Err("Se recibió un recordatorio de evento no válido.".to_string());
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn is_due(reminder: &EventReminder, now: u64) -> bool {
    reminder.due_at_ms <= now && now <= reminder.expires_at_ms
}

#[tauri::command]
pub fn replace_event_reminders(
    manager: State<'_, Arc<EventReminderManager>>,
    user_id: Option<String>,
    reminders: Vec<EventReminder>,
) -> Result<(), String> {
    manager.replace(user_id, reminders)
}

pub fn start_worker(app: AppHandle, manager: Arc<EventReminderManager>) -> std::io::Result<()> {
    thread::Builder::new()
        .name("agenda-event-reminders".to_string())
        .spawn(move || loop {
            let due_reminders = {
                let state = lock(&manager.state);
                let due = state
                    .reminders
                    .values()
                    .filter(|reminder| is_due(reminder, now_ms()))
                    .cloned()
                    .collect::<Vec<_>>();
                if due.is_empty() {
                    let _ = manager
                        .wake
                        .wait_timeout(state, Duration::from_secs(1))
                        .unwrap_or_else(PoisonError::into_inner);
                    continue;
                }
                (state.user_id.clone(), due)
            };

            let Some(user_id) = due_reminders.0 else {
                continue;
            };
            for reminder in due_reminders.1 {
                let delivery = {
                    let state = lock(&manager.state);
                    if state.user_id.as_deref() != Some(&user_id)
                        || state.delivered_at_ms.contains_key(&reminder.schedule_key)
                        || !state.reminders.contains_key(&reminder.schedule_key)
                        || !is_due(&reminder, now_ms())
                    {
                        continue;
                    }

                    let mut notification = app
                        .notification()
                        .builder()
                        .title("AgendaJuventud")
                        .body(&reminder.body);
                    if cfg!(target_os = "windows") {
                        notification = notification.sound("Reminder");
                    } else if let Some(sound_path) = &manager.sound_path {
                        notification = notification.sound(sound_path.to_string_lossy());
                    }
                    notification.show()
                };

                if let Err(error) = delivery {
                    log::warn!("Event reminders: the native notification could not be shown ({error}).");
                }
                manager.mark_delivered(&user_id, &reminder.schedule_key);
            }
        })
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reminder(due_at_ms: u64, start_at_ms: u64, expires_at_ms: u64) -> EventReminder {
        EventReminder {
            event_id: "00000000-0000-4000-8000-000000000001".to_string(),
            schedule_key: "test-schedule".to_string(),
            title: "Evento".to_string(),
            body: "Mensaje".to_string(),
            due_at_ms,
            start_at_ms,
            expires_at_ms,
        }
    }

    #[test]
    fn reminder_only_fires_inside_its_delivery_window() {
        let scheduled = reminder(1_000, 2_000, 1_999);
        assert!(!is_due(&scheduled, 999));
        assert!(is_due(&scheduled, 1_000));
        assert!(is_due(&scheduled, 1_999));
        assert!(!is_due(&scheduled, 2_000));
    }

    #[test]
    fn invalid_event_ids_are_rejected() {
        assert!(is_uuid("00000000-0000-4000-8000-000000000001"));
        assert!(!is_uuid("not-an-event-id"));
    }
}
