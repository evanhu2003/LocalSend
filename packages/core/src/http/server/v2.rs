use crate::http::dto_v2::{
    InfoResponseDtoV2, PrepareUploadRequestDtoV2, PrepareUploadResponseDtoV2, RegisterDtoV2,
    RegisterResponseDtoV2, UploadOffsetResponseDtoV2, RESUME_SUPPORT_VERSION,
};
use crate::http::server::common::collect_to_json::CollectToJson;
use crate::http::server::common::error::AppError;
use crate::http::server::common::pin::check_pin;
use crate::http::server::common::query::parse_query;
use crate::http::server::common::response::{empty_body, BoxedBody, JsonResponse};
use crate::http::server::common::save::{FileTimestamps, FileUploadTarget, SaveOutcome, SaveResult};
use crate::http::server::common::session::{
    FileStatusV2, PendingSessionV2, SessionFileV2, SessionStateV2, UploadSessionV2,
};
use crate::http::server::PeerIp;
use crate::http::server::{common, AppState, RequestClientInfo, V2State};
use crate::model::discovery::PROTOCOL_VERSION_V2;
use crate::model::transfer::FileDto;
use crate::util::filename;
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Events emitted by the v2 HTTP server that must be handled by the application.
#[derive(Debug)]
pub enum ServerEventV2 {
    /// A device registered itself via `POST /api/localsend/v2/register`.
    ///
    /// On TLS, this event is only emitted when `info.fingerprint` matches the
    /// SHA-256 fingerprint of the client certificate verified during the mTLS
    /// handshake, so the fingerprint cannot be spoofed.
    Register {
        /// The IP address of the remote device.
        ip: PeerIp,

        /// The device information sent by the remote device.
        info: RegisterDtoV2,
    },

    /// A sender requests to upload files via `POST /api/localsend/v2/prepare-upload`.
    ///
    /// The application must answer on `decision_tx`.
    /// Dropping `decision_tx` results in a 500 response.
    PrepareUpload {
        /// The session ID the upload session will have when the request is
        /// accepted. Pre-generated so the application can track the session
        /// consistently from the start.
        session_id: String,

        /// The IP address of the sender.
        ip: PeerIp,

        /// The device information of the sender.
        info: RegisterDtoV2,

        /// The SHA-256 fingerprint (uppercase hex) of the sender's client
        /// certificate verified during the mTLS handshake. Unlike
        /// `info.fingerprint`, this value cannot be spoofed.
        /// `None` when the server runs without TLS.
        cert_fingerprint: Option<String>,

        /// The offered files, mapped by file ID.
        files: HashMap<String, FileDto>,

        /// Whether the session will be resumable: the sender announced
        /// `resumeSupport` and the connection is authenticated by a client
        /// certificate. Only then are offsets of
        /// [PrepareUploadDecisionV2::AcceptWithOffsets] applied.
        resumable: bool,

        /// Channel to send the decision (accept all, a subset, or decline).
        decision_tx: oneshot::Sender<PrepareUploadDecisionV2>,
    },

    /// An accepted file is being uploaded via `POST /api/localsend/v2/upload`.
    ///
    /// The application must answer on `target_tx` with where the file content
    /// should go (a stream to consume itself, a path, or a file descriptor).
    /// Dropping `target_tx` results in a 500 response.
    FileUpload {
        /// The session ID of the upload session.
        session_id: String,

        /// The ID of the file being uploaded.
        file_id: String,

        /// The metadata of the file being uploaded.
        file: FileDto,

        /// The number of bytes of the file the upload starts at: the bytes
        /// before were received earlier (resumed upload) and must be kept.
        /// The target must use this offset. Always 0 unless the session is
        /// resumable.
        offset: u64,

        /// Channel to send the target the file content should be written to.
        target_tx: oneshot::Sender<FileUploadTarget>,
    },

    /// An upload of a resumable session broke off. The session stays active:
    /// the sender may continue the file at `committed` bytes.
    FileInterrupted {
        session_id: String,
        file_id: String,

        /// The number of bytes of the file durably stored.
        committed: u64,
    },

    /// An upload session ended.
    SessionEnd {
        /// The session ID of the ended session.
        session_id: String,

        /// Why the session ended.
        reason: SessionEndReasonV2,
    },

