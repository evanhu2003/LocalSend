#![cfg(feature = "http")]

//! Resumable uploads: a LocalSend extension of protocol v2 (`resumeSupport` = 1)
//! that lets a sender continue a file at the byte offset the receiver has
//! durably written, instead of starting over.

use bytes::Bytes;
use localsend::http::client::{ClientError, LsHttpClientV2};
use localsend::http::dto_v2::{
    PrepareUploadRequestDtoV2, PrepareUploadResponseDtoV2, RegisterDtoV2, RESUME_SUPPORT_VERSION,
};
use localsend::http::server::common::save::FileUploadTarget;
use localsend::http::server::v2::{PrepareUploadDecisionV2, ServerEventV2, SessionEndReasonV2};
use localsend::http::server::web::WebConfig;
use localsend::http::server::{
    start_with_port, ServerConfigV2, ServerHandle, TlsConfig, DEFAULT_RESUME_IDLE_TIMEOUT,
};
use localsend::http::state::ClientInfo;
use localsend::model::discovery::ProtocolType;
use localsend::model::transfer::FileDto;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use tokio_util::sync::CancellationToken;

/// A generated self-signed certificate, as LocalSend peers use them.
struct Identity {
    cert: String,
    private_key: String,
    /// Uppercase-hex SHA-256 of the certificate in DER format.
    fingerprint: String,
}

fn generate_identity() -> Identity {
    let cert = localsend::crypto::cert::generate_self_signed().unwrap();

    Identity {
        cert: cert.certificate_pem,
        private_key: cert.private_key_pem,
        fingerprint: cert.fingerprint,
    }
}

/// A server whose prepare-upload requests are answered by the test itself.
/// Uploads are written to `dir/<file id>`; other events are forwarded to
/// `notices`.
struct TestServer {
    port: u16,
    protocol: ProtocolType,
    /// Fingerprint of the server certificate (TLS only).
    fingerprint: Option<String>,
    prepares: mpsc::Receiver<ServerEventV2>,
    notices: mpsc::Receiver<ServerEventV2>,
    dir: PathBuf,
    handle: ServerHandle,
    _stop_tx: oneshot::Sender<()>,
}

/// Starts a server over TLS when `identity` is given, plain HTTP otherwise.
async fn start_server(identity: Option<&Identity>) -> TestServer {
    start_server_with(identity, true, DEFAULT_RESUME_IDLE_TIMEOUT).await
}

