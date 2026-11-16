import 'package:flutter_test/flutter_test.dart';
import 'package:localsend_isolates/rust/api/http.dart';
import 'package:localsend_isolates/src/task/upload/resume_policy.dart';

void main() {
  const connectionError = RsHttpClientError.reqwest('error sending request: connection error: Connection timed out (os error 110)');

  /// A fake upload: [uploadResults] answer the uploads in order (null = success,
  /// otherwise thrown), [offsetResults] answer the offset queries in order
  /// (an int is returned, anything else thrown).
  ({List<int> uploads, List<Duration> sleeps, List<int> reconnects, Future<void> Function() run, int Function() queries}) fake({
    int initialOffset = 0,
    int fileSize = 1000,
    bool queryOffsetFirst = false,
    void Function()? onQuery,
    required List<Object?> uploadResults,
    List<Object> offsetResults = const [],
    DateTime Function()? now,
    bool Function()? isCancelled,
    void Function(Duration)? onSleep,
  }) {
    final uploads = <int>[];
    final sleeps = <Duration>[];
    final reconnects = <int>[];
    var queries = 0;
    final start = DateTime.utc(2026, 11, 16);
    return (
      uploads: uploads,
      sleeps: sleeps,
      reconnects: reconnects,
      queries: () => queries,
      run: () => uploadWithResume(
        fileSize: fileSize,
        initialOffset: initialOffset,
        queryOffsetFirst: queryOffsetFirst,
        queryOffset: () async {
          onQuery?.call();
          final result = offsetResults[queries++];
          if (result is int) {
            return result;
          }
          throw result;
        },
        upload: (offset) async {
          uploads.add(offset);
          final result = uploadResults[uploads.length - 1];
          if (result != null) {
            throw result;
          }
        },
        isCancelled: isCancelled ?? () => false,
        sleep: (duration) async {
          sleeps.add(duration);
          onSleep?.call(duration);
        },
        now: now ?? () => start,
        onReconnecting: reconnects.add,
      ),
    );
  }

  test('classifies the failures of an upload', () {
    expect(classifyUploadFailure(connectionError), UploadFailureKind.connection);
    expect(classifyUploadFailure(const RsHttpClientError.io('broken pipe')), UploadFailureKind.connection);
    expect(classifyUploadFailure(const RsHttpClientError.statusCode(status: 500)), UploadFailureKind.connection);
    // The receiver is still ending an old upload of the file (e.g. reading back a large part).
    expect(classifyUploadFailure(const RsHttpClientError.statusCode(status: 503)), UploadFailureKind.connection);
    expect(classifyUploadFailure(RsHttpClientError.statusCode(status: 409, offset: BigInt.from(4))), UploadFailureKind.offsetMismatch);
    expect(classifyUploadFailure(const RsHttpClientError.statusCode(status: 403)), UploadFailureKind.sessionGone);
    expect(classifyUploadFailure(const RsHttpClientError.statusCode(status: 404)), UploadFailureKind.sessionGone);
    expect(classifyUploadFailure(const RsHttpClientError.statusCode(status: 422)), UploadFailureKind.checksumMismatch);
    expect(classifyUploadFailure(const RsHttpClientError.other('Upload cancelled')), UploadFailureKind.other);
  });

  test('reconnects after a connection error and resumes from the queried offset', () async {
    final f = fake(uploadResults: [connectionError, null], offsetResults: [40]);

    await f.run();

    expect(f.uploads, [0, 40]);
    expect(f.reconnects, [1]);
    expect(f.sleeps, [const Duration(seconds: 1)]);
  });

  test('uses the offset of a 409 response without sleeping', () async {
    final f = fake(
      uploadResults: [
        RsHttpClientError.statusCode(status: 409, offset: BigInt.from(40)),
        null,
      ],
    );

    await f.run();

    expect(f.uploads, [0, 40]);
    expect(f.sleeps, isEmpty);
    expect(f.queries(), 0);
  });

  test('stops when the session is gone', () async {
    final f = fake(uploadResults: [connectionError], offsetResults: [const RsHttpClientError.statusCode(status: 403)]);

    await expectLater(f.run(), throwsA(isA<RsHttpClientError_StatusCode>()));

    expect(f.uploads, [0]);
  });

  test('stops immediately when cancelled during backoff', () async {
    var cancelled = false;
    final f = fake(
      uploadResults: [connectionError],
      offsetResults: [40],
      isCancelled: () => cancelled,
      onSleep: (_) => cancelled = true,
    );

    await expectLater(f.run(), throwsA(connectionError));

    expect(f.uploads, [0]);
    expect(f.queries(), 0);
  });

  test('gives up after the 5 minute window', () async {
    var time = DateTime.utc(2026, 11, 16);
    final f = fake(
      uploadResults: [connectionError],
      offsetResults: List.filled(50, connectionError),
      now: () => time = time.add(const Duration(seconds: 31)),
    );

    await expectLater(f.run(), throwsA(connectionError));

    expect(f.sleeps.take(7).map((d) => d.inSeconds), [1, 2, 4, 8, 15, 30, 30]);
    expect(f.uploads, [0]);
  });

  test('keeps retrying while the transfer makes progress', () async {
    var time = DateTime.utc(2026, 11, 16);
    // Every reconnect gets further, so the window starts over each time.
    final f = fake(
      uploadResults: [connectionError, connectionError, connectionError, null],
      offsetResults: [10, 20, 30],
      now: () => time = time.add(const Duration(minutes: 4)),
    );

    await f.run();

    expect(f.uploads, [0, 10, 20, 30]);
  });

  test('restarts from zero after a checksum mismatch, at most 3 attempts', () async {
    const mismatch = RsHttpClientError.statusCode(status: 422, message: 'Checksum mismatch');
    final f = fake(initialOffset: 50, uploadResults: [mismatch, mismatch, mismatch]);

    await expectLater(f.run(), throwsA(mismatch));

    expect(f.uploads, [50, 0, 0]);
  });

  test('treats a queried offset at the file size as finished', () async {
    // The receiver got the whole file, but its answer was lost.
    final f = fake(fileSize: 100, uploadResults: [connectionError], offsetResults: [100]);

    await f.run();

    expect(f.uploads, [0]);
  });

  test('queries the offset first when asked, retrying on connection errors', () async {
    final f = fake(queryOffsetFirst: true, uploadResults: [null], offsetResults: [connectionError, 40]);

    await f.run();

    expect(f.uploads, [40]);
    expect(f.queries(), 2);
  });

  test('stops when cancelled while querying the offset', () async {
    var cancelled = false;
    final f = fake(
      uploadResults: [connectionError, null],
      offsetResults: [40],
      isCancelled: () => cancelled,
      onQuery: () => cancelled = true,
    );

    await expectLater(f.run(), throwsA(connectionError));

    expect(f.uploads, [0]);
  });
}