    /// A prepare-upload request was aborted before a session was created,
    /// e.g. the sender disconnected while the application was still deciding.
    /// The `decision_tx` of the [ServerEventV2::PrepareUpload] with the same
    /// session ID is dead; answering it has no effect.
    PrepareUploadAborted {
        /// The session ID of the aborted prepare-upload request.
        session_id: String,
    },

    /// `POST /api/localsend/v2/cancel` was received for a session this server
    /// does not manage. This happens when the remote device cancels a transfer
    /// that this application is currently *sending* to it: the session ID is
    /// the one issued by the remote device during prepare-upload.
    ///
    /// The application must verify that `ip` matches the target of the
    /// send session before cancelling it.
    CancelReceived {
        /// The IP address of the remote device requesting the cancellation.
        ip: PeerIp,

        /// The session ID as known by the remote device.
        session_id: String,
    },

    /// The listening socket failed permanently, e.g. because the OS
    /// invalidated it while the application was suspended (iOS reclaims the
    /// sockets of suspended apps). The server has stopped itself; the
    /// application must restart it to become reachable again.
    ListenerFailed {
        /// Description of the failure.
        error: String,
    },
}

/// The application's decision for a prepare-upload request.
#[derive(Debug)]
pub enum PrepareUploadDecisionV2 {
    /// Accept the given file IDs (a subset of the offered files).
    /// An empty set responds with 204 (no file transfer needed).
    Accept(HashSet<String>),

    /// Like [PrepareUploadDecisionV2::Accept], additionally telling the sender
    /// how many bytes of a file the application already holds (from an
    /// earlier, interrupted transfer). Offsets are ignored unless the session
    /// is resumable, and offsets beyond a file's size count as 0.
    AcceptWithOffsets {
        file_ids: HashSet<String>,
        offsets: HashMap<String, u64>,
    },

    /// Decline the request (403).
    Decline,
}

/// Why an upload session ended.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionEndReasonV2 {
    /// All accepted files reached a final state (finished or failed).
    Finished,

    /// The sender cancelled the session via `POST /api/localsend/v2/cancel`.
    Cancelled,

    /// A resumable session waited too long for its sender to come back
    /// ([crate::http::server::ServerConfigV2::resume_idle_timeout]).
    /// Unfinished files failed.
    IdleTimeout,

    /// The sender of a resumable session started a new session (e.g. after
    /// its application restarted). Unfinished files failed.
    Superseded,
}

pub(crate) async fn register(
    body: Incoming,
    state: AppState,
    client_info: RequestClientInfo,
) -> Result<JsonResponse<RegisterResponseDtoV2>, AppError> {
    let payload = body.collect_to_json::<RegisterDtoV2>().await?;

    // On TLS, only trust registrations whose claimed fingerprint is proven
    // by the client certificate of the mTLS handshake.
    let fingerprint_valid = match client_info.cert_fingerprint() {
        Some(cert_fingerprint) => payload.fingerprint.to_ascii_uppercase() == cert_fingerprint,
        None => true,
    };

    if let Some(v2) = &state.v2 {
        if fingerprint_valid {
            // Not awaited: registrations arrive in bursts (every device on the
            // network answers an announcement, and a peer scanning its subnet
            // registers with everyone), so the channel fills up easily. Waiting
            // would block this request handler — and every later one — until
            // the application catches up, which is what makes the device stop
            // answering `register` altogether.
            //
            // The event carries no responder, and peers repeat their
            // announcement, so a dropped registration is recoverable.
            if let Err(err) = v2.event_tx.try_send(ServerEventV2::Register {
                ip: client_info.ip,
                info: payload,
            }) {
                tracing::debug!("Dropped a register event: {err}");
            }
        } else {
            tracing::warn!(
                "Ignoring register from {}: claimed fingerprint does not match the client certificate",
                client_info.ip
            );
        }
    }

    let info = state.info.lock().await.clone();
    let download = state.web.share.download().is_some();

    Ok(JsonResponse {
        status: StatusCode::OK,
        body: RegisterResponseDtoV2 {
            alias: info.alias,
            version: PROTOCOL_VERSION_V2.to_string(),
            device_model: info.device_model,
            device_type: info.device_type,
            fingerprint: info.token,
            download,
        },
    })
}

