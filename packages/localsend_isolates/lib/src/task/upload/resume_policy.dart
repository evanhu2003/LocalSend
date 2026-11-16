import 'dart:math';

import 'package:localsend_isolates/rust/api/http.dart';

/// How long to wait before the n-th reconnect attempt; the last value repeats.
const resumeRetryDelays = [
  Duration(seconds: 1),
  Duration(seconds: 2),
  Duration(seconds: 4),
  Duration(seconds: 8),
  Duration(seconds: 15),
  Duration(seconds: 30),
];

/// How long a sender keeps reconnecting without progress. Matches how long the
/// receiver keeps a resumable session for it (DEFAULT_RESUME_IDLE_TIMEOUT).
const resumeRetryWindow = Duration(minutes: 5);

/// How often a file is uploaded at most when the receiver keeps rejecting it
/// with a checksum mismatch (HTTP 422). Must not exceed MAX_UPLOAD_ATTEMPTS of
/// the Rust server.
const _maxChecksumAttempts = 3;

/// How often in a row a 409 may correct the offset before giving up.
const _maxOffsetCorrections = 3;

enum UploadFailureKind {
  /// The connection broke (or the receiver could not continue the file right
  /// now): reconnect and continue at the offset the receiver holds.
  connection,

  /// The upload did not start at the receiver's offset; the error carries it.
  offsetMismatch,

  /// The session is over on the receiver; retrying is pointless.
  sessionGone,

  /// The received file does not match its checksum; start over.
  checksumMismatch,

  other,
}

UploadFailureKind classifyUploadFailure(Object error) {
  return switch (error) {
    RsHttpClientError_StatusCode(status: 409) => UploadFailureKind.offsetMismatch,
    RsHttpClientError_StatusCode(status: 403 || 404) => UploadFailureKind.sessionGone,
    RsHttpClientError_StatusCode(status: 422) => UploadFailureKind.checksumMismatch,
    // A resumable receiver answers 500 when it cannot continue the received
    // part (it then starts over at the offset it reports), and 503 while an
    // old upload of the file is still ending (e.g. reading back a large part).
    RsHttpClientError_StatusCode(status: 500 || 503) => UploadFailureKind.connection,
    RsHttpClientError_Reqwest() || RsHttpClientError_Io() => UploadFailureKind.connection,
    _ => UploadFailureKind.other,
  };
}

/// Uploads a file of a resumable session, continuing after interruptions.
///
/// [upload] sends the file from the given offset on. After a broken
/// connection, [queryOffset] asks the receiver where to continue, with
/// [resumeRetryDelays] between attempts; [onReconnecting] reports each
/// attempt. With [queryOffsetFirst], the receiver is asked before the first
/// upload (e.g. when the user retries a failed file). When the receiver
/// already holds all [fileSize] bytes, the file is done.
///
/// Reconnecting stops when [isCancelled], when the session is gone, or after
/// [resumeRetryWindow] without progress: the last error is thrown.
Future<void> uploadWithResume({
  required int fileSize,
  required int initialOffset,
  bool queryOffsetFirst = false,
  required Future<int> Function() queryOffset,
  required Future<void> Function(int offset) upload,
  required bool Function() isCancelled,
  required Future<void> Function(Duration) sleep,
  required DateTime Function() now,
  void Function(int attempt)? onReconnecting,
}) async {
  var offset = initialOffset;
  var checksumAttempts = 0;
  var offsetCorrections = 0;
  var reconnects = 0;
  // Start of the current failure streak and the offset reached at its start.
  DateTime? failingSince;
  var offsetWhenFailing = 0;

  /// Asks the receiver for its offset until the connection is back.
  Future<int> reconnect(Object error) async {
    if (failingSince == null) {
      failingSince = now();
      offsetWhenFailing = offset;
    }
    var lastError = error;
    while (true) {
      if (now().difference(failingSince!) >= resumeRetryWindow) {
        throw lastError;
      }
      reconnects++;
      onReconnecting?.call(reconnects);
      await sleep(resumeRetryDelays[min(reconnects - 1, resumeRetryDelays.length - 1)]);
      if (isCancelled()) {
        throw lastError;
      }
      final int queried;
      try {
        queried = await queryOffset();
      } catch (queryError) {
        if (classifyUploadFailure(queryError) != UploadFailureKind.connection) {
          rethrow;
        }
        lastError = queryError;
        continue;
      }
      if (isCancelled()) {
        throw lastError;
      }
      if (queried > offsetWhenFailing) {
        // The transfer got further: a new streak of failures gets the whole
        // window again.
        failingSince = null;
        reconnects = 0;
      }
      return queried;
    }
  }

  /// Whether the receiver reported that it holds the complete file (e.g. the
  /// answer to the last upload was lost).
  bool receiverHasFile(int queried) => fileSize > 0 && queried >= fileSize;

  if (queryOffsetFirst) {
    try {
      offset = await queryOffset();
    } catch (e) {
      if (classifyUploadFailure(e) != UploadFailureKind.connection) {
        rethrow;
      }
      offset = await reconnect(e);
    }
    if (receiverHasFile(offset)) {
      return;
    }
  }

  while (true) {
    try {
      checksumAttempts++;
      await upload(offset);
      return;
    } catch (e) {
      switch (classifyUploadFailure(e)) {
        case UploadFailureKind.offsetMismatch:
          final expected = (e as RsHttpClientError_StatusCode).offset;
          checksumAttempts--;
          if (expected == null || ++offsetCorrections > _maxOffsetCorrections) {
            rethrow;
          }
          offset = expected.toInt();
          continue;
        case UploadFailureKind.checksumMismatch:
          if (checksumAttempts >= _maxChecksumAttempts) {
            rethrow;
          }
          offset = 0;
          continue;
        case UploadFailureKind.sessionGone:
        case UploadFailureKind.other:
          rethrow;
        case UploadFailureKind.connection:
          checksumAttempts--;
          offsetCorrections = 0;
          offset = await reconnect(e);
          if (receiverHasFile(offset)) {
            return;
          }
      }
    }
  }
}