async fn start_server_with(
    identity: Option<&Identity>,
    verify_checksums: bool,
    resume_idle_timeout: Duration,
) -> TestServer {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let (event_tx, mut events) = mpsc::channel::<ServerEventV2>(64);
    let (prepares_tx, prepares) = mpsc::channel::<ServerEventV2>(64);
    let (notices_tx, notices) = mpsc::channel::<ServerEventV2>(64);
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let dir = std::env::temp_dir().join(format!("localsend-resume-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();

    tokio::spawn({
        let dir = dir.clone();
        async move {
            while let Some(event) = events.recv().await {
                match event {
                    ServerEventV2::PrepareUpload { .. } => {
                        let _ = prepares_tx.send(event).await;
                    }
                    ServerEventV2::FileUpload {
                        file_id,
                        offset,
                        target_tx,
                        ..
                    } => {
                        let (result_tx, _result_rx) = oneshot::channel();
                        let _ = target_tx.send(FileUploadTarget::Path {
                            path: dir.join(&file_id),
                            offset,
                            result_tx,
                            progress_tx: None,
                        });
                    }
                    other => {
                        let _ = notices_tx.send(other).await;
                    }
                }
            }
        }
    });

    let handle = start_with_port(
        0,
        identity.map(|identity| TlsConfig {
            cert: identity.cert.clone(),
            private_key: identity.private_key.clone(),
        }),
        ClientInfo {
            alias: "Resume Receiver".to_string(),
            version: "2.2".to_string(),
            device_model: Some("Rust".to_string()),
            device_type: None,
            token: identity.map_or("http-receiver".to_string(), |i| i.fingerprint.clone()),
        },
        None,
        Some(ServerConfigV2 {
            pin: None,
            verify_checksums,
            resume_idle_timeout,
            event_tx,
        }),
        WebConfig::default(),
        stop_rx,
    )
    .await
    .expect("Failed to start server");

    TestServer {
        port: handle.port(),
        protocol: match identity {
            Some(_) => ProtocolType::Https,
            None => ProtocolType::Http,
        },
        fingerprint: identity.map(|i| i.fingerprint.clone()),
        prepares,
        notices,
        dir,
        handle,
        _stop_tx: stop_tx,
    }
}

fn client(sender: &Identity, server: &TestServer) -> LsHttpClientV2 {
    LsHttpClientV2::try_new(
        &sender.private_key,
        &sender.cert,
        server.fingerprint.clone(),
        None,
    )
    .unwrap()
}

fn sender_info(sender: &Identity, protocol: ProtocolType) -> RegisterDtoV2 {
    RegisterDtoV2 {
        alias: "Resume Sender".to_string(),
        version: "2.2".to_string(),
        device_model: Some("Rust".to_string()),
        device_type: None,
        fingerprint: sender.fingerprint.clone(),
        port: 53317,
        protocol,
        download: false,
    }
}

fn file_dto(id: &str, size: u64) -> FileDto {
    FileDto {
        id: id.to_string(),
        file_name: format!("{id}.bin"),
        size,
        file_type: "application/octet-stream".to_string(),
        sha256: None,
        preview: None,
        metadata: None,
    }
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// A file whose checksum is known, as resumable senders provide them.
fn file_with_content(id: &str, data: &[u8]) -> FileDto {
    FileDto {
        sha256: Some(sha256_hex(data)),
        ..file_dto(id, data.len() as u64)
    }
}

/// Deterministic, non-repeating-looking test content.
fn content(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 7 % 251) as u8).collect()
}

fn request(
    sender: &Identity,
    server: &TestServer,
    files: &[FileDto],
    resume_support: Option<u32>,
) -> PrepareUploadRequestDtoV2 {
    PrepareUploadRequestDtoV2 {
        info: sender_info(sender, server.protocol),
        files: files.iter().map(|f| (f.id.clone(), f.clone())).collect(),
        resume_support,
    }
}

/// Sends a prepare-upload request and answers it with `decision`.
///
/// Returns the response and whether the server flagged the request as
/// resumable in its [ServerEventV2::PrepareUpload] event.
async fn prepare_upload(
    client: &LsHttpClientV2,
    server: &mut TestServer,
    payload: PrepareUploadRequestDtoV2,
    decision: impl FnOnce(&HashMap<String, FileDto>) -> PrepareUploadDecisionV2,
) -> (PrepareUploadResponseDtoV2, bool) {
    let protocol = server.protocol;
    let port = server.port;
    let request = client.prepare_upload(
        protocol,
        "127.0.0.1",
        port,
        None,
        payload,
        None,
        CancellationToken::new(),
    );
    let respond = async {
        match server.prepares.recv().await.expect("server stopped") {
            ServerEventV2::PrepareUpload {
                files,
                resumable,
                decision_tx,
                ..
            } => {
                let _ = decision_tx.send(decision(&files));
                resumable
            }
            other => panic!("unexpected event: {other:?}"),
        }
    };
    let (result, resumable) = tokio::join!(request, respond);
    let response = result
        .expect("prepare-upload failed")
        .response
        .expect("prepare-upload returned no body");
    (response, resumable)
}

fn accept_with_offsets(
    files: &HashMap<String, FileDto>,
    offsets: &[(&str, u64)],
) -> PrepareUploadDecisionV2 {
    PrepareUploadDecisionV2::AcceptWithOffsets {
        file_ids: files.keys().cloned().collect::<HashSet<_>>(),
        offsets: offsets
            .iter()
            .map(|(id, offset)| (id.to_string(), *offset))
            .collect(),
    }
}

/// Starts a resumable session for `files`, offering the given offsets.
async fn prepare_resumable(
    client: &LsHttpClientV2,
    server: &mut TestServer,
    sender: &Identity,
    files: &[FileDto],
    offsets: &[(&str, u64)],
) -> PrepareUploadResponseDtoV2 {
    let payload = request(sender, server, files, Some(RESUME_SUPPORT_VERSION));
    let offsets: Vec<(String, u64)> = offsets.iter().map(|(id, o)| (id.to_string(), *o)).collect();
    let (response, resumable) = prepare_upload(client, server, payload, |files| {
        let offsets: Vec<(&str, u64)> = offsets.iter().map(|(id, o)| (id.as_str(), *o)).collect();
        accept_with_offsets(files, &offsets)
    })
    .await;
    assert!(resumable);
    response
}

/// Uploads `data` (the bytes from `offset` on) completely.
#[allow(clippy::too_many_arguments)]
async fn upload(
    client: &LsHttpClientV2,
    server: &TestServer,
    host: &str,
    session_id: &str,
    file_id: &str,
    token: &str,
    offset: u64,
    data: &[u8],
) -> Result<(), ClientError> {
    client
        .upload_from_offset(
            server.protocol,
            host,
            server.port,
            None,
            session_id,
            file_id,
            token,
            offset,
            localsend::reqwest::Body::from(data.to_vec()),
            CancellationToken::new(),
        )
        .await
}

/// Starts uploading `data` from `offset`, sends the first `send` bytes and
/// keeps the request open. Cancelling the returned token drops the connection
/// mid-body; the join handle yields the result of the request.
#[allow(clippy::too_many_arguments)]
async fn start_stalled_upload(
    client: LsHttpClientV2,
    server: &TestServer,
    session_id: &str,
    file_id: &str,
    token: &str,
    offset: u64,
    data: &[u8],
    send: usize,
) -> (CancellationToken, tokio::task::JoinHandle<Result<(), ClientError>>) {
    let (tx, rx) = mpsc::channel::<Bytes>(1024);
    for chunk in data[..send].chunks(1024) {
        tx.send(Bytes::copy_from_slice(chunk)).await.unwrap();
    }
    let body = localsend::reqwest::Body::wrap_stream(
        ReceiverStream::new(rx).map(Ok::<Bytes, std::io::Error>),
    );
    let cancel = CancellationToken::new();
    let task = tokio::spawn({
        let protocol = server.protocol;
        let port = server.port;
        let session_id = session_id.to_string();
        let file_id = file_id.to_string();
        let token = token.to_string();
        let cancel = cancel.clone();
        async move {
            // Keeps the body open (no end of stream) while the request runs.
            let _tx = tx;
            client
                .upload_from_offset(
                    protocol,
                    "127.0.0.1",
                    port,
                    None,
                    &session_id,
                    &file_id,
                    &token,
                    offset,
                    body,
                    cancel,
                )
                .await
        }
    });
    // Let the sent bytes reach the server.
    tokio::time::sleep(Duration::from_millis(300)).await;
    (cancel, task)
}

/// Uploads the first `send` bytes of `data` and then drops the connection.
#[allow(clippy::too_many_arguments)]
async fn upload_interrupted(
    client: LsHttpClientV2,
    server: &TestServer,
    session_id: &str,
    file_id: &str,
    token: &str,
    offset: u64,
    data: &[u8],
    send: usize,
) {
    let (cancel, task) =
        start_stalled_upload(client, server, session_id, file_id, token, offset, data, send).await;
    cancel.cancel();
    let result = task.await.unwrap();
    assert!(result.is_err(), "the interrupted upload must not succeed");
}

async fn next_notice(server: &mut TestServer) -> ServerEventV2 {
    tokio::time::timeout(Duration::from_secs(5), server.notices.recv())
        .await
        .expect("no server event within 5 s")
        .expect("server stopped")
}

/// Waits for the [ServerEventV2::FileInterrupted] of `file_id`.
async fn wait_interrupted(server: &mut TestServer, file_id: &str) -> u64 {
    loop {
        match next_notice(server).await {
            ServerEventV2::FileInterrupted {
                file_id: id,
                committed,
                ..
            } if id == file_id => return committed,
            ServerEventV2::SessionEnd { reason, .. } => {
                panic!("session ended ({reason:?}) instead of an interruption")
            }
            _ => {}
        }
    }
}

async fn wait_session_end(server: &mut TestServer) -> SessionEndReasonV2 {
    loop {
        if let ServerEventV2::SessionEnd { reason, .. } = next_notice(server).await {
            return reason;
        }
    }
}

fn assert_status(result: Result<impl std::fmt::Debug, ClientError>, status: u16) -> Option<u64> {
    match result {
        Err(ClientError::StatusCode(e)) => {
            assert_eq!(e.status, status, "{e:?}");
            e.offset
        }
        other => panic!("expected status {status}, got {other:?}"),
    }
}

#[tokio::test]
async fn test_resume_negotiated_over_tls() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let client = client(&sender, &server);

    let payload = request(
        &sender,
        &server,
        &[file_dto("a", 20), file_dto("b", 5)],
        Some(RESUME_SUPPORT_VERSION),
    );
    let (response, resumable) = prepare_upload(&client, &mut server, payload, |files| {
        // `b` claims more bytes than the file has, so it must start over.
        accept_with_offsets(files, &[("a", 10), ("b", 999)])
    })
    .await;

    assert!(resumable);
    assert_eq!(response.resume_support, Some(RESUME_SUPPORT_VERSION));
    assert_eq!(response.resume_offsets.get("a"), Some(&10));
    assert_eq!(response.resume_offsets.get("b"), None);
    assert_eq!(response.files.len(), 2);
}

