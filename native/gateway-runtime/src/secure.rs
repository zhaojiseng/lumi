//! OS-bound storage. No plaintext fallback; secrets never enter the routing config.
use std::{fs, path::Path};
use zeroize::Zeroizing;
#[derive(Debug, thiserror::Error)]
pub enum SecureError {
    #[error("系统安全存储不可用")]
    Unavailable,
    #[error("安全凭据读取或写入失败")]
    Io(#[from] std::io::Error),
    #[error("安全凭据损坏或不属于当前系统账户")]
    Invalid,
}
pub fn save(path: &Path, instance: &str, bytes: &[u8]) -> Result<(), SecureError> {
    #[cfg(windows)]
    {
        let encrypted = windows::protect(bytes)?;
        atomic_write(path, &encrypted)?;
        let _ = instance;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        security_framework::passwords::set_generic_password("ai.lumi.gateway", instance, bytes)
            .map_err(|_| SecureError::Unavailable)?;
        atomic_write(path, b"macos-keychain-v1")?;
        return Ok(());
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (path, instance, bytes);
        Err(SecureError::Unavailable)
    }
}
pub fn load(path: &Path, instance: &str) -> Result<Zeroizing<Vec<u8>>, SecureError> {
    #[cfg(windows)]
    {
        let _ = instance;
        let bytes = read_limited(path)?;
        windows::unprotect(&bytes).map(Zeroizing::new)
    }
    #[cfg(target_os = "macos")]
    {
        if read_limited(path)? != b"macos-keychain-v1" {
            return Err(SecureError::Invalid);
        }
        security_framework::passwords::get_generic_password("ai.lumi.gateway", instance)
            .map(Zeroizing::new)
            .map_err(|_| SecureError::Unavailable)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (path, instance);
        Err(SecureError::Unavailable)
    }
}
/// Remove both the protected marker/blob and its OS store entry; never read plaintext.
pub fn remove(path: &Path, instance: &str) -> Result<(), SecureError> {
    #[cfg(target_os = "macos")]
    {
        let _ = security_framework::passwords::delete_generic_password("ai.lumi.gateway", instance);
    }
    let _ = instance;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), SecureError> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    let result = (|| -> Result<(), std::io::Error> {
        std::io::Write::write_all(&mut file, bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.sync_all()?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp);
        return Err(error.into());
    }
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(error.into());
    }
    Ok(())
}
#[cfg(windows)]
mod windows {
    use super::SecureError;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    pub fn protect(bytes: &[u8]) -> Result<Vec<u8>, SecureError> {
        transform(bytes, true)
    }
    pub fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, SecureError> {
        transform(bytes, false)
    }
    fn transform(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, SecureError> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len().try_into().map_err(|_| SecureError::Invalid)?,
            pbData: bytes.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // DPAPI allocates output with LocalAlloc; copy then free on every successful path.
        let ok = unsafe {
            if encrypt {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if ok == 0 {
            return Err(SecureError::Unavailable);
        }
        let copied =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            if !encrypt {
                std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
            }
            LocalFree(output.pbData.cast());
        }
        Ok(copied)
    }
}

fn read_limited(path: &Path) -> Result<Vec<u8>, SecureError> {
    use std::io::Read;
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > 256 * 1024 {
        return Err(SecureError::Invalid);
    }
    let mut output = Vec::new();
    file.take(256 * 1024 + 1).read_to_end(&mut output)?;
    if output.len() > 256 * 1024 {
        return Err(SecureError::Invalid);
    }
    Ok(output)
}
