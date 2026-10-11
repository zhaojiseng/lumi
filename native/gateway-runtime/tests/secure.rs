//! Windows tests call real DPAPI under the current account with isolated fake data.
//! macOS Keychain tests are deliberately not run by these Windows regressions.
use lumi_gateway_runtime::secure::{self, SecureError};

#[cfg(windows)]
#[test]
fn dpapi_roundtrip_encrypts_fake_credentials_without_any_plaintext_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.secure");
    let instance = format!("test-{}", uuid::Uuid::new_v4());
    let bytes = br#"{"recordKey":"fake-record-encryption-key-marker","routes":[{"clientKey":"fake-client-key-marker","upstreamKey":"fake-upstream-key-marker"}]}"#;
    secure::save(&path, &instance, bytes).unwrap();
    assert_eq!(secure::load(&path, &instance).unwrap().as_slice(), bytes);
    let encrypted = std::fs::read(&path).unwrap();
    assert_ne!(encrypted, bytes);
    for entry in std::fs::read_dir(directory.path()).unwrap() {
        let file = std::fs::read(entry.unwrap().path()).unwrap();
        for marker in [
            "fake-record-encryption-key-marker",
            "fake-client-key-marker",
            "fake-upstream-key-marker",
        ] {
            assert!(
                !file
                    .windows(marker.len())
                    .any(|window| window == marker.as_bytes())
            );
        }
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn dpapi_uses_randomized_ciphertext_and_overwrite_roundtrips() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first.secure");
    let second = directory.path().join("second.secure");
    let bytes = b"fake-randomized-dpapi-credential";
    secure::save(&first, "randomized-test", bytes).unwrap();
    secure::save(&second, "randomized-test", bytes).unwrap();
    assert_ne!(
        std::fs::read(&first).unwrap(),
        std::fs::read(&second).unwrap()
    );
    assert_eq!(
        secure::load(&first, "randomized-test").unwrap().as_slice(),
        bytes
    );
    assert_eq!(
        secure::load(&second, "randomized-test").unwrap().as_slice(),
        bytes
    );
    let replacement = b"replacement-fake-credential";
    secure::save(&first, "randomized-test", replacement).unwrap();
    assert_eq!(
        secure::load(&first, "randomized-test").unwrap().as_slice(),
        replacement
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
}

#[cfg(windows)]
#[test]
fn corrupt_tampered_and_truncated_dpapi_blobs_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("invalid.secure");
    for bytes in [
        b"not-a-dpapi-blob".as_slice(),
        b"".as_slice(),
        b"macos-keychain-v1".as_slice(),
    ] {
        std::fs::write(&path, bytes).unwrap();
        assert!(secure::load(&path, "invalid-test").is_err());
    }
    secure::save(&path, "invalid-test", b"fake-encrypted-credential").unwrap();
    let original = std::fs::read(&path).unwrap();
    let mut tampered = original.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    std::fs::write(&path, tampered).unwrap();
    assert!(secure::load(&path, "invalid-test").is_err());
    std::fs::write(&path, &original[..original.len() / 2]).unwrap();
    assert!(secure::load(&path, "invalid-test").is_err());
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn oversized_protected_file_is_rejected_before_os_decryption() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("oversized.secure");
    std::fs::write(&path, vec![0u8; 256 * 1024 + 1]).unwrap();
    assert!(matches!(
        secure::load(&path, "size-limit-test"),
        Err(SecureError::Invalid)
    ));
}

#[cfg(windows)]
#[test]
fn unavailable_files_and_directory_targets_do_not_fall_back_to_plaintext() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("missing.secure");
    assert!(matches!(
        secure::load(&missing, "missing-test"),
        Err(SecureError::Io(_))
    ));
    assert!(
        secure::save(
            directory.path(),
            "directory-test",
            b"fake-no-fallback-secret"
        )
        .is_err()
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[cfg(not(any(windows, target_os = "macos")))]
#[test]
fn unsupported_os_requires_secure_storage_without_creating_plaintext() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credentials.secure");
    assert!(matches!(
        secure::save(&path, "unsupported-test", b"fake-credential"),
        Err(SecureError::Unavailable)
    ));
    assert!(matches!(
        secure::load(&path, "unsupported-test"),
        Err(SecureError::Unavailable)
    ));
    assert!(!path.exists());
}