#[tokio::test]
async fn test_resume_not_negotiated_without_request_flag() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let client = client(&sender, &server);

    let payload = request(&sender, &server, &[file_dto("a", 20)], None);
    let (response, resumable) = prepare_upload(&client, &mut server, payload, |files| {
        accept_with_offsets(files, &[])
    })
    .await;

    assert!(!resumable);
    assert_eq!(response.resume_support, None);
    assert!(response.resume_offsets.is_empty());
    let json = serde_json::to_string(&response).unwrap();
    assert!(!json.contains("resumeSupport"), "{json}");
    assert!(!json.contains("resumeOffsets"), "{json}");
}

#[tokio::test]
async fn test_resume_not_negotiated_over_http() {
    let sender = generate_identity();
    let mut server = start_server(None).await;
    let client = client(&sender, &server);

    let payload = request(
        &sender,
        &server,
        &[file_dto("a", 20)],
        Some(RESUME_SUPPORT_VERSION),
    );
    let (response, resumable) = prepare_upload(&client, &mut server, payload, |files| {
        accept_with_offsets(files, &[("a", 10)])
    })
    .await;

    assert!(!resumable);
    assert_eq!(response.resume_support, None);
    assert!(response.resume_offsets.is_empty());
}

#[tokio::test]
async fn test_offsets_ignored_when_not_resumable() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let client = client(&sender, &server);

    // The application offers an offset although the sender did not ask for
    // resuming: the offset must not reach the sender.
    let payload = request(&sender, &server, &[file_dto("a", 20)], None);
    let (response, _) = prepare_upload(&client, &mut server, payload, |files| {
        accept_with_offsets(files, &[("a", 10)])
    })
    .await;

    assert_eq!(response.files.len(), 1);
    assert!(response.resume_offsets.is_empty());
}

