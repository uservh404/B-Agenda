use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const IDENTITY_FILE: &str = "offline-identity.dpapi";
const SUSPENSION_LOCKS_FILE: &str = "suspension-locks.dpapi";
const DPAPI_ENTROPY: &[u8] = b"com.agendajuventud.offline-identity.v1";

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct OfflineIdentity {
    #[serde(rename = "id", alias = "userId")]
    user_id: String,
    email: Option<String>,
    #[serde(default)]
    project_origin: String,
    #[serde(default)]
    authorization: Option<OfflineAuthorizationProfile>,
}

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
struct OfflineAuthorizationProfile {
    id: String,
    full_name: String,
    phone: Option<String>,
    role: String,
    can_assign_events: bool,
    can_publish_announcements: bool,
    #[serde(default)]
    can_manage_resources: Option<bool>,
}

#[derive(Deserialize)]
struct SupabaseUser {
    id: String,
    email: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct SuspensionLock {
    project_origin: String,
    user_id: String,
}

#[derive(Default, Deserialize, Serialize)]
struct SuspensionLocks {
    #[serde(default)]
    entries: Vec<SuspensionLock>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineIdentityStatus {
    id: String,
    email: Option<String>,
    suspended: bool,
    authorization: Option<OfflineAuthorizationProfile>,
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
    if !is_uuid(&user_id) {
        return Err("La cuenta local no es válida.".to_string());
    }
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

    let project_origin = project_origin(&supabase_url)?;
    let endpoint = format!("{project_origin}/auth/v1/user");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "No se pudo preparar la validación de la cuenta.".to_string())?;
    let response = client
        .get(endpoint)
        .header("apikey", &publishable_key)
        .bearer_auth(&access_token)
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

    verify_active_status(&client, &project_origin, &publishable_key, &access_token).await?;

    let mut profile_endpoint =
        reqwest::Url::parse(&format!("{project_origin}/rest/v1/profiles"))
            .map_err(|_| "No se pudo preparar la validación del perfil.".to_string())?;
    profile_endpoint
        .query_pairs_mut()
        .append_pair(
            "select",
            "id,full_name,phone,role,can_assign_events,can_publish_announcements",
        )
        .append_pair("id", &format!("eq.{user_id}"));
    let profile_response = client
        .get(profile_endpoint)
        .header("apikey", &publishable_key)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|_| "No se pudo confirmar el perfil con Supabase.".to_string())?;
    if !profile_response.status().is_success() {
        log::warn!(
            "Offline identity: Supabase did not confirm the profile (HTTP {}).",
            profile_response.status().as_u16()
        );
        return Err("Supabase no confirmó el perfil para el acceso offline.".to_string());
    }
    let profiles = profile_response
        .json::<Vec<OfflineAuthorizationProfile>>()
        .await
        .map_err(|_| "Supabase devolvió un perfil no válido.".to_string())?;
    if profiles.len() != 1
        || profiles[0].id != user_id
        || !matches!(profiles[0].role.as_str(), "administrador" | "empleado")
    {
        log::warn!("Offline identity: Supabase returned a missing or invalid profile.");
        return Err("Supabase no confirmó un perfil válido para el acceso offline.".to_string());
    }
    let mut authorization = profiles.into_iter().next().ok_or_else(|| {
        "Supabase no confirmó un perfil válido para el acceso offline.".to_string()
    })?;
    if authorization.role == "administrador" {
        authorization.can_assign_events = true;
        authorization.can_publish_announcements = true;
        authorization.can_manage_resources = Some(true);
    } else {
        authorization.can_manage_resources = match fetch_resource_permission(
            &client,
            &project_origin,
            &publishable_key,
            &access_token,
        )
        .await
        {
            Ok(allowed) => Some(allowed),
            Err(error) => {
                log::warn!("Offline identity: resource permission was not cached ({error}).");
                None
            }
        };
    }

