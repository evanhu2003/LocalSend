use crate::crypto;
use bytes::Bytes;
use futures_util::stream::{Stream, StreamExt};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::Request;
use sha2::{Digest, Sha256};
use std::future::Future;
use std::path::PathBuf;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// Channel capacity for file upload chunks (provides backpressure).
const UPLOAD_CHANNEL_CAPACITY: usize = 16;

/// Size of the write buffer that coalesces incoming body chunks (typically one
/// TLS record, ~16 KiB) into larger file writes.
const WRITE_BUFFER_SIZE: usize = 512 * 1024;

/// After this many bytes the file writer flushes and syncs the file, making
/// everything written so far durable: the `committed` offset an interrupted
/// transfer can be resumed from.
pub(crate) const SYNC_INTERVAL: u64 = 16 * 1024 * 1024;

/// Where the content of an uploaded file should go, decided by the application.
#[derive(Debug)]
pub enum FileUploadTarget {
    /// The application consumes the binary chunks itself.
    ///
    /// The server forwards chunks into `binary_tx` and closes it at end of file.
    /// The application should compare the number of received bytes with `file.size`
    /// and report the result on the sender side of `result_rx` which determines
    /// the HTTP response (200 on `Ok`, 500 on `Err` or when the sender is dropped).
    ///
    /// Note: the checksum is only verified after the application reported its
    /// result, so a checksum mismatch is not observable by the application here
    /// (unlike [FileUploadTarget::Path] and [FileUploadTarget::Fd]).
    ///
    /// Resuming is not supported for this target: the upload always starts at 0.
    Stream {
        /// Channel the server sends the binary chunks of the file into.
        binary_tx: mpsc::Sender<Bytes>,

        /// Channel on which the application reports whether the file was
        /// processed successfully.
        result_rx: oneshot::Receiver<Result<(), String>>,
    },

    /// The server writes the file to this path and reports the result on
    /// `result_tx`.
    ///
    /// With `offset` 0 the file is created or truncated. Otherwise the file
    /// must already exist: it is cut to `offset` bytes and the upload is
    /// appended (resuming an interrupted transfer).
    ///
    /// Timestamps provided in the sender's file metadata are applied to the
    /// written file, so the application does not need to set them itself.
    Path {
        /// The path to write the file to.
        path: PathBuf,

        /// The number of bytes of the file already present at `path`.
        offset: u64,

        /// Channel on which the server reports whether the file was saved
        /// successfully, including the checksum verification if one was given.
        result_tx: oneshot::Sender<Result<(), String>>,

        /// Optional channel on which the server reports the progress.
        /// Events are dropped when the channel is full.
        progress_tx: Option<mpsc::Sender<UploadProgress>>,
    },

    /// The server writes the file to this raw file descriptor (Android only)
    /// and reports the result on `result_tx`.
    ///
    /// With an `offset` above 0 the descriptor must be readable, writable and
    /// seekable (the SAF "rw" mode): it is cut to `offset` bytes and the
    /// upload is appended.
    ///
    /// Timestamps provided in the sender's file metadata are applied through
    /// the descriptor, which also covers SAF documents that have no path.
    #[cfg(target_os = "android")]
    Fd {
        /// The raw file descriptor to write the file to.
        /// Ownership is transferred; the descriptor is closed after writing.
        fd: std::os::fd::RawFd,

        /// The number of bytes of the file already present in the descriptor.
        offset: u64,

        /// Channel on which the server reports whether the file was saved
        /// successfully, including the checksum verification if one was given.
        result_tx: oneshot::Sender<Result<(), String>>,

        /// Optional channel on which the server reports the progress.
        /// Events are dropped when the channel is full.
        progress_tx: Option<mpsc::Sender<UploadProgress>>,
    },
}

/// Progress of a file being written, as absolute positions in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadProgress {
    /// Bytes of the file written so far (including the resumed offset).
    pub written: u64,

    /// Bytes of the file that are durably stored: an interrupted transfer
    /// can be resumed from here.
    pub committed: u64,
}

/// The sender-provided timestamps of an uploaded file, applied to the written
/// file for [FileUploadTarget::Path] and [FileUploadTarget::Fd].
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct FileTimestamps {
    pub modified: Option<std::time::SystemTime>,
    pub accessed: Option<std::time::SystemTime>,
}