#[tokio::test]
async fn test_upload_with_offset_appends() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let client = client(&sender, &server);
    let data = content(64 * 1024);
    std::fs::write(server.dir.join("a"), &data[..4]).unwrap();

    let response = prepare_resumable(
        &client,
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[("a", 4)],
    )
    .await;
    assert_eq!(response.resume_offsets.get("a"), Some(&4));

    let token = &response.files["a"];
    upload(&client, &server, "127.0.0.1", &response.session_id, "a", token, 4, &data[4..])
        .await
        .expect("resumed upload failed");

    assert_eq!(std::fs::read(server.dir.join("a")).unwrap(), data);
}

#[tokio::test]
async fn test_offset_mismatch_returns_409_with_offset() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let client = client(&sender, &server);
    let data = content(1024);
    std::fs::write(server.dir.join("a"), &data[..4]).unwrap();

    let response = prepare_resumable(
        &client,
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[("a", 4)],
    )
    .await;

    let token = &response.files["a"];
    let result =
        upload(&client, &server, "127.0.0.1", &response.session_id, "a", token, 3, &data[3..])
            .await;
    match &result {
        Err(ClientError::StatusCode(e)) => {
            assert_eq!(e.message.as_deref(), Some("Offset mismatch"))
        }
        other => panic!("expected 409, got {other:?}"),
    }
    assert_eq!(assert_status(result, 409), Some(4));
}