    verify_active_status(&client, &project_origin, &publishable_key, &access_token).await?;

    let identity = OfflineIdentity {
        user_id: verified_user.id,
        email: verified_user.email,
        project_origin,
        authorization: Some(authorization),
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
pub fn load_offline_identity(
    app: AppHandle,
    supabase_url: String,
) -> Result<Option<OfflineIdentityStatus>, String> {
    let project_origin = project_origin(&supabase_url)?;
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
    let identity = serde_json::from_slice::<OfflineIdentity>(&plaintext).map_err(|_| {
        log::warn!("Offline identity: protected marker has an invalid data format.");
        "La identidad local guardada no es válida.".to_string()
    })?;
    if identity.user_id.is_empty() {
        log::warn!("Offline identity: protected marker has an empty account identifier.");
        return Err("La identidad local guardada no es válida.".to_string());
    }
    if !identity.project_origin.is_empty() && identity.project_origin != project_origin {
        log::warn!("Offline identity: protected marker belongs to a different Supabase project.");
        return Ok(None);
    }
    let locks = read_suspension_locks(&suspension_locks_path(&app)?)?;
    let status = OfflineIdentityStatus {
        id: identity.user_id.clone(),
        email: identity.email.clone(),
        suspended: account_is_suspended(&locks, &project_origin, &identity.user_id),
        authorization: if identity.project_origin == project_origin {
            identity.authorization
        } else {
            None
        },
    };
    log::info!("Offline identity: protected marker loaded successfully.");
    Ok(Some(status))
}

#[tauri::command]
pub fn is_offline_account_suspended(
    app: AppHandle,
    user_id: String,
    supabase_url: String,
) -> Result<bool, String> {
    if !is_uuid(&user_id) {
        return Err("La cuenta local no es válida.".to_string());
    }
    let origin = project_origin(&supabase_url)?;
    let locks = read_suspension_locks(&suspension_locks_path(&app)?)?;
    Ok(account_is_suspended(&locks, &origin, &user_id))
}

#[tauri::command]
pub async fn set_offline_account_suspension(
    app: AppHandle,
    user_id: String,
    supabase_url: String,
    suspended: bool,
    access_token: Option<String>,
    publishable_key: Option<String>,
) -> Result<(), String> {
    if !is_uuid(&user_id) {
        return Err("La cuenta local no es válida.".to_string());
    }
    let origin = project_origin(&supabase_url)?;
    if !suspended {
        let access_token = access_token
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "El servidor debe confirmar la reactivación.".to_string())?;
        let publishable_key = publishable_key
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "El servidor debe confirmar la reactivación.".to_string())?;
        verify_active_account(&supabase_url, &publishable_key, &access_token, &user_id).await?;
    }

    set_offline_account_suspension_inner(app, user_id, origin, suspended)
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

fn suspension_locks_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join(SUSPENSION_LOCKS_FILE))
        .map_err(|_| {
            log::warn!("Offline suspension: Tauri could not resolve the local data directory.");
            "No se pudo determinar el almacenamiento local seguro.".to_string()
        })
}

fn project_origin(supabase_url: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(supabase_url)
        .map_err(|_| "La dirección del servicio no es válida.".to_string())?;
    let local_development_host = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local_development_host))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("La dirección del servicio no es válida.".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

fn read_suspension_locks(path: &PathBuf) -> Result<SuspensionLocks, String> {
    let encrypted = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SuspensionLocks::default());
        }
        Err(error) => {
            log::warn!(
                "Offline suspension: could not read the protected lock list ({:?}).",
                error.kind()
            );
            return Err("No se pudo leer el bloqueo local protegido.".to_string());
        }
    };
    let plaintext = unprotect_for_current_user(&encrypted)?;
    serde_json::from_slice::<SuspensionLocks>(&plaintext).map_err(|_| {
        log::warn!("Offline suspension: protected lock list has an invalid data format.");
        "El bloqueo local guardado no es válido.".to_string()
    })
}