impl FileTimestamps {
    fn is_empty(&self) -> bool {
        self.modified.is_none() && self.accessed.is_none()
    }
}

/// Outcome of receiving an uploaded file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SaveResult {
    /// The file has been received and, if a checksum was given, it matched.
    Success,

    /// The body could not be read or the target failed to process it.
    Failed,

    /// The received bytes do not match the expected SHA-256 checksum.
    HashMismatch,
}

/// Outcome of receiving an uploaded file, with the resumable position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SaveOutcome {
    pub result: SaveResult,

    /// Bytes of the file durably stored by the target. After a failure, the
    /// next attempt may resume from here. Always 0 for
    /// [FileUploadTarget::Stream].
    pub committed: u64,
}

/// Forwards the body of `req` to `target`, see [save_stream_to_target].
pub(crate) async fn save_req_to_target(
    req: Request<Incoming>,
    target: FileUploadTarget,
    file_size: u64,
    expected_sha256: Option<&str>,
    verify_prefix: bool,
    timestamps: FileTimestamps,
    abort: CancellationToken,
) -> SaveOutcome {
    // Data frames of the body; other frames (e.g. trailers) are skipped.
    let body = futures_util::stream::unfold(req.into_body(), |mut body| async move {
        loop {
            match body.frame().await? {
                Ok(frame) => {
                    if let Ok(data) = frame.into_data() {
                        return Some((Ok(data), body));
                    }
                }
                Err(err) => return Some((Err(format!("{err:#}")), body)),
            }
        }
    });

    save_stream_to_target(
        Box::pin(body),
        target,
        file_size,
        expected_sha256,
        verify_prefix,
        timestamps,
        abort,
    )
    .await
}

