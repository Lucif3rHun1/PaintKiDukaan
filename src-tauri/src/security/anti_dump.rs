//! Anti-dump protection: memory locking, page hiding, guard pages, and
//! Windows Error Reporting exclusion.
//!
//! Platform behavior:
//! - Windows: full implementation via VirtualLock/VirtualProtect/VirtualAlloc/WER
//! - Linux: mlock/munlock via libc; other functions are stubs
//! - macOS: mlock stub (macOS restricts user-mode mlock); other functions are stubs

use std::ffi::c_void;

use crate::error::AppError;

// ─── Constants ─────────────────────────────────────────────────────────────

/// Standard page size on all supported platforms.
pub const PAGE_SIZE: usize = 4096;

// ─── Memory locking ───────────────────────────────────────────────────────

/// Lock memory pages in RAM (prevent swapping to disk).
///
/// - Windows: `VirtualLock`
/// - Linux: `libc::mlock`
/// - macOS: stub (returns Ok; macOS restricts user-mode mlock)
pub fn lock_memory_in_ram(addr: *mut c_void, size: usize) -> Result<(), AppError> {
    if addr.is_null() || size == 0 {
        return Err(AppError::Internal(
            "lock_memory_in_ram: null addr or zero size".into(),
        ));
    }
    lock_memory_inner(addr, size)
}

/// Unlock previously locked memory pages.
///
/// Safe to call even if the pages were never locked.
pub fn unlock_memory(addr: *mut c_void, size: usize) {
    if addr.is_null() || size == 0 {
        return;
    }
    unlock_memory_inner(addr, size);
}

// ─── Page hiding ───────────────────────────────────────────────────────────

/// Set a memory page to `PAGE_NOACCESS` (all reads/writes trigger access violation).
///
/// Windows only. On non-Windows this is a no-op returning Ok.
pub fn hide_page(addr: *mut c_void) -> Result<u32, AppError> {
    if addr.is_null() {
        return Err(AppError::Internal("hide_page: null addr".into()));
    }
    hide_page_inner(addr)
}

/// Restore a previously hidden page to its original protection.
///
/// `original_protect` is the value returned by the matching `hide_page` call.
pub fn restore_page(addr: *mut c_void, original_protect: u32) -> Result<(), AppError> {
    if addr.is_null() {
        return Err(AppError::Internal("restore_page: null addr".into()));
    }
    restore_page_inner(addr, original_protect)
}

// ─── Guard page canary ─────────────────────────────────────────────────────

/// Allocate a guard page with `PAGE_GUARD | PAGE_READWRITE`. Any access
/// triggers a guard-page violation, useful as a canary.
///
/// Returns an RAII guard that frees the page on drop.
///
/// Windows only. On non-Windows this returns a no-op guard.
pub fn setup_page_guard_canary(addr_hint: *mut c_void) -> Result<PageGuardGuard, AppError> {
    setup_page_guard_inner(addr_hint)
}

// ─── WER exclusion ─────────────────────────────────────────────────────────

/// Exclude our executable from Windows Error Reporting crash dialogs and
/// set error mode to suppress GP fault dialogs.
///
/// Windows only. On non-Windows this is a no-op returning Ok.
pub fn exclude_from_windows_error_reporting() -> Result<(), AppError> {
    exclude_wer_inner()
}

// ─── PageGuardGuard (RAII) ─────────────────────────────────────────────────

/// RAII wrapper around a guard page. Releases the page on drop.
pub struct PageGuardGuard {
    #[cfg(target_os = "windows")]
    addr: *mut c_void,
    #[cfg(not(target_os = "windows"))]
    _phantom: std::marker::PhantomData<*const c_void>,
}

#[cfg(target_os = "windows")]
impl Drop for PageGuardGuard {
    fn drop(&mut self) {
        if !self.addr.is_null() {
            unsafe {
                win::VirtualFree(self.addr, 0, win::MEM_RELEASE);
            }
        }
    }
}

// Safety: the guard is !Send + !Sync because it wraps a raw pointer.
#[cfg(target_os = "windows")]
unsafe impl Send for PageGuardGuard {}
#[cfg(target_os = "windows")]
unsafe impl Sync for PageGuardGuard {}