pub(crate) async fn info(state: AppState) -> Result<JsonResponse<InfoResponseDtoV2>, AppError> {
    let info = state.info.lock().await.clone();
    let download = state.web.share.download().is_some();

    Ok(JsonResponse {
        status: StatusCode::OK,
        body: InfoResponseDtoV2 {
            alias: info.alias,
            version: PROTOCOL_VERSION_V2.to_string(),
            device_model: info.device_model,
            device_type: info.device_type,
            fingerprint: info.token,
            download,
        },
    })
}

pub(crate) async fn prepare_upload(
    req: Request<Incoming>,
    state: AppState,
    client_info: RequestClientInfo,
) -> Result<Response<BoxedBody>, AppError> {
    let v2 = require_v2(&state)?;
    let query = parse_query(req.uri().query());

    check_pin(
        v2.pin.as_deref(),
        &v2.pin_attempts,
        &query,
        client_info.ip.ip,
    )
    .await?;

    let mut payload = req
        .into_body()
        .collect_to_json::<PrepareUploadRequestDtoV2>()
        .await?;

    if payload.files.is_empty() {
        return Err(AppError::BadRequest("No files provided".to_string()));
    }

    // Senders on macOS send NFD names (e.g. Korean as separate jamo). Normalize
    // once here so every consumer (UI, history, save path) sees NFC.
    for file in payload.files.values_mut() {
        file.file_name = filename::normalize(&file.file_name);
    }

    let session_id = Uuid::new_v4().to_string();
    let cancelled = CancellationToken::new();

    // Resuming is bound to the sender's certificate; without TLS the claimed
    // identity could be spoofed by anyone on the network.
    let sender_cert_fingerprint = client_info.cert_fingerprint();
    let resumable = v2.resume_enabled
        && sender_cert_fingerprint.is_some()
        && payload
            .resume_support
            .is_some_and(|version| version >= RESUME_SUPPORT_VERSION);

    // The files of this request a waiting session of the sender may hold.
    let offered: HashSet<(String, u64)> = payload
        .files
        .values()
        .filter_map(|file| {
            file.sha256
                .as_ref()
                .map(|sha256| (sha256.to_ascii_lowercase(), file.size))
        })
        .collect();
    let busy = || {
        AppError::Message(
            StatusCode::CONFLICT,
            "Blocked by another session".to_string(),
        )
    };

    // Claim the single session slot.
    let deadline = tokio::time::Instant::now() + STALE_UPLOAD_TIMEOUT;
    let superseded = loop {
        enum Claim {
            Free,
            Supersede(String),
            WaitFor(Arc<tokio::sync::Notify>),
            Busy,
        }

        let mut slot = v2.session.lock().await;
        let claim = match slot.as_ref() {
            None => Claim::Free,
            // The sender of a resumable session is back with a new request
            // for the same work (e.g. its application restarted): that
            // session is over. Any other request of it is just busy, so an
            // unrelated message does not end a transfer.
            Some(SessionStateV2::Active(session))
                if resumable
                    && session.resumable
                    && session.sender_cert_fingerprint == sender_cert_fingerprint
                    && session.continues_any(&offered) =>
            {
                // Uploads still running belong to dead connections. Their
                // writers must be done with the files before the new session
                // continues them.
                let mut running = None;
                for file in session.files.values() {
                    if file.status == FileStatusV2::InProgress {
                        file.abort.cancel();
                        running.get_or_insert_with(|| file.settled.clone());
                    }
                }
                match running {
                    Some(settled) => Claim::WaitFor(settled),
                    None => Claim::Supersede(session.session_id.clone()),
                }
            }
            Some(_) => Claim::Busy,
        };

        match claim {
            Claim::Busy => return Err(busy()),
            Claim::WaitFor(settled) => {
                // Registered while the session is locked, so the end of the
                // attempt (which needs the lock) cannot be missed.
                let notified = settled.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                drop(slot);
                if tokio::time::timeout_at(deadline, notified).await.is_err() {
                    return Err(busy());
                }
            }
            Claim::Free | Claim::Supersede(_) => {
                *slot = Some(SessionStateV2::Pending(PendingSessionV2 {
                    session_id: session_id.clone(),
                    sender_ip: client_info.ip,
                    cancel: cancelled.clone(),
                }));
                break match claim {
                    Claim::Supersede(old_session_id) => Some(old_session_id),
                    _ => None,
                };
            }
        }
    };
    if let Some(old_session_id) = superseded {
        tracing::info!("Upload session {old_session_id} superseded by {session_id}");
        let _ = v2
            .event_tx
            .send(ServerEventV2::SessionEnd {
                session_id: old_session_id,
                reason: SessionEndReasonV2::Superseded,
            })
            .await;
    }

    // Frees the slot again if this request is aborted before a session is created.
    let mut pending_guard = PendingSessionGuard::new(v2.clone(), session_id.clone());

    let (decision_tx, decision_rx) = oneshot::channel();
    let event = ServerEventV2::PrepareUpload {
        session_id: session_id.clone(),
        ip: client_info.ip,
        info: payload.info,
        cert_fingerprint: sender_cert_fingerprint.clone(),
        files: payload.files.clone(),
        resumable,
        decision_tx,
    };
    if v2.event_tx.send(event).await.is_err() {
        return Err(AppError::Status(StatusCode::INTERNAL_SERVER_ERROR));
    }

    // The sender may cancel the request while the application is deciding.
    // Returning with the guard still armed frees the slot and emits
    // [ServerEventV2::PrepareUploadAborted], like a dropped connection.
    let decision = tokio::select! {
        decision = decision_rx => {
            decision.map_err(|_| AppError::Status(StatusCode::INTERNAL_SERVER_ERROR))?
        }
        _ = cancelled.cancelled() => {
            return Err(AppError::Message(
                StatusCode::FORBIDDEN,
                "Cancelled by sender".to_string(),
            ));
        }
    };

    let (accepted_ids, offsets) = match decision {
        PrepareUploadDecisionV2::Decline => {
            pending_guard.clear().await;
            return Err(AppError::Message(
                StatusCode::FORBIDDEN,
                "Rejected".to_string(),
            ));
        }
        PrepareUploadDecisionV2::Accept(ids) => (ids, HashMap::new()),
        PrepareUploadDecisionV2::AcceptWithOffsets { file_ids, offsets } => (file_ids, offsets),
    };

    let files: HashMap<String, SessionFileV2> = payload
        .files
        .into_iter()
        .filter(|(id, _)| accepted_ids.contains(id))
        .map(|(id, dto)| {
            // Only files with a checksum can be continued: appending is only
            // safe when the complete file is verified afterwards.
            let committed = match resumable && dto.sha256.is_some() {
                true => offsets
                    .get(&id)
                    .copied()
                    .filter(|offset| *offset <= dto.size)
                    .unwrap_or(0),
                false => 0,
            };
            (id, SessionFileV2::new(dto, committed))
        })
        .collect();

    if files.is_empty() {
        // Nothing to transfer.
        pending_guard.clear().await;
        let mut res = Response::new(empty_body());
        *res.status_mut() = StatusCode::NO_CONTENT;
        return Ok(res);
    }

    let tokens: HashMap<String, String> = files
        .iter()
        .map(|(id, file)| (id.clone(), file.token.clone()))
        .collect();
    let resume_offsets: HashMap<String, u64> = files
        .iter()
        .filter(|(_, file)| file.committed > 0)
        .map(|(id, file)| (id.clone(), file.committed))
        .collect();

    {
        let mut slot = v2.session.lock().await;
        *slot = Some(SessionStateV2::Active(UploadSessionV2 {
            session_id: session_id.clone(),
            sender_ip: client_info.ip,
            files,
            resumable,
            sender_cert_fingerprint,
        }));
    }
    pending_guard.disarm();

    tracing::info!("Upload session created: {session_id} (resumable: {resumable})");
    if resumable {
        spawn_idle_watchdog(v2.clone(), session_id.clone());
    }

    Ok(JsonResponse {
        status: StatusCode::OK,
        body: PrepareUploadResponseDtoV2 {
            session_id,
            files: tokens,
            resume_support: resumable.then_some(RESUME_SUPPORT_VERSION),
            resume_offsets,
        },
    }
    .into_response())
}