fn write_suspension_locks(path: &PathBuf, locks: &SuspensionLocks) -> Result<(), String> {
    let plaintext = serde_json::to_vec(locks)
        .map_err(|_| "No se pudo preparar el bloqueo local.".to_string())?;
    let encrypted = protect_for_current_user(&plaintext)?;
    let directory = path
        .parent()
        .ok_or_else(|| "No se pudo determinar el directorio de datos.".to_string())?;
    fs::create_dir_all(directory).map_err(|error| {
        log::warn!(
            "Offline suspension: could not create the local data directory ({:?}).",
            error.kind()
        );
        "No se pudo preparar el almacenamiento local seguro.".to_string()
    })?;
    let temp_path = path.with_extension("dpapi.tmp");
    fs::write(&temp_path, encrypted).map_err(|error| {
        log::warn!(
            "Offline suspension: could not write the temporary protected lock list ({:?}).",
            error.kind()
        );
        "No se pudo guardar el bloqueo local de forma segura.".to_string()
    })?;

    let stored_bytes = fs::read(&temp_path).map_err(|error| {
        log::warn!(
            "Offline suspension: could not read back the temporary protected lock list ({:?}).",
            error.kind()
        );
        "No se pudo confirmar el guardado del bloqueo local.".to_string()
    })?;
    let stored_plaintext = unprotect_for_current_user(&stored_bytes)?;
    let stored_locks =
        serde_json::from_slice::<SuspensionLocks>(&stored_plaintext).map_err(|_| {
            log::warn!(
                "Offline suspension: saved lock list could not be decoded during read-back."
            );
            "No se pudo confirmar el formato del bloqueo local.".to_string()
        })?;
    let expected = serde_json::to_value(locks)
        .map_err(|_| "No se pudo confirmar el bloqueo local.".to_string())?;
    let actual = serde_json::to_value(stored_locks)
        .map_err(|_| "No se pudo confirmar el bloqueo local.".to_string())?;
    if actual != expected {
        log::warn!("Offline suspension: saved lock list did not match the confirmed state.");
        return Err("No se pudo confirmar el bloqueo local guardado.".to_string());
    }
    fs::rename(&temp_path, path).map_err(|error| {
        log::warn!(
            "Offline suspension: could not replace the protected lock list ({:?}).",
            error.kind()
        );
        "No se pudo guardar el bloqueo local de forma segura.".to_string()
    })?;
    Ok(())
}

fn account_is_suspended(locks: &SuspensionLocks, project_origin: &str, user_id: &str) -> bool {
    locks
        .entries
        .iter()
        .any(|entry| entry.project_origin == project_origin && entry.user_id == user_id)
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

async fn verify_active_account(
    supabase_url: &str,
    publishable_key: &str,
    access_token: &str,
    user_id: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "No se pudo preparar la validación de la reactivación.".to_string())?;
    let origin = project_origin(supabase_url)?;
    let identity_response = client
        .get(format!("{origin}/auth/v1/user"))
        .header("apikey", publishable_key)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| "No se pudo confirmar la reactivación con Supabase.".to_string())?;
    if !identity_response.status().is_success() {
        return Err("Supabase no confirmó la identidad para reactivar el acceso.".to_string());
    }
    let verified_user = identity_response
        .json::<SupabaseUser>()
        .await
        .map_err(|_| "Supabase devolvió una identidad no válida.".to_string())?;
    if verified_user.id != user_id {
        return Err("La identidad confirmada no coincide con la cuenta local.".to_string());
    }

    verify_active_status(&client, &origin, publishable_key, access_token).await
}