#[tokio::test]
async fn test_interrupted_upload_keeps_session() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let data = content(256 * 1024);
    let response = prepare_resumable(
        &client(&sender, &server),
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[],
    )
    .await;
    let token = response.files["a"].clone();

    upload_interrupted(
        client(&sender, &server),
        &server,
        &response.session_id,
        "a",
        &token,
        0,
        &data,
        128 * 1024,
    )
    .await;

    let committed = wait_interrupted(&mut server, "a").await;
    assert!(committed > 0);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        server.notices.try_recv().is_err(),
        "no session end expected after an interruption"
    );

    let client = client(&sender, &server);
    let offset = client
        .upload_offset(server.protocol, "127.0.0.1", server.port, None, &response.session_id, "a", &token)
        .await
        .expect("upload-offset failed");
    assert_eq!(offset, committed);

    upload(
        &client,
        &server,
        "127.0.0.1",
        &response.session_id,
        "a",
        &token,
        offset,
        &data[offset as usize..],
    )
    .await
    .expect("resumed upload failed");
    assert_eq!(std::fs::read(server.dir.join("a")).unwrap(), data);
}

#[tokio::test]
async fn test_upload_offset_aborts_stale_upload() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let data = content(256 * 1024);
    let response = prepare_resumable(
        &client(&sender, &server),
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[],
    )
    .await;
    let token = response.files["a"].clone();

    // The connection of this upload is still open: the receiver cannot know
    // that the sender is gone.
    let (_cancel, stale) = start_stalled_upload(
        client(&sender, &server),
        &server,
        &response.session_id,
        "a",
        &token,
        0,
        &data,
        64 * 1024,
    )
    .await;

    let client = client(&sender, &server);
    let offset = client
        .upload_offset(server.protocol, "127.0.0.1", server.port, None, &response.session_id, "a", &token)
        .await
        .expect("upload-offset failed");
    assert!(offset > 0);

    let stale = tokio::time::timeout(Duration::from_secs(5), stale)
        .await
        .expect("the stale upload must end")
        .unwrap();
    assert!(stale.is_err());

    upload(
        &client,
        &server,
        "127.0.0.1",
        &response.session_id,
        "a",
        &token,
        offset,
        &data[offset as usize..],
    )
    .await
    .expect("resumed upload failed");
    assert_eq!(std::fs::read(server.dir.join("a")).unwrap(), data);
}

#[tokio::test]
async fn test_resume_from_new_ip_same_cert() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let data = content(256 * 1024);
    let response = prepare_resumable(
        &client(&sender, &server),
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[],
    )
    .await;
    let token = response.files["a"].clone();
    upload_interrupted(
        client(&sender, &server),
        &server,
        &response.session_id,
        "a",
        &token,
        0,
        &data,
        128 * 1024,
    )
    .await;
    wait_interrupted(&mut server, "a").await;

    // The sender comes back from another address (IPv6 loopback).
    let client = client(&sender, &server);
    let offset = client
        .upload_offset(server.protocol, "::1", server.port, None, &response.session_id, "a", &token)
        .await
        .expect("upload-offset from the new address failed");
    upload(
        &client,
        &server,
        "::1",
        &response.session_id,
        "a",
        &token,
        offset,
        &data[offset as usize..],
    )
    .await
    .expect("resumed upload from the new address failed");
    assert_eq!(std::fs::read(server.dir.join("a")).unwrap(), data);
}