pub(crate) async fn upload(
    req: Request<Incoming>,
    state: AppState,
    client_info: RequestClientInfo,
) -> Result<Response<BoxedBody>, AppError> {
    let v2 = require_v2(&state)?;
    let query = parse_query(req.uri().query());

    let (Some(session_id), Some(file_id), Some(token)) = (
        query.get("sessionId"),
        query.get("fileId"),
        query.get("token"),
    ) else {
        return Err(AppError::Message(
            StatusCode::BAD_REQUEST,
            "Missing parameters".to_string(),
        ));
    };
    let offset = match query.get("offset") {
        Some(offset) => offset
            .parse::<u64>()
            .map_err(|_| AppError::BadRequest("Invalid offset".to_string()))?,
        None => 0,
    };
    let session_id = session_id.clone();
    let file_id = file_id.clone();

    // Validate the request and mark the file as in progress.
    let (file_dto, resumable, abort) = {
        let mut slot = v2.session.lock().await;
        let Some(SessionStateV2::Active(session)) = slot.as_mut() else {
            return Err(invalid_token_error());
        };
        if session.session_id != session_id
            || !session.authorizes(&client_info.ip, client_info.cert_fingerprint().as_deref())
        {
            return Err(invalid_token_error());
        }
        let resumable = session.resumable;
        let Some(file) = session.files.get_mut(&file_id) else {
            return Err(invalid_token_error());
        };
        if file.token != *token
            || !matches!(file.status, FileStatusV2::Pending | FileStatusV2::Interrupted)
        {
            return Err(invalid_token_error());
        }
        if offset != file.committed {
            return Err(AppError::OffsetMismatch(file.committed));
        }
        file.status = FileStatusV2::InProgress;
        file.attempts = file.attempts.saturating_add(1);
        file.abort = CancellationToken::new();
        (file.dto.clone(), resumable, file.abort.clone())
    };

    // Ends the attempt (as failed or interrupted) if this request is dropped
    // before the file is saved.
    let mut upload_guard = UploadGuard::new(v2.clone(), session_id.clone(), file_id.clone(), offset);

    let file_size = file_dto.size;
    // Resumed files are always verified: appending to the wrong bytes must
    // not produce a file that looks complete.
    let expected_sha256 = match resumable || v2.verify_checksums {
        true => file_dto.sha256.clone(),
        false => None,
    };
    let verify_prefix = resumable && offset > 0 && expected_sha256.is_some();
    let timestamps = match &file_dto.metadata {
        Some(metadata) => FileTimestamps {
            modified: metadata.modified_time(),
            accessed: metadata.accessed_time(),
        },
        None => FileTimestamps::default(),
    };
    let (target_tx, target_rx) = oneshot::channel::<FileUploadTarget>();

    let event = ServerEventV2::FileUpload {
        session_id: session_id.clone(),
        file_id: file_id.clone(),
        file: file_dto,
        offset,
        target_tx,
    };
    let not_started = SaveOutcome {
        result: SaveResult::Failed,
        committed: offset,
    };
    if v2.event_tx.send(event).await.is_err() {
        upload_guard.finish(not_started).await;
        return Err(AppError::Status(StatusCode::INTERNAL_SERVER_ERROR));
    }

    let target = tokio::select! {
        biased;
        _ = abort.cancelled() => None,
        target = target_rx => target.ok(),
    };
    let Some(target) = target else {
        upload_guard.finish(not_started).await;
        return Err(AppError::Status(StatusCode::INTERNAL_SERVER_ERROR));
    };

    // Saving runs in its own task: even if this request handler is dropped
    // (the connection is gone), the attempt ends with the offset the target
    // actually committed, which a resumed upload continues at.
    let save = tokio::spawn(async move {
        let outcome = common::save::save_req_to_target(
            req,
            target,
            file_size,
            expected_sha256.as_deref(),
            verify_prefix,
            resumable,
            timestamps,
            abort,
        )
        .await;
        upload_guard.finish(outcome).await;
        outcome
    });
    let Ok(outcome) = save.await else {
        return Err(AppError::Status(StatusCode::INTERNAL_SERVER_ERROR));
    };

    match outcome.result {
        SaveResult::Success => Ok(Response::new(empty_body())),
        SaveResult::Failed => Err(AppError::Status(StatusCode::INTERNAL_SERVER_ERROR)),
        SaveResult::HashMismatch => Err(AppError::Message(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Checksum mismatch".to_string(),
        )),
    }
}