async fn verify_active_status(
    client: &reqwest::Client,
    origin: &str,
    publishable_key: &str,
    access_token: &str,
) -> Result<(), String> {
    let status_response = client
        .post(format!("{origin}/rest/v1/rpc/agenda_account_is_active_v1"))
        .header("apikey", publishable_key)
        .bearer_auth(access_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| "No se pudo confirmar el estado activo con Supabase.".to_string())?;
    if !status_response.status().is_success() {
        return Err("Supabase no confirmó que la cuenta esté activa.".to_string());
    }
    match status_response.json::<bool>().await {
        Ok(true) => Ok(()),
        Ok(false) => Err("Supabase no confirmó que la cuenta esté activa.".to_string()),
        Err(_) => Err("Supabase devolvió un estado de cuenta no válido.".to_string()),
    }
}

async fn fetch_resource_permission(
    client: &reqwest::Client,
    origin: &str,
    publishable_key: &str,
    access_token: &str,
) -> Result<bool, String> {
    let response = client
        .post(format!("{origin}/rest/v1/rpc/can_manage_resources"))
        .header("apikey", publishable_key)
        .bearer_auth(access_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| "No se pudo confirmar el permiso de Recursos.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Supabase devolvió HTTP {} al confirmar el permiso de Recursos.",
            response.status().as_u16()
        ));
    }
    response
        .json::<bool>()
        .await
        .map_err(|_| "Supabase devolvió un permiso de Recursos no válido.".to_string())
}

fn set_offline_account_suspension_inner(
    app: AppHandle,
    user_id: String,
    origin: String,
    suspended: bool,
) -> Result<(), String> {
    let path = suspension_locks_path(&app)?;
    let mut locks = read_suspension_locks(&path)?;
    locks
        .entries
        .retain(|entry| entry.project_origin != origin || entry.user_id != user_id);
    if suspended {
        locks.entries.push(SuspensionLock {
            project_origin: origin,
            user_id,
        });
    }
    write_suspension_locks(&path, &locks)
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
    use super::{
        OfflineAuthorizationProfile, OfflineIdentity, SuspensionLock, SuspensionLocks,
        account_is_suspended,
    };

    #[test]
    fn identity_uses_frontend_field_name_and_reads_legacy_marker() {
        let identity = OfflineIdentity {
            user_id: "user-123".to_string(),
            email: Some("user@example.test".to_string()),
            project_origin: String::new(),
            authorization: None,
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
        assert!(decoded.authorization.is_none());
    }

    #[test]
    fn authorization_snapshot_preserves_project_and_verified_permissions() {
        let identity = OfflineIdentity {
            user_id: "00000000-0000-4000-8000-000000000001".to_string(),
            email: Some("admin@example.test".to_string()),
            project_origin: "https://test-project.supabase.co".to_string(),
            authorization: Some(OfflineAuthorizationProfile {
                id: "00000000-0000-4000-8000-000000000001".to_string(),
                full_name: "Test Admin".to_string(),
                phone: None,
                role: "administrador".to_string(),
                can_assign_events: true,
                can_publish_announcements: true,
                can_manage_resources: Some(true),
            }),
        };
        let serialized = serde_json::to_value(&identity).expect("identity should serialize");
        assert_eq!(
            serialized["project_origin"],
            "https://test-project.supabase.co"
        );
        assert_eq!(serialized["authorization"]["can_manage_resources"], true);
        let decoded: OfflineIdentity =
            serde_json::from_value(serialized).expect("authorization snapshot should decode");
        assert_eq!(decoded, identity);
    }

    #[test]
    fn suspension_locks_are_scoped_to_account_and_project() {
        let locks = SuspensionLocks {
            entries: vec![SuspensionLock {
                project_origin: "https://test.supabase.co".to_string(),
                user_id: "user-a".to_string(),
            }],
        };

        assert!(account_is_suspended(
            &locks,
            "https://test.supabase.co",
            "user-a"
        ));
        assert!(!account_is_suspended(
            &locks,
            "https://test.supabase.co",
            "user-b"
        ));
        assert!(!account_is_suspended(
            &locks,
            "https://production.supabase.co",
            "user-a"
        ));
    }
}