/// Forwards the `body` chunks of an uploaded file to `target`.
///
/// `file_size` is the size of the complete file. For targets with an offset,
/// `body` carries the bytes from that offset on.
///
/// `expected_sha256` is the checksum of the complete file. When resuming
/// (offset above 0), it is only verified if `verify_prefix` is set: the bytes
/// before the offset are then read back from the target to hash them.
///
/// Cancelling `abort` ends the transfer like a dropped connection.
pub(crate) async fn save_stream_to_target(
    mut body: impl Stream<Item = Result<Bytes, String>> + Unpin,
    target: FileUploadTarget,
    file_size: u64,
    expected_sha256: Option<&str>,
    verify_prefix: bool,
    timestamps: FileTimestamps,
    abort: CancellationToken,
) -> SaveOutcome {
    // Resolve the target into a chunk sender and the way the result arrives.
    // For [FileUploadTarget::Path] and [FileUploadTarget::Fd], the application's
    // result channel is answered by this function once the complete outcome
    // (including the checksum verification) is known.
    let (binary_tx, sink) = match target {
        FileUploadTarget::Stream {
            binary_tx,
            result_rx,
        } => (binary_tx, Sink::Application { result_rx }),
        FileUploadTarget::Path {
            path,
            offset,
            result_tx,
            progress_tx,
        } => {
            let open = async move {
                let mut options = tokio::fs::OpenOptions::new();
                match offset {
                    0 => options.write(true).create(true).truncate(true),
                    _ => options.read(true).write(true),
                };
                options
                    .open(&path)
                    .await
                    .map_err(|e| format!("Failed to open {}: {e}", path.display()))
            };
            let (binary_tx, outcome_rx) = spawn_file_writer(
                open,
                WriterSettings {
                    offset,
                    expected_size: file_size,
                    hash: expected_sha256.is_some() && (offset == 0 || verify_prefix),
                },
                progress_tx,
                timestamps,
            );
            (
                binary_tx,
                Sink::Writer {
                    outcome_rx,
                    app_result_tx: result_tx,
                },
            )
        }
        #[cfg(target_os = "android")]
        FileUploadTarget::Fd {
            fd,
            offset,
            result_tx,
            progress_tx,
        } => {
            let open = async move {
                use std::os::fd::FromRawFd;

                // SAFETY: the descriptor is owned by this transfer; wrapping it in
                // a File transfers that ownership so it is closed once writing finishes.
                let std_file = unsafe { std::fs::File::from_raw_fd(fd) };
                Ok(tokio::fs::File::from_std(std_file))
            };
            let (binary_tx, outcome_rx) = spawn_file_writer(
                open,
                WriterSettings {
                    offset,
                    expected_size: file_size,
                    hash: expected_sha256.is_some() && (offset == 0 || verify_prefix),
                },
                progress_tx,
                timestamps,
            );
            (
                binary_tx,
                Sink::Writer {
                    outcome_rx,
                    app_result_tx: result_tx,
                },
            )
        }
    };

    // The application consumes the chunks itself, so they are hashed here.
    let mut stream_hasher = match (&sink, expected_sha256) {
        (Sink::Application { .. }, Some(_)) => Some(Sha256::new()),
        _ => None,
    };

    // Forward the body to the target.
    let mut stream_error = false;
    loop {
        let next = tokio::select! {
            biased;
            _ = abort.cancelled() => {
                tracing::info!("Upload aborted");
                stream_error = true;
                break;
            }
            next = body.next() => next,
        };
        match next {
            None => break,
            Some(Ok(data)) => {
                if data.is_empty() {
                    continue;
                }
                if let Some(hasher) = &mut stream_hasher {
                    hasher.update(&data);
                }
                if binary_tx.send(data).await.is_err() {
                    // The receiver is gone (dropped by the application or
                    // closed by the file writer after an error).
                    stream_error = true;
                    break;
                }
            }
            Some(Err(err)) => {
                tracing::warn!("Error reading upload body of file: {err}");
                stream_error = true;
                break;
            }
        }
    }

    // Signal end of file to the receiving side.
    drop(binary_tx);

    match sink {
        Sink::Application { result_rx } => {
            if stream_error {
                return failed(0);
            }
            match result_rx.await {
                Ok(Ok(())) => (),
                Ok(Err(err)) => {
                    tracing::warn!("Failed to process file: {err}");
                    return failed(0);
                }
                Err(_) => return failed(0),
            }
            if let (Some(hasher), Some(expected)) = (stream_hasher, expected_sha256) {
                let actual = crypto::hash::to_hex(&hasher.finalize());
                if !actual.eq_ignore_ascii_case(expected) {
                    tracing::warn!("Checksum mismatch: expected {expected}, got {actual}");
                    return SaveOutcome {
                        result: SaveResult::HashMismatch,
                        committed: 0,
                    };
                }
            }
            SaveOutcome {
                result: SaveResult::Success,
                committed: file_size,
            }
        }
        Sink::Writer {
            outcome_rx,
            app_result_tx,
        } => {
            let outcome = outcome_rx.await.unwrap_or(WriterOutcome {
                result: Err("File writer stopped".to_string()),
                committed: 0,
                sha256: None,
            });

            // `error` carries the reason for the application.
            let (result, error): (SaveResult, Option<String>) = match (stream_error, outcome.result) {
                (true, Err(err)) => (SaveResult::Failed, Some(err)),
                (true, Ok(())) => (SaveResult::Failed, Some("Upload aborted".to_string())),
                (false, Err(err)) => {
                    tracing::warn!("Failed to process file: {err}");
                    (SaveResult::Failed, Some(err))
                }
                (false, Ok(())) => match (outcome.sha256, expected_sha256) {
                    (Some(actual), Some(expected)) if !actual.eq_ignore_ascii_case(expected) => {
                        tracing::warn!("Checksum mismatch: expected {expected}, got {actual}");
                        (SaveResult::HashMismatch, Some("Checksum mismatch".to_string()))
                    }
                    _ => (SaveResult::Success, None),
                },
            };

            let _ = app_result_tx.send(match error {
                None => Ok(()),
                Some(err) => Err(err),
            });

            SaveOutcome {
                result,
                committed: outcome.committed,
            }
        }
    }
}

fn failed(committed: u64) -> SaveOutcome {
    SaveOutcome {
        result: SaveResult::Failed,
        committed,
    }
}

/// How the result of a file upload is obtained.
enum Sink {
    /// The application consumes the chunks and reports the result itself.
    Application {
        result_rx: oneshot::Receiver<Result<(), String>>,
    },

    /// The server's file writer stores the chunks; its outcome is forwarded
    /// to the application.
    Writer {
        outcome_rx: oneshot::Receiver<WriterOutcome>,
        app_result_tx: oneshot::Sender<Result<(), String>>,
    },
}