/// How long `upload-offset` waits for a still running upload of the file to
/// end after aborting it.
const STALE_UPLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// `POST /api/localsend/v2/upload-offset?sessionId=…&fileId=…&token=…`
/// (LocalSend fork extension): the offset the next upload of a file of a
/// resumable session must start at.
///
/// A sender only asks after its own upload broke off, so an upload of the
/// file that is still running here is a leftover of a dead connection: it is
/// aborted first, which commits what it received.
pub(crate) async fn upload_offset(
    req: Request<Incoming>,
    state: AppState,
    client_info: RequestClientInfo,
) -> Result<Response<BoxedBody>, AppError> {
    let v2 = require_v2(&state)?;
    let query = parse_query(req.uri().query());

    let (Some(session_id), Some(file_id), Some(token)) = (
        query.get("sessionId"),
        query.get("fileId"),
        query.get("token"),
    ) else {
        return Err(AppError::Message(
            StatusCode::BAD_REQUEST,
            "Missing parameters".to_string(),
        ));
    };
    let cert_fingerprint = client_info.cert_fingerprint();
    let deadline = tokio::time::Instant::now() + STALE_UPLOAD_TIMEOUT;

    loop {
        let mut slot = v2.session.lock().await;
        let Some(SessionStateV2::Active(session)) = slot.as_mut() else {
            return Err(invalid_token_error());
        };
        if session.session_id != *session_id
            || !session.resumable
            || !session.authorizes(&client_info.ip, cert_fingerprint.as_deref())
        {
            return Err(invalid_token_error());
        }
        let Some(file) = session.files.get_mut(file_id) else {
            return Err(invalid_token_error());
        };
        if file.token != *token {
            return Err(invalid_token_error());
        }
        let settled = match file.status {
            FileStatusV2::Pending | FileStatusV2::Interrupted => {
                return Ok(offset_response(file.committed));
            }
            FileStatusV2::Finished => return Ok(offset_response(file.dto.size)),
            FileStatusV2::Failed => return Err(invalid_token_error()),
            FileStatusV2::InProgress => {
                file.abort.cancel();
                file.settled.clone()
            }
        };
        // Registered while the session is locked, so the end of the attempt
        // (which needs the lock) cannot be missed.
        let notified = settled.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        drop(slot);

        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return Err(AppError::Status(StatusCode::SERVICE_UNAVAILABLE));
        }
    }
}

