//! Platform durability barriers.

use crate::Result;
use std::fs::File;

#[cfg(target_os = "macos")]
pub(crate) fn sync_dirty_file(file: &File) -> Result<()> {
    file.sync_data()?;
    rustix::fs::fcntl_fullfsync(file).map_err(std::io::Error::from)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn sync_dirty_file(file: &File) -> Result<()> {
    file.sync_data()?;
    Ok(())
}