struct WriterSettings {
    /// Bytes already present in the file, kept as they are.
    offset: u64,

    /// Size of the complete file.
    expected_size: u64,

    /// Whether to hash the complete file, reading back the first `offset`
    /// bytes.
    hash: bool,
}

struct WriterOutcome {
    result: Result<(), String>,

    /// Bytes of the file that are durably stored.
    committed: u64,

    /// Hex SHA-256 of the complete file, when requested and complete.
    sha256: Option<String>,
}

/// Spawns a task that writes incoming chunks to a file provided by `open`.
///
/// Returns the sender for the binary chunks and a receiver for the outcome.
fn spawn_file_writer(
    open: impl Future<Output = Result<tokio::fs::File, String>> + Send + 'static,
    settings: WriterSettings,
    progress_tx: Option<mpsc::Sender<UploadProgress>>,
    timestamps: FileTimestamps,
) -> (mpsc::Sender<Bytes>, oneshot::Receiver<WriterOutcome>) {
    let (binary_tx, mut binary_rx) = mpsc::channel::<Bytes>(UPLOAD_CHANNEL_CAPACITY);
    let (internal_tx, internal_rx) = oneshot::channel::<WriterOutcome>();

    tokio::spawn(async move {
        let outcome =
            write_file_from_receiver(open, settings, &mut binary_rx, progress_tx, timestamps).await;
        // Unblock the request handler if it is still sending chunks.
        binary_rx.close();
        let _ = internal_tx.send(outcome);
    });

    (binary_tx, internal_rx)
}