fn offset_response(offset: u64) -> Response<BoxedBody> {
    JsonResponse {
        status: StatusCode::OK,
        body: UploadOffsetResponseDtoV2 { offset },
    }
    .into_response()
}

pub(crate) async fn cancel(
    req: Request<Incoming>,
    state: AppState,
    client_info: RequestClientInfo,
) -> Result<Response<BoxedBody>, AppError> {
    let v2 = require_v2(&state)?;
    let query = parse_query(req.uri().query());
    let session_id = query.get("sessionId");

    // A pending prepare-upload request: the sender does not know the session
    // ID yet (it is part of the response), so a cancel from the pending
    // sender's address is accepted without one.
    let pending_cancelled = {
        let slot = v2.session.lock().await;
        match slot.as_ref() {
            Some(SessionStateV2::Pending(pending))
                if pending.sender_ip == client_info.ip
                    && session_id.is_none_or(|id| *id == pending.session_id) =>
            {
                tracing::info!(
                    "Pending upload session cancelled by sender: {}",
                    pending.session_id
                );
                // The waiting prepare-upload handler frees the slot and
                // notifies the application.
                pending.cancel.cancel();
                true
            }
            _ => false,
        }
    };

    if pending_cancelled {
        return Ok(Response::new(empty_body()));
    }

    if let Some(session_id) = session_id {
        let cancelled = {
            let mut slot = v2.session.lock().await;
            match slot.as_ref() {
                Some(SessionStateV2::Active(session))
                    if session.session_id == *session_id
                        && session.authorizes(
                            &client_info.ip,
                            client_info.cert_fingerprint().as_deref(),
                        ) =>
                {
                    session.abort_resumable_uploads();
                    *slot = None;
                    true
                }
                _ => false,
            }
        };

        if cancelled {
            tracing::info!("Upload session cancelled by sender: {session_id}");
            let _ = v2
                .event_tx
                .send(ServerEventV2::SessionEnd {
                    session_id: session_id.clone(),
                    reason: SessionEndReasonV2::Cancelled,
                })
                .await;
        } else {
            // Not one of our upload sessions: the remote device may be
            // cancelling a transfer this application is sending to it.
            let _ = v2
                .event_tx
                .send(ServerEventV2::CancelReceived {
                    ip: client_info.ip,
                    session_id: session_id.clone(),
                })
                .await;
        }
    }

    Ok(Response::new(empty_body()))
}