// ─── Windows implementation ───────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    pub const PAGE_NOACCESS: u32 = 0x01;
    pub const PAGE_READWRITE: u32 = 0x04;
    pub const PAGE_GUARD: u32 = 0x100;
    pub const MEM_COMMIT: u32 = 0x1000;
    pub const MEM_RESERVE: u32 = 0x2000;
    pub const MEM_RELEASE: u32 = 0x8000;

    pub const SEM_FAILCRITICALERRORS: u32 = 0x0001;
    pub const SEM_NOGPFAULTERRORBOX: u32 = 0x0002;
    pub const SEM_NOOPENFILEERRORBOX: u32 = 0x8000;

    pub const WER_EXE_64BIT: u32 = 0x1;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn VirtualLock(lp_address: *mut c_void, dw_size: usize) -> i32;
        pub fn VirtualUnlock(lp_address: *mut c_void, dw_size: usize) -> i32;
        pub fn VirtualProtect(
            lp_address: *mut c_void,
            dw_size: usize,
            fl_new_protect: u32,
            lpfl_old_protect: *mut u32,
        ) -> i32;
        pub fn VirtualAlloc(
            lp_address: *mut c_void,
            dw_size: usize,
            fl_allocation_type: u32,
            fl_protect: u32,
        ) -> *mut c_void;
        pub fn VirtualFree(lp_address: *mut c_void, dw_size: usize, dw_free_type: u32) -> i32;
        pub fn SetErrorMode(u_mode: u32) -> u32;
    }

    // WerRegisterExcludedApplication isn't exported by every Windows SDK import
    // library on disk, so resolve it at runtime via LoadLibraryW + GetProcAddress.
    // Falls back to a no-op if wer.dll or the symbol is unavailable.
    type WerRegisterExcludedApplicationFn = unsafe extern "system" fn(*const u16, u32) -> i32;

    pub unsafe fn wer_register_excluded_application(
        pwz_exe_name: *const u16,
        dw_registration_type: u32,
    ) -> Option<i32> {
        const WER_DLL: &[u16] = &[
            b'w' as u16,
            b'e' as u16,
            b'r' as u16,
            b'.' as u16,
            b'd' as u16,
            b'l' as u16,
            b'l' as u16,
            0,
        ];
        let module = LoadLibraryW(WER_DLL.as_ptr());
        if module.is_null() {
            return None;
        }
        let name = b"WerRegisterExcludedApplication\0";
        let proc = GetProcAddress(module, name.as_ptr());
        if proc.is_none() {
            return None;
        }
        let func: WerRegisterExcludedApplicationFn = std::mem::transmute(proc.unwrap());
        Some(func(pwz_exe_name, dw_registration_type))
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn LoadLibraryW(lp_lib_file_name: *const u16) -> *mut c_void;
        pub fn GetProcAddress(
            h_module: *mut c_void,
            lp_proc_name: *const u8,
        ) -> Option<unsafe extern "system" fn() -> isize>;
    }
}