/// Writes all chunks received on `rx` to the file provided by `open`, after
/// the first `settings.offset` bytes that are already present.
///
/// Fails if the total number of written bytes does not match
/// `settings.expected_size` (e.g. the sender disconnected mid-transfer). In
/// that case everything received is still made durable and the file is cut to
/// that length, so the transfer can be resumed from the reported `committed`.
///
/// A complete file is truncated to its size, so that a target that pointed at
/// a longer, pre-existing file cannot keep a tail of the old content.
///
/// The sender-provided `timestamps` are applied to the completely written
/// file. This happens on the still-open handle: an Android file descriptor has
/// no path to address the file by afterwards.
async fn write_file_from_receiver(
    open: impl Future<Output = Result<tokio::fs::File, String>>,
    settings: WriterSettings,
    rx: &mut mpsc::Receiver<Bytes>,
    progress_tx: Option<mpsc::Sender<UploadProgress>>,
    timestamps: FileTimestamps,
) -> WriterOutcome {
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};

    let WriterSettings {
        offset,
        expected_size,
        hash,
    } = settings;
    let fail = |error: String, committed: u64| WriterOutcome {
        result: Err(error),
        committed,
        sha256: None,
    };

    if offset > expected_size {
        return fail(format!("Offset {offset} beyond the file size {expected_size}"), 0);
    }

    let mut file = match open.await {
        Ok(file) => file,
        Err(err) => return fail(err, 0),
    };

    let mut hasher = hash.then(Sha256::new);
    if offset > 0 {
        // Read back the bytes that are kept, so the complete file is hashed.
        if let Some(hasher) = &mut hasher {
            if let Err(e) = hash_prefix(&mut file, offset, hasher).await {
                return fail(format!("Failed to read the received part: {e}"), 0);
            }
        }
        // Drop anything beyond the offset (e.g. bytes that were written but
        // not committed before an interruption) and continue at the offset.
        if let Err(e) = file.set_len(offset).await {
            return fail(format!("Failed to cut the file to {offset} bytes: {e}"), 0);
        }
        if let Err(e) = file.seek(std::io::SeekFrom::Start(offset)).await {
            return fail(format!("Failed to continue at {offset}: {e}"), 0);
        }
    }

    let report = |written: u64, committed: u64| {
        if let Some(progress_tx) = &progress_tx {
            // Progress is best-effort: drop the event when the consumer lags.
            let _ = progress_tx.try_send(UploadProgress { written, committed });
        }
    };

    let mut file = tokio::io::BufWriter::with_capacity(WRITE_BUFFER_SIZE, file);
    let mut written = offset;
    let mut committed = offset;
    let mut since_sync: u64 = 0;
    let mut error: Option<String> = None;
    while let Some(chunk) = rx.recv().await {
        let len = chunk.len() as u64;
        if written + len > expected_size {
            error = Some(format!(
                "Expected {expected_size} bytes, received at least {}",
                written + len
            ));
            break;
        }
        if let Err(e) = file.write_all(&chunk).await {
            error = Some(format!("Failed to write file: {e}"));
            break;
        }
        if let Some(hasher) = &mut hasher {
            hasher.update(&chunk);
        }
        written += len;
        since_sync += len;
        if since_sync >= SYNC_INTERVAL {
            since_sync = 0;
            match sync(&mut file).await {
                Ok(()) => committed = written,
                Err(e) => {
                    error = Some(e);
                    break;
                }
            }
        }
        report(written, committed);
    }

    // Make everything received durable, also after an error or interruption.
    match sync(&mut file).await {
        Ok(()) => committed = written,
        Err(e) => {
            error.get_or_insert(e);
        }
    }
    let file = file.into_inner();

    if error.is_none() && written != expected_size {
        error = Some(format!("Expected {expected_size} bytes, received {written}"));
    }
    if let Some(error) = error {
        // Bytes beyond `committed` may be incomplete; resuming starts there.
        if let Err(e) = file.set_len(committed).await {
            tracing::warn!("Could not cut the partial file to {committed} bytes: {e}");
        }
        report(written.min(committed), committed);
        return fail(error, committed);
    }
    report(written, committed);

    // Drops content beyond the file that was just written, in case the target
    // pointed at a longer, pre-existing file: opening truncates for paths and
    // for descriptors opened with the SAF "wt" mode, but a document provider is
    // free to ignore that mode. Retries of the same upload are covered by the
    // exact size check above either way.
    //
    // Best-effort: a provider may back the descriptor by something that cannot
    // be truncated (e.g. a pipe), which must not fail the completed transfer.
    if let Err(e) = file.set_len(written).await {
        tracing::warn!("Could not truncate file to {written} bytes: {e}");
    }

    // The timestamps are applied last because the writes and the truncation
    // above update the modification time themselves.
    //
    // Best-effort: the provider backing an Android file descriptor may not
    // support changing timestamps, which must not fail the completed transfer.
    if !timestamps.is_empty() {
        let mut times = std::fs::FileTimes::new();
        if let Some(modified) = timestamps.modified {
            times = times.set_modified(modified);
        }
        if let Some(accessed) = timestamps.accessed {
            times = times.set_accessed(accessed);
        }
        let file = file.into_std().await;
        // Also closes the file, off the async runtime like tokio::fs does.
        let result = tokio::task::spawn_blocking(move || file.set_times(times)).await;
        if let Ok(Err(e)) = result {
            tracing::warn!("Could not set file timestamps: {e}");
        }
    }

    WriterOutcome {
        result: Ok(()),
        committed,
        sha256: hasher.map(|hasher| crypto::hash::to_hex(&hasher.finalize())),
    }
}

/// Feeds the first `len` bytes of `file` into `hasher`.
async fn hash_prefix(
    file: &mut tokio::fs::File,
    len: u64,
    hasher: &mut Sha256,
) -> std::io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    file.seek(std::io::SeekFrom::Start(0)).await?;
    let mut remaining = len;
    let mut buffer = vec![0u8; WRITE_BUFFER_SIZE];
    while remaining > 0 {
        let want = remaining.min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..want]).await?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                format!("the file is shorter than {len} bytes"),
            ));
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(())
}