fn require_v2(state: &AppState) -> Result<Arc<V2State>, AppError> {
    state
        .v2
        .clone()
        .ok_or(AppError::Status(StatusCode::NOT_FOUND))
}

fn invalid_token_error() -> AppError {
    AppError::Message(
        StatusCode::FORBIDDEN,
        "Invalid token or IP address".to_string(),
    )
}

/// Frees a claimed `Pending` session slot unless a session was created.
///
/// The cleanup also runs on drop so the slot is not leaked
/// when the request future is cancelled (e.g. the sender disconnected
/// while the application was still deciding).
struct PendingSessionGuard {
    v2: Arc<V2State>,
    session_id: String,
    armed: bool,
}

impl PendingSessionGuard {
    fn new(v2: Arc<V2State>, session_id: String) -> Self {
        Self {
            v2,
            session_id,
            armed: true,
        }
    }

    /// Disarms the guard after the pending slot was replaced by an active session.
    fn disarm(&mut self) {
        self.armed = false;
    }

    /// Frees the pending slot immediately.
    async fn clear(&mut self) {
        self.armed = false;
        clear_pending_session(&self.v2).await;
    }
}

impl Drop for PendingSessionGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let v2 = self.v2.clone();
        let session_id = std::mem::take(&mut self.session_id);
        tokio::spawn(async move {
            clear_pending_session(&v2).await;
            // The application may still be waiting for a decision; tell it
            // that answering is pointless now.
            let _ = v2
                .event_tx
                .send(ServerEventV2::PrepareUploadAborted { session_id })
                .await;
        });
    }
}

async fn clear_pending_session(v2: &V2State) {
    let mut slot = v2.session.lock().await;
    if matches!(*slot, Some(SessionStateV2::Pending(_))) {
        *slot = None;
    }
}

/// Sets the final status of a file after an upload attempt.
///
/// The cleanup also runs on drop (as a failure) so the file is not stuck
/// in progress when the request future is cancelled mid-transfer.
struct UploadGuard {
    v2: Arc<V2State>,
    session_id: String,
    file_id: String,

    /// The offset the attempt started at: committed when it ends before
    /// writing anything.
    offset: u64,
    armed: bool,
}

impl UploadGuard {
    fn new(v2: Arc<V2State>, session_id: String, file_id: String, offset: u64) -> Self {
        Self {
            v2,
            session_id,
            file_id,
            offset,
            armed: true,
        }
    }

    async fn finish(&mut self, outcome: SaveOutcome) {
        self.armed = false;
        finalize_file(&self.v2, &self.session_id, &self.file_id, outcome).await;
    }
}

impl Drop for UploadGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let v2 = self.v2.clone();
        let session_id = std::mem::take(&mut self.session_id);
        let file_id = std::mem::take(&mut self.file_id);
        let outcome = SaveOutcome {
            result: SaveResult::Failed,
            committed: self.offset,
        };
        tokio::spawn(async move {
            finalize_file(&v2, &session_id, &file_id, outcome).await;
        });
    }
}

/// How often an upload of the same file may be started, i.e. how often a
/// sender may retry a file after a checksum mismatch.
/// Senders must not retry more often than this (see the upload isolate).
const MAX_UPLOAD_ATTEMPTS: u8 = 3;