#[tokio::test]
async fn test_resume_rejected_for_other_cert() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let intruder = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let data = content(256 * 1024);
    let response = prepare_resumable(
        &client(&sender, &server),
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[],
    )
    .await;
    let token = response.files["a"].clone();
    upload_interrupted(
        client(&sender, &server),
        &server,
        &response.session_id,
        "a",
        &token,
        0,
        &data,
        128 * 1024,
    )
    .await;
    wait_interrupted(&mut server, "a").await;

    let result = client(&intruder, &server)
        .upload_offset(server.protocol, "127.0.0.1", server.port, None, &response.session_id, "a", &token)
        .await;
    assert_status(result, 403);
}

#[tokio::test]
async fn test_idle_timeout_ends_session() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let other = generate_identity();
    let mut server = start_server_with(Some(&receiver), true, Duration::from_millis(200)).await;
    let data = content(256 * 1024);
    let response = prepare_resumable(
        &client(&sender, &server),
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[],
    )
    .await;
    upload_interrupted(
        client(&sender, &server),
        &server,
        &response.session_id,
        "a",
        &response.files["a"],
        0,
        &data,
        128 * 1024,
    )
    .await;

    assert_eq!(wait_session_end(&mut server).await, SessionEndReasonV2::IdleTimeout);

    // The slot is free again.
    let response = prepare_resumable(
        &client(&other, &server),
        &mut server,
        &other,
        &[file_with_content("b", &data)],
        &[],
    )
    .await;
    assert_eq!(response.files.len(), 1);
}

#[tokio::test]
async fn test_same_sender_supersedes_session() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let data = content(256 * 1024);
    let first = prepare_resumable(
        &client(&sender, &server),
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[],
    )
    .await;
    upload_interrupted(
        client(&sender, &server),
        &server,
        &first.session_id,
        "a",
        &first.files["a"],
        0,
        &data,
        128 * 1024,
    )
    .await;
    wait_interrupted(&mut server, "a").await;

    // The sender restarted and sends the file again.
    let second = prepare_resumable(
        &client(&sender, &server),
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[],
    )
    .await;
    assert_ne!(second.session_id, first.session_id);
    assert_eq!(wait_session_end(&mut server).await, SessionEndReasonV2::Superseded);
}

#[tokio::test]
async fn test_other_sender_blocked_during_grace() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let other = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let data = content(256 * 1024);
    let response = prepare_resumable(
        &client(&sender, &server),
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[],
    )
    .await;
    upload_interrupted(
        client(&sender, &server),
        &server,
        &response.session_id,
        "a",
        &response.files["a"],
        0,
        &data,
        128 * 1024,
    )
    .await;
    wait_interrupted(&mut server, "a").await;

    let result = client(&other, &server)
        .prepare_upload(
            server.protocol,
            "127.0.0.1",
            server.port,
            None,
            request(&other, &server, &[file_with_content("b", &data)], Some(RESUME_SUPPORT_VERSION)),
            None,
            CancellationToken::new(),
        )
        .await;
    assert_status(result.map(|r| r.status_code), 409);
}

#[tokio::test]
async fn test_hash_mismatch_resets_offset() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let client = client(&sender, &server);
    let data = content(1024);
    // The kept part does not belong to this file.
    std::fs::write(server.dir.join("a"), b"XXXX").unwrap();

    let response = prepare_resumable(
        &client,
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[("a", 4)],
    )
    .await;
    let token = &response.files["a"];
    let result =
        upload(&client, &server, "127.0.0.1", &response.session_id, "a", token, 4, &data[4..])
            .await;
    assert_status(result, 422);

    let offset = client
        .upload_offset(server.protocol, "127.0.0.1", server.port, None, &response.session_id, "a", token)
        .await
        .unwrap();
    assert_eq!(offset, 0);
}

#[tokio::test]
async fn test_resumed_file_verified_even_when_verification_disabled() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server_with(Some(&receiver), false, DEFAULT_RESUME_IDLE_TIMEOUT).await;
    let client = client(&sender, &server);
    let data = content(1024);
    std::fs::write(server.dir.join("a"), b"XXXX").unwrap();

    let response = prepare_resumable(
        &client,
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[("a", 4)],
    )
    .await;
    let result = upload(
        &client,
        &server,
        "127.0.0.1",
        &response.session_id,
        "a",
        &response.files["a"],
        4,
        &data[4..],
    )
    .await;
    assert_status(result, 422);
}