/// Flushes the buffer and makes the written data durable.
async fn sync(file: &mut tokio::io::BufWriter<tokio::fs::File>) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {e}"))?;
    // Best-effort: a descriptor may be backed by something that cannot be
    // synced (e.g. a pipe). The data was handed to the OS either way.
    if let Err(e) = file.get_ref().sync_data().await {
        tracing::debug!("Could not sync file: {e}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream::{self, StreamExt};
    use sha2::{Digest, Sha256};

    fn temp_file(content: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("localsend-save-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, content).unwrap();
        path
    }

    fn body(chunks: Vec<&'static [u8]>) -> impl Stream<Item = Result<Bytes, String>> + Unpin {
        stream::iter(chunks.into_iter().map(|c| Ok(Bytes::from_static(c))))
    }

    fn path_target(
        path: &std::path::Path,
        offset: u64,
        progress_tx: Option<mpsc::Sender<UploadProgress>>,
    ) -> (FileUploadTarget, oneshot::Receiver<Result<(), String>>) {
        let (result_tx, result_rx) = oneshot::channel();
        (
            FileUploadTarget::Path {
                path: path.to_path_buf(),
                offset,
                result_tx,
                progress_tx,
            },
            result_rx,
        )
    }

    fn sha256_hex(data: &[u8]) -> String {
        crypto::hash::to_hex(&Sha256::digest(data))
    }

    #[tokio::test]
    async fn test_writer_resumes_at_offset() {
        let path = temp_file(b"hello world");
        let (target, _result_rx) = path_target(&path, 6, None);

        let outcome = save_stream_to_target(
            body(vec![b"there"]),
            target,
            11,
            None,
            false,
            FileTimestamps::default(),
            CancellationToken::new(),
        )
        .await;

        assert_eq!(outcome.result, SaveResult::Success);
        assert_eq!(outcome.committed, 11);
        assert_eq!(std::fs::read(&path).unwrap(), b"hello there");
    }

    #[tokio::test]
    async fn test_writer_truncates_tail_beyond_offset() {
        let path = temp_file(&[7u8; 20]);
        let (target, _result_rx) = path_target(&path, 5, None);

        let outcome = save_stream_to_target(
            body(vec![b"abc"]),
            target,
            8,
            None,
            false,
            FileTimestamps::default(),
            CancellationToken::new(),
        )
        .await;

        assert_eq!(outcome.result, SaveResult::Success);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 8);
        assert_eq!(&std::fs::read(&path).unwrap()[5..], b"abc");
    }

    #[tokio::test]
    async fn test_writer_hashes_prefix_when_resuming() {
        let expected = sha256_hex(b"hello there");

        let path = temp_file(b"hello world");
        let (target, _result_rx) = path_target(&path, 6, None);
        let outcome = save_stream_to_target(
            body(vec![b"there"]),
            target,
            11,
            Some(&expected),
            true,
            FileTimestamps::default(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(outcome.result, SaveResult::Success);

        // The prefix on disk was tampered with: the whole file no longer matches.
        let path = temp_file(b"jello world");
        let (target, _result_rx) = path_target(&path, 6, None);
        let outcome = save_stream_to_target(
            body(vec![b"there"]),
            target,
            11,
            Some(&expected),
            true,
            FileTimestamps::default(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(outcome.result, SaveResult::HashMismatch);
    }

    #[tokio::test]
    async fn test_writer_reports_committed_on_abort() {
        let path = temp_file(b"");
        let (target, _result_rx) = path_target(&path, 0, None);
        let first: Vec<u8> = vec![1u8; (SYNC_INTERVAL + 100) as usize];
        let chunks = stream::iter(vec![Ok(Bytes::from(first))]).chain(stream::pending());
        let abort = CancellationToken::new();
        tokio::spawn({
            let abort = abort.clone();
            async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                abort.cancel();
            }
        });

        let outcome = save_stream_to_target(
            Box::pin(chunks),
            target,
            SYNC_INTERVAL * 2,
            None,
            false,
            FileTimestamps::default(),
            abort,
        )
        .await;

        assert_eq!(outcome.result, SaveResult::Failed);
        let len = std::fs::metadata(&path).unwrap().len();
        assert_eq!(outcome.committed, len);
        assert!(outcome.committed >= SYNC_INTERVAL, "committed {}", outcome.committed);
    }

    #[tokio::test]
    async fn test_writer_progress_is_absolute() {
        let path = temp_file(&[0u8; 100]);
        let (progress_tx, mut progress_rx) = mpsc::channel(16);
        let (target, _result_rx) = path_target(&path, 100, Some(progress_tx));

        let outcome = save_stream_to_target(
            body(vec![b"0123456789"]),
            target,
            110,
            None,
            false,
            FileTimestamps::default(),
            CancellationToken::new(),
        )
        .await;

        assert_eq!(outcome.result, SaveResult::Success);
        let first = progress_rx.recv().await.expect("no progress event");
        assert!(first.written > 100, "written {}", first.written);
    }
}