/// Sets the final status of a file and ends the session once all files are done.
///
/// A checksum mismatch resets the file to [FileStatusV2::Pending] (as long as
/// [MAX_UPLOAD_ATTEMPTS] is not exhausted) so the sender can retry the upload
/// with the same token; the session stays active in that case.
///
/// In a resumable session, a failed attempt interrupts the file instead
/// ([FileStatusV2::Interrupted], [ServerEventV2::FileInterrupted]): the sender
/// may continue at the committed offset.
async fn finalize_file(v2: &V2State, session_id: &str, file_id: &str, outcome: SaveOutcome) {
    let (session_ended, interrupted) = {
        let mut slot = v2.session.lock().await;
        let Some(SessionStateV2::Active(session)) = slot.as_mut() else {
            return;
        };
        if session.session_id != session_id {
            return;
        }
        let resumable = session.resumable;
        let mut interrupted = None;
        if let Some(file) = session.files.get_mut(file_id) {
            if file.status == FileStatusV2::InProgress {
                let committed = match std::mem::take(&mut file.reset_pending) {
                    true => 0,
                    false => outcome.committed.min(file.dto.size),
                };
                match outcome.result {
                    SaveResult::Success => {
                        file.status = FileStatusV2::Finished;
                        file.committed = file.dto.size;
                    }
                    SaveResult::HashMismatch if file.attempts < MAX_UPLOAD_ATTEMPTS => {
                        // The received bytes are wrong: start over.
                        file.status = FileStatusV2::Pending;
                        file.committed = 0;
                    }
                    SaveResult::Failed if resumable && file.dto.sha256.is_some() => {
                        file.status = FileStatusV2::Interrupted;
                        file.committed = committed;
                        // Only checksum mismatches are limited; a broken
                        // connection is not the file's fault.
                        file.attempts = file.attempts.saturating_sub(1);
                        interrupted = Some(committed);
                    }
                    SaveResult::Failed | SaveResult::HashMismatch => {
                        file.status = FileStatusV2::Failed;
                    }
                }
                file.settled.notify_waiters();
            }
        }
        match session.is_complete() {
            true => {
                *slot = None;
                (true, interrupted)
            }
            false => (false, interrupted),
        }
    };

    if let Some(committed) = interrupted {
        tracing::info!("Upload of {file_id} interrupted at {committed} bytes");
        let _ = v2
            .event_tx
            .send(ServerEventV2::FileInterrupted {
                session_id: session_id.to_string(),
                file_id: file_id.to_string(),
                committed,
            })
            .await;
    }

    if session_ended {
        tracing::info!("Upload session finished: {session_id}");
        let _ = v2
            .event_tx
            .send(ServerEventV2::SessionEnd {
                session_id: session_id.to_string(),
                reason: SessionEndReasonV2::Finished,
            })
            .await;
    }
}

/// Ends the resumable session `session_id` once no upload has been running
/// for [V2State::resume_idle_timeout], so a sender that never comes back
/// does not block the receiver forever.
fn spawn_idle_watchdog(v2: Arc<V2State>, session_id: String) {
    tokio::spawn(async move {
        let timeout = v2.resume_idle_timeout;
        let tick = (timeout / 10).clamp(
            std::time::Duration::from_millis(10),
            std::time::Duration::from_secs(5),
        );
        let mut idle_since: Option<tokio::time::Instant> = None;
        loop {
            tokio::time::sleep(tick).await;
            let expired = {
                let mut slot = v2.session.lock().await;
                let Some(SessionStateV2::Active(session)) = slot.as_mut() else {
                    return;
                };
                if session.session_id != session_id {
                    return;
                }
                if session.is_busy() {
                    idle_since = None;
                    false
                } else if idle_since
                    .get_or_insert_with(tokio::time::Instant::now)
                    .elapsed()
                    >= timeout
                {
                    for file in session.files.values_mut() {
                        if matches!(file.status, FileStatusV2::Pending | FileStatusV2::Interrupted) {
                            file.status = FileStatusV2::Failed;
                        }
                    }
                    *slot = None;
                    true
                } else {
                    false
                }
            };
            if expired {
                tracing::info!("Upload session {session_id} ended: the sender did not come back");
                let _ = v2
                    .event_tx
                    .send(ServerEventV2::SessionEnd {
                        session_id,
                        reason: SessionEndReasonV2::IdleTimeout,
                    })
                    .await;
                return;
            }
        }
    });
}
