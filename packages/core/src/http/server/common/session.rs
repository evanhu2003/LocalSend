use crate::http::server::PeerIp;
use crate::model::transfer::FileDto;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// State of the single v2 upload session slot.
pub(crate) enum SessionStateV2 {
    /// A prepare-upload request is waiting for the application's decision.
    Pending(PendingSessionV2),

    /// An accepted upload session.
    Active(UploadSessionV2),
}

/// A prepare-upload request that is waiting for the application's decision.
///
/// Senders on protocol 2.0/2.1/2.2 do not know the session ID before the
/// prepare-upload response, so they cancel the pending request with a
/// session-less `POST /cancel` from the same address; `cancel` interrupts
/// the waiting request handler.
pub(crate) struct PendingSessionV2 {
    pub(crate) session_id: String,

    /// The IP address of the sender. Only this address may cancel the request.
    pub(crate) sender_ip: PeerIp,

    pub(crate) cancel: CancellationToken,
}

pub(crate) struct UploadSessionV2 {
    pub(crate) session_id: String,

    /// The IP address of the sender. Uploads are only accepted from this address.
    pub(crate) sender_ip: PeerIp,

    /// The accepted files, mapped by file ID.
    pub(crate) files: HashMap<String, SessionFileV2>,

    /// Whether both sides agreed to resumable uploads (TLS only).
    pub(crate) resumable: bool,

    /// The fingerprint of the sender's client certificate (TLS only).
    pub(crate) sender_cert_fingerprint: Option<String>,
}

impl UploadSessionV2 {
    /// Whether the client may upload to (or query, or cancel) this session.
    ///
    /// Resumable sessions are bound to the sender's certificate, so the
    /// sender may come back from another address; other sessions are bound
    /// to the sender's address.
    pub(crate) fn authorizes(&self, ip: &PeerIp, cert_fingerprint: Option<&str>) -> bool {
        match self.resumable {
            true => self.sender_cert_fingerprint.as_deref().is_some_and(|f| Some(f) == cert_fingerprint),
            false => self.sender_ip == *ip,
        }
    }

    /// Whether an unfinished file of this session is among `offered`
    /// (lowercase SHA-256 and size): a new request with it continues this
    /// session's work.
    pub(crate) fn continues_any(&self, offered: &std::collections::HashSet<(String, u64)>) -> bool {
        self.files.values().any(|file| {
            file.status != FileStatusV2::Finished
                && file
                    .dto
                    .sha256
                    .as_ref()
                    .is_some_and(|sha256| offered.contains(&(sha256.to_ascii_lowercase(), file.dto.size)))
        })
    }

    /// Ends the running uploads when the session is cancelled. The files of a
    /// resumable session are kept for a later transfer, which must not find
    /// a writer of this session still busy with them. Other sessions keep
    /// the original behavior: running uploads complete.
    pub(crate) fn abort_resumable_uploads(&self) {
        if self.resumable {
            for file in self.files.values() {
                file.abort.cancel();
            }
        }
    }

    /// Whether an upload request is currently running.
    pub(crate) fn is_busy(&self) -> bool {
        self.files.values().any(|file| file.status == FileStatusV2::InProgress)
    }

    /// Whether all files reached a final state.
    pub(crate) fn is_complete(&self) -> bool {
        self.files
            .values()
            .all(|file| matches!(file.status, FileStatusV2::Finished | FileStatusV2::Failed))
    }
}

pub(crate) struct SessionFileV2 {
    pub(crate) dto: FileDto,

    /// The file-specific token required for the upload request.
    pub(crate) token: String,

    pub(crate) status: FileStatusV2,

    /// Number of upload requests started for this file.
    /// Limits how often a checksum mismatch resets the file to
    /// [FileStatusV2::Pending] for a retry.
    pub(crate) attempts: u8,

    /// The number of bytes of this file the receiver holds durably, i.e. the
    /// offset the next upload of this file must start at. Always 0 unless the
    /// session is resumable.
    pub(crate) committed: u64,

    /// Cancelled to stop the running upload of this file (replaced for every
    /// attempt), e.g. when the sender reconnects while the old request is
    /// still open.
    pub(crate) abort: CancellationToken,

    /// Notified whenever an upload attempt of this file ended.
    pub(crate) settled: Arc<Notify>,

    /// The application discarded the received part while an upload was
    /// running: the attempt must not report its bytes as committed.
    pub(crate) reset_pending: bool,
}

impl SessionFileV2 {
    pub(crate) fn new(dto: FileDto, committed: u64) -> Self {
        Self {
            dto,
            token: uuid::Uuid::new_v4().to_string(),
            status: FileStatusV2::Pending,
            attempts: 0,
            committed,
            abort: CancellationToken::new(),
            settled: Arc::new(Notify::new()),
            reset_pending: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FileStatusV2 {
    Pending,
    InProgress,

    /// An upload of a resumable session broke off; the sender may continue
    /// at [SessionFileV2::committed].
    Interrupted,
    Finished,
    Failed,
}