#[tokio::test]
async fn test_resume_zero_byte_file() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let client = client(&sender, &server);

    let response = prepare_resumable(
        &client,
        &mut server,
        &sender,
        &[file_with_content("a", b"")],
        &[],
    )
    .await;
    upload(&client, &server, "127.0.0.1", &response.session_id, "a", &response.files["a"], 0, b"")
        .await
        .expect("empty upload failed");

    assert_eq!(wait_session_end(&mut server).await, SessionEndReasonV2::Finished);
    assert_eq!(std::fs::read(server.dir.join("a")).unwrap(), b"");
}

#[tokio::test]
async fn test_resume_one_of_two_files() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let client = client(&sender, &server);
    let a = content(64 * 1024);
    let b: Vec<u8> = content(64 * 1024).into_iter().rev().collect();
    std::fs::write(server.dir.join("a"), &a[..16 * 1024]).unwrap();

    let response = prepare_resumable(
        &client,
        &mut server,
        &sender,
        &[file_with_content("a", &a), file_with_content("b", &b)],
        &[("a", 16 * 1024)],
    )
    .await;
    let (ra, rb) = tokio::join!(
        upload(
            &client,
            &server,
            "127.0.0.1",
            &response.session_id,
            "a",
            &response.files["a"],
            16 * 1024,
            &a[16 * 1024..],
        ),
        upload(&client, &server, "127.0.0.1", &response.session_id, "b", &response.files["b"], 0, &b),
    );
    ra.expect("resumed file failed");
    rb.expect("fresh file failed");

    assert_eq!(wait_session_end(&mut server).await, SessionEndReasonV2::Finished);
    assert_eq!(std::fs::read(server.dir.join("a")).unwrap(), a);
    assert_eq!(std::fs::read(server.dir.join("b")).unwrap(), b);
}

#[tokio::test]
async fn test_legacy_session_unchanged() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let data = content(256 * 1024);

    // No resumeSupport: an interruption fails the file like before.
    let payload = request(
        &sender,
        &server,
        &[file_with_content("a", &data), file_with_content("b", &data)],
        None,
    );
    let (response, resumable) = prepare_upload(&client(&sender, &server), &mut server, payload, |files| {
        PrepareUploadDecisionV2::Accept(files.keys().cloned().collect())
    })
    .await;
    assert!(!resumable);
    upload_interrupted(
        client(&sender, &server),
        &server,
        &response.session_id,
        "a",
        &response.files["a"],
        0,
        &data,
        128 * 1024,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    while let Ok(event) = server.notices.try_recv() {
        assert!(
            !matches!(event, ServerEventV2::FileInterrupted { .. }),
            "legacy sessions do not report interruptions"
        );
    }

    // Uploads are still bound to the sender's address.
    let result = upload(
        &client(&sender, &server),
        &server,
        "::1",
        &response.session_id,
        "b",
        &response.files["b"],
        0,
        &data,
    )
    .await;
    assert_status(result, 403);
}

#[tokio::test]
async fn test_reset_v2_file() {
    let receiver = generate_identity();
    let sender = generate_identity();
    let mut server = start_server(Some(&receiver)).await;
    let data = content(256 * 1024);
    let response = prepare_resumable(
        &client(&sender, &server),
        &mut server,
        &sender,
        &[file_with_content("a", &data)],
        &[],
    )
    .await;
    let token = response.files["a"].clone();
    upload_interrupted(
        client(&sender, &server),
        &server,
        &response.session_id,
        "a",
        &token,
        0,
        &data,
        128 * 1024,
    )
    .await;
    assert!(wait_interrupted(&mut server, "a").await > 0);

    assert!(server.handle.reset_v2_file(&response.session_id, "a").await);

    let offset = client(&sender, &server)
        .upload_offset(server.protocol, "127.0.0.1", server.port, None, &response.session_id, "a", &token)
        .await
        .unwrap();
    assert_eq!(offset, 0);
}
