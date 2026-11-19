use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const IDENTITY_FILE: &str = "offline-identity.dpapi";
const DPAPI_ENTROPY: &[u8] = b"com.agendajuventud.offline-identity.v1";

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct OfflineIdentity {
    #[serde(rename = "id", alias = "userId")]
    user_id: String,
    email: Option<String>,
}

#[derive(Deserialize)]
struct SupabaseUser {
    id: String,
    email: Option<String>,
}

fn identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join(IDENTITY_FILE))
        .map_err(|_| {
            log::warn!("Offline identity: Tauri could not resolve the app local data directory.");
            "No se pudo determinar el almacenamiento local seguro.".to_string()
        })
}

#[tauri::command]
pub async fn save_offline_identity(
    app: AppHandle,
    user_id: String,
    access_token: String,
    supabase_url: String,
    publishable_key: String,
) -> Result<(), String> {
    log::debug!("Offline identity: validating session with Supabase.");
    let base_url = reqwest::Url::parse(&supabase_url)
        .map_err(|_| "La dirección del servicio no es válida.".to_string())?;
    let local_development_host = matches!(base_url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if (base_url.scheme() != "https"
        && !(base_url.scheme() == "http" && local_development_host))
        || base_url.host_str().is_none()
        || !base_url.username().is_empty()
        || base_url.password().is_some()
        || access_token.is_empty()
        || publishable_key.is_empty()
    {
        return Err("No se pudo validar la identidad para el acceso local.".to_string());
    }

    let endpoint = format!("{}/auth/v1/user", supabase_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "No se pudo preparar la validación de la cuenta.".to_string())?;
    let response = client
        .get(endpoint)
        .header("apikey", publishable_key)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| {
            log::warn!("Offline identity: Supabase validation failed at the network layer.");
            "No se pudo validar la cuenta con el servicio.".to_string()
        })?;
    if !response.status().is_success() {
        log::warn!(
            "Offline identity: Supabase did not confirm the session (HTTP {}).",
            response.status().as_u16()
        );
        return Err("El servicio no confirmó la identidad de la cuenta.".to_string());
    }
    let verified_user = response
        .json::<SupabaseUser>()
        .await
        .map_err(|_| {
            log::warn!("Offline identity: Supabase returned an unreadable identity response.");
            "La respuesta de identidad no es válida.".to_string()
        })?;
    if verified_user.id != user_id {
        log::warn!("Offline identity: Supabase identity did not match the active session.");
        return Err("La identidad recibida no coincide con la sesión.".to_string());
    }

    let identity = OfflineIdentity {
        user_id: verified_user.id,
        email: verified_user.email,
    };
    let plaintext = serde_json::to_vec(&identity)
        .map_err(|_| "No se pudo preparar la identidad local.".to_string())?;
    let encrypted = protect_for_current_user(&plaintext)?;
    let path = identity_path(&app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "No se pudo determinar el directorio de datos.".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| {
            log::warn!(
                "Offline identity: could not create the local data directory ({:?}).",
                error.kind()
            );
            "No se pudo preparar el almacenamiento local seguro.".to_string()
        })?;
    fs::write(&path, encrypted).map_err(|error| {
        log::warn!(
            "Offline identity: could not write the protected marker ({:?}).",
            error.kind()
        );
        "No se pudo guardar la identidad local de forma segura.".to_string()
    })?;

    let stored_bytes = fs::read(&path).map_err(|error| {
        log::warn!(
            "Offline identity: could not read back the protected marker ({:?}).",
            error.kind()
        );
        "No se pudo confirmar el guardado de la identidad local.".to_string()
    })?;
    let stored_plaintext = unprotect_for_current_user(&stored_bytes)?;
    let stored_identity = serde_json::from_slice::<OfflineIdentity>(&stored_plaintext)
        .map_err(|_| {
            log::warn!("Offline identity: saved marker could not be decoded during read-back.");
            "No se pudo confirmar el formato de la identidad local.".to_string()
        })?;
    if stored_identity != identity {
        log::warn!("Offline identity: saved marker did not match the confirmed identity.");
        return Err("No se pudo confirmar la identidad local guardada.".to_string());
    }
    log::info!("Offline identity: protected marker saved and verified.");
    Ok(())
}

#[tauri::command]
pub fn load_offline_identity(app: AppHandle) -> Result<Option<OfflineIdentity>, String> {
    let path = identity_path(&app)?;
    let encrypted = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            log::info!("Offline identity: no protected marker exists in this app data directory.");
            return Ok(None);
        }
        Err(error) => {
            log::warn!(
                "Offline identity: could not read the protected marker ({:?}).",
                error.kind()
            );
            return Err("No se pudo leer la identidad local segura.".to_string());
        }
    };
    let plaintext = unprotect_for_current_user(&encrypted)?;
    let identity = serde_json::from_slice::<OfflineIdentity>(&plaintext)
        .map_err(|_| {
            log::warn!("Offline identity: protected marker has an invalid data format.");
            "La identidad local guardada no es válida.".to_string()
        })?;
    if identity.user_id.is_empty() {
        log::warn!("Offline identity: protected marker has an empty account identifier.");
        return Err("La identidad local guardada no es válida.".to_string());
    }
    log::info!("Offline identity: protected marker loaded successfully.");
    Ok(Some(identity))
}

#[tauri::command]
pub fn clear_offline_identity(app: AppHandle) -> Result<(), String> {
    let path = identity_path(&app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            log::warn!(
                "Offline identity: could not remove the protected marker ({:?}).",
                error.kind()
            );
            Err("No se pudo quitar la identidad local segura.".to_string())
        }
    }
}

#[cfg(windows)]
fn protect_for_current_user(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ffi::c_void, ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: DPAPI_ENTROPY.len() as u32,
        pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let protected = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            &entropy,
            ptr::null::<c_void>(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if protected == 0 {
        log::warn!("Offline identity: Windows DPAPI protection failed.");
        return Err("Windows no pudo proteger la identidad local.".to_string());
    }

    let encrypted = unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(encrypted)
}

#[cfg(windows)]
fn unprotect_for_current_user(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ffi::c_void, ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: DPAPI_ENTROPY.len() as u32,
        pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let decrypted = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            &entropy,
            ptr::null::<c_void>(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if decrypted == 0 {
        log::warn!("Offline identity: Windows DPAPI could not unprotect the marker for this user.");
        return Err("Windows no pudo verificar la identidad local.".to_string());
    }

    let plaintext = unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(plaintext)
}

#[cfg(not(windows))]
fn protect_for_current_user(_plaintext: &[u8]) -> Result<Vec<u8>, String> {
    Err("El acceso local seguro está disponible en Windows.".to_string())
}

#[cfg(not(windows))]
fn unprotect_for_current_user(_encrypted: &[u8]) -> Result<Vec<u8>, String> {
    Err("El acceso local seguro está disponible en Windows.".to_string())
}

#[cfg(test)]
mod tests {
    use super::OfflineIdentity;

    #[test]
    fn identity_uses_frontend_field_name_and_reads_legacy_marker() {
        let identity = OfflineIdentity {
            user_id: "user-123".to_string(),
            email: Some("user@example.test".to_string()),
        };
        let serialized = serde_json::to_value(&identity).expect("identity should serialize");
        assert_eq!(serialized["id"], "user-123");
        assert!(serialized.get("userId").is_none());

        let legacy = serde_json::json!({
            "userId": "user-123",
            "email": "user@example.test"
        });
        let decoded: OfflineIdentity =
            serde_json::from_value(legacy).expect("legacy identity should remain readable");
        assert_eq!(decoded, identity);
    }
}
