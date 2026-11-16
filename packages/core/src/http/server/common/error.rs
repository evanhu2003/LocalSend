use crate::http::dto::ErrorResponse;
use crate::http::server::common::response::{BoxedBody, JsonResponse};
use hyper::{Response, StatusCode};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Hyper error: {0}")]
    Hyper(#[from] hyper::Error),

    #[error("Status Error: {0}")]
    Status(StatusCode),

    #[error("Invalid request: {0}")]
    BadRequest(String),

    #[error("{0}: {1}")]
    Message(StatusCode, String),

    /// 409: an upload did not start at the offset the receiver holds.
    #[error("Offset mismatch, expected {0}")]
    OffsetMismatch(u64),
}

impl AppError {
    pub(crate) fn to_response(self) -> Response<BoxedBody> {
        let json = match self {
            AppError::Hyper(_) => JsonResponse {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                body: ErrorResponse {
                    message: "Internal server error".to_string(),
                    offset: None,
                },
            },
            AppError::Status(code) => JsonResponse {
                status: code,
                body: ErrorResponse {
                    message: format!("Status code: {code}"),
                    offset: None,
                },
            },
            AppError::BadRequest(message) => JsonResponse {
                status: StatusCode::BAD_REQUEST,
                body: ErrorResponse {
                    message,
                    offset: None,
                },
            },
            AppError::Message(status, message) => JsonResponse {
                status,
                body: ErrorResponse {
                    message,
                    offset: None,
                },
            },
            AppError::OffsetMismatch(offset) => JsonResponse {
                status: StatusCode::CONFLICT,
                body: ErrorResponse {
                    message: "Offset mismatch".to_string(),
                    offset: Some(offset),
                },
            },
        };

        json.into_response()
    }
}
