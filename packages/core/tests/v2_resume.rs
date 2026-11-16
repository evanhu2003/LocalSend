#![cfg(feature = "http")]

//! Resumable uploads: a LocalSend extension of protocol v2 (`resumeSupport` = 1)
//! that lets a sender continue a file at the byte offset the receiver has
//! durably written, instead of starting over.

use localsend::http::client::LsHttpClientV2;
use localsend::http::dto_v2::{
    PrepareUploadRequestDtoV2, PrepareUploadResponseDtoV2, RegisterDtoV2, RESUME_SUPPORT_VERSION,
};
use localsend::http::server::v2::{PrepareUploadDecisionV2, ServerEventV2};
use localsend::http::server::web::WebConfig;
use localsend::http::server::{start_with_port, ServerConfigV2, ServerHandle, TlsConfig};
use localsend::http::state::ClientInfo;
use localsend::model::discovery::ProtocolType;
use localsend::model::transfer::FileDto;
use std::collections::{HashMap, HashSet};
use tokio::sync::{mpsc, oneshot};
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

/// A server whose events are driven by the test itself.
struct TestServer {
    port: u16,
    protocol: ProtocolType,
    /// Fingerprint of the server certificate (TLS only).
    fingerprint: Option<String>,
    events: mpsc::Receiver<ServerEventV2>,
    #[allow(dead_code)]
    handle: ServerHandle,
    _stop_tx: oneshot::Sender<()>,
}

/// Starts a server over TLS when `identity` is given, plain HTTP otherwise.
async fn start_server(identity: Option<&Identity>) -> TestServer {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let (event_tx, events) = mpsc::channel::<ServerEventV2>(64);
    let (stop_tx, stop_rx) = oneshot::channel::<()>();

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
            verify_checksums: true,
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
        events,
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
        match server.events.recv().await.expect("server stopped") {
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