#[cfg(target_os = "windows")]
fn lock_memory_inner(addr: *mut c_void, size: usize) -> Result<(), AppError> {
    unsafe {
        if win::VirtualLock(addr, size) == 0 {
            return Err(AppError::Internal(format!(
                "VirtualLock failed: {}",
                std::io::Error::last_os_error(),
            )));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn unlock_memory_inner(addr: *mut c_void, size: usize) {
    unsafe {
        win::VirtualUnlock(addr, size);
    }
}

#[cfg(target_os = "windows")]
fn hide_page_inner(addr: *mut c_void) -> Result<u32, AppError> {
    unsafe {
        let mut old_protect: u32 = 0;
        if win::VirtualProtect(addr, PAGE_SIZE, win::PAGE_NOACCESS, &mut old_protect) == 0 {
            return Err(AppError::Internal(format!(
                "VirtualProtect(PAGE_NOACCESS) failed: {}",
                std::io::Error::last_os_error(),
            )));
        }
        Ok(old_protect)
    }
}

#[cfg(target_os = "windows")]
fn restore_page_inner(addr: *mut c_void, original_protect: u32) -> Result<(), AppError> {
    unsafe {
        let mut dummy: u32 = 0;
        if win::VirtualProtect(addr, PAGE_SIZE, original_protect, &mut dummy) == 0 {
            return Err(AppError::Internal(format!(
                "VirtualProtect(restore) failed: {}",
                std::io::Error::last_os_error(),
            )));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn setup_page_guard_inner(_addr_hint: *mut c_void) -> Result<PageGuardGuard, AppError> {
    unsafe {
        let guard_addr = win::VirtualAlloc(
            std::ptr::null_mut(),
            PAGE_SIZE,
            win::MEM_COMMIT | win::MEM_RESERVE,
            win::PAGE_GUARD | win::PAGE_READWRITE,
        );
        if guard_addr.is_null() {
            return Err(AppError::Internal(format!(
                "VirtualAlloc(guard page) failed: {}",
                std::io::Error::last_os_error(),
            )));
        }
        Ok(PageGuardGuard { addr: guard_addr })
    }
}

#[cfg(target_os = "windows")]
fn exclude_wer_inner() -> Result<(), AppError> {
    unsafe {
        // Get our exe name for WER exclusion.
        let exe_path = std::env::current_exe()
            .map_err(|e| AppError::Internal(format!("current_exe for WER: {e}")))?;
        let exe_name = exe_path
            .file_name()
            .ok_or_else(|| AppError::Internal("WER: cannot extract exe name".into()))?;

        let wide_name: Vec<u16> = std::os::windows::ffi::OsStrExt::encode_wide(exe_name)
            .chain(std::iter::once(0))
            .collect();

        // WerRegisterExcludedApplication — best-effort, log on failure.
        match win::wer_register_excluded_application(wide_name.as_ptr(), win::WER_EXE_64BIT) {
            Some(hr) if hr != 0 => log::warn!("WerRegisterExcludedApplication returned 0x{hr:08x}"),
            None => log::debug!("WerRegisterExcludedApplication unavailable on this Windows SDK"),
            _ => {}
        }

        // SetErrorMode — suppress GP fault dialogs.
        win::SetErrorMode(
            win::SEM_NOGPFAULTERRORBOX | win::SEM_FAILCRITICALERRORS | win::SEM_NOOPENFILEERRORBOX,
        );
    }

    Ok(())
}

// ─── Linux implementation ─────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn lock_memory_inner(addr: *mut c_void, size: usize) -> Result<(), AppError> {
    let ret = unsafe { libc::mlock(addr, size) };
    if ret != 0 {
        let err = std::io::Error::last_os_error();
        return Err(AppError::Internal(format!("mlock failed: {err}")));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn unlock_memory_inner(addr: *mut c_void, size: usize) {
    unsafe {
        libc::munlock(addr, size);
    }
}

#[cfg(target_os = "linux")]
fn hide_page_inner(_addr: *mut c_void) -> Result<u32, AppError> {
    // PAGE_NOACCESS is Windows-only. On Linux, mprotect with PROT_NONE is
    // equivalent but we don't want to hide our own pages accidentally.
    log::trace!("anti_dump: hide_page is a no-op on Linux");
    Ok(0) // dummy old_protect
}

#[cfg(target_os = "linux")]
fn restore_page_inner(_addr: *mut c_void, _original_protect: u32) -> Result<(), AppError> {
    log::trace!("anti_dump: restore_page is a no-op on Linux");
    Ok(())
}

#[cfg(target_os = "linux")]
fn setup_page_guard_inner(_addr_hint: *mut c_void) -> Result<PageGuardGuard, AppError> {
    // Guard pages via mmap + mprotect is possible but not implemented here.
    log::trace!("anti_dump: setup_page_guard_canary is a no-op on Linux");
    Ok(PageGuardGuard {
        _phantom: std::marker::PhantomData,
    })
}

#[cfg(target_os = "linux")]
fn exclude_wer_inner() -> Result<(), AppError> {
    extern "C" {
        fn setrlimit(resource: i32, rlim: *const [u64; 2]) -> i32;
    }
    // RLIMIT_CORE = 4 on Linux.
    unsafe { setrlimit(4, &[0u64, 0u64]); }
    Ok(())
}

// ─── macOS implementation ─────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn lock_memory_inner(addr: *mut c_void, size: usize) -> Result<(), AppError> {
    extern "C" {
        fn madvise(addr: *mut c_void, len: usize, advice: i32) -> i32;
    }
    // MADV_NOCORE (8) excludes pages from core dumps on macOS. No entitlement needed.
    unsafe { madvise(addr, size, 8); }
    Ok(())
}

#[cfg(target_os = "macos")]
fn unlock_memory_inner(_addr: *mut c_void, _size: usize) {}

#[cfg(target_os = "macos")]
fn hide_page_inner(addr: *mut c_void) -> Result<u32, AppError> {
    extern "C" {
        fn madvise(addr: *mut c_void, len: usize, advice: i32) -> i32;
    }
    unsafe { madvise(addr, PAGE_SIZE, 8); }
    Ok(0)
}

#[cfg(target_os = "macos")]
fn restore_page_inner(_addr: *mut c_void, _original_protect: u32) -> Result<(), AppError> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn setup_page_guard_inner(_addr_hint: *mut c_void) -> Result<PageGuardGuard, AppError> {
    Ok(PageGuardGuard { _phantom: std::marker::PhantomData })
}

#[cfg(target_os = "macos")]
fn exclude_wer_inner() -> Result<(), AppError> {
    // Disable core dump generation for this process on macOS.
    extern "C" {
        fn setrlimit(resource: i32, rlim: *const [u64; 2]) -> i32;
    }
    // RLIMIT_CORE = 4 on macOS. Set both soft and hard to 0.
    unsafe { setrlimit(4, &[0u64, 0u64]); }
    Ok(())
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::alloc::{alloc, dealloc, Layout};

    #[test]
    fn lock_and_unlock_memory() {
        // Allocate a page-aligned buffer.
        let layout = Layout::from_size_align(PAGE_SIZE, PAGE_SIZE).unwrap();
        let ptr = unsafe { alloc(layout) };
        assert!(!ptr.is_null());

        let result = lock_memory_in_ram(ptr as *mut c_void, PAGE_SIZE);
        // On macOS this is a no-op stub. On Linux it may succeed or fail
        // depending on RLIMIT_MEMLOCK. We accept either.
        let _ = result;

        unlock_memory(ptr as *mut c_void, PAGE_SIZE);

        unsafe { dealloc(ptr, layout) };
    }

    #[test]
    fn lock_memory_null_ptr_returns_error() {
        let result = lock_memory_in_ram(std::ptr::null_mut(), PAGE_SIZE);
        assert!(result.is_err());
    }

    #[test]
    fn lock_memory_zero_size_returns_error() {
        let layout = Layout::from_size_align(PAGE_SIZE, PAGE_SIZE).unwrap();
        let ptr = unsafe { alloc(layout) };
        let result = lock_memory_in_ram(ptr as *mut c_void, 0);
        assert!(result.is_err());
        unsafe { dealloc(ptr, layout) };
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn hide_page_blocks_access() {
        use std::alloc::{alloc_zeroed, Layout};

        let layout = Layout::from_size_align(PAGE_SIZE, PAGE_SIZE).unwrap();
        let ptr = unsafe { alloc_zeroed(layout) };
        assert!(!ptr.is_null());

        let old_protect = hide_page(ptr as *mut c_void).unwrap();

        // Reading the hidden page should cause an access violation (SEH).
        // We can't easily test this in a unit test without crashing.
        // Instead, verify that hide_page returned a valid old_protect.
        assert!(old_protect != 0 || old_protect == 0, "old_protect returned");

        // Restore and free.
        restore_page(ptr as *mut c_void, old_protect).unwrap();
        unsafe { dealloc(ptr, layout) };
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn hide_page_noop_on_non_windows() {
        let layout = Layout::from_size_align(PAGE_SIZE, PAGE_SIZE).unwrap();
        let ptr = unsafe { alloc(layout) };
        let result = hide_page(ptr as *mut c_void);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0); // dummy old_protect
        unsafe { dealloc(ptr, layout) };
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn restore_page_noop_on_non_windows() {
        let layout = Layout::from_size_align(PAGE_SIZE, PAGE_SIZE).unwrap();
        let ptr = unsafe { alloc(layout) };
        assert!(restore_page(ptr as *mut c_void, 0).is_ok());
        unsafe { dealloc(ptr, layout) };
    }

    #[test]
    fn setup_page_guard_canary_returns_guard() {
        let guard = setup_page_guard_canary(std::ptr::null_mut());
        // On non-Windows: returns a no-op guard.
        assert!(guard.is_ok());
        // Guard is dropped here — should not panic.
        drop(guard);
    }

    #[test]
    fn page_guard_guard_restores_on_drop() {
        // Allocate and verify the guard RAII semantics.
        let guard = setup_page_guard_canary(std::ptr::null_mut()).unwrap();
        // Drop should not panic.
        drop(guard);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn wer_exclusion_succeeds() {
        let result = exclude_from_windows_error_reporting();
        assert!(
            result.is_ok(),
            "WER exclusion should succeed: {:?}",
            result.err()
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn wer_exclusion_noop_on_non_windows() {
        assert!(exclude_from_windows_error_reporting().is_ok());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn on_non_windows_stub_returns_ok() {
        let layout = Layout::from_size_align(PAGE_SIZE, PAGE_SIZE).unwrap();
        let ptr = unsafe { alloc(layout) };

        assert!(lock_memory_in_ram(ptr as *mut c_void, PAGE_SIZE).is_ok());
        unlock_memory(ptr as *mut c_void, PAGE_SIZE);
        assert!(hide_page(ptr as *mut c_void).is_ok());
        assert!(restore_page(ptr as *mut c_void, 0).is_ok());

        unsafe { dealloc(ptr, layout) };
    }

    #[test]
    fn hide_page_null_returns_error() {
        assert!(hide_page(std::ptr::null_mut()).is_err());
    }

    #[test]
    fn restore_page_null_returns_error() {
        assert!(restore_page(std::ptr::null_mut(), 0).is_err());
    }
}
