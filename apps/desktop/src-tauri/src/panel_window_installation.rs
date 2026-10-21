//! A built panel is usable only after its native focus/resize boundaries are installed.

pub(crate) fn finish_installation(
    installed: Result<(), String>,
    destroy: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if let Err(error) = installed {
        return match destroy() {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!(
                "{error}; could not destroy the failed panel: {cleanup}"
            )),
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_native_hooks_destroy_the_panel_and_report_open_failure() {
        let mut alive = true;
        let result = finish_installation(Err("resize overlay unavailable".into()), || {
            alive = false;
            Ok(())
        });
        assert!(!alive);
        assert_eq!(result, Err("resize overlay unavailable".into()));
    }

    #[test]
    fn successful_native_hooks_keep_the_panel() {
        assert_eq!(
            finish_installation(Ok(()), || panic!("must stay alive")),
            Ok(())
        );
    }

    #[test]
    fn cleanup_failure_is_reported_alongside_the_installation_failure() {
        let error =
            finish_installation(Err("hooks failed".into()), || Err("destroy failed".into()))
                .unwrap_err();
        assert!(error.contains("hooks failed"));
        assert!(error.contains("destroy failed"));
    }
}
