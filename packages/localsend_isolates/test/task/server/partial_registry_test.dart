import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:localsend_isolates/src/task/server/partial_registry.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory tempDir;
  late String registryPath;
  var now = DateTime.utc(2026, 11, 16, 12);

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('partial_registry_test');
    registryPath = p.join(tempDir.path, 'resume', 'partials.json');
    now = DateTime.utc(2026, 11, 16, 12);
  });

  tearDown(() {
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  /// A partial file of [length] bytes on disk with the given registry entry.
  PartialEntry entry({
    String id = 'e1',
    String senderFingerprint = 'SENDER',
    String sha256 = 'abc',
    int size = 100,
    int committed = 40,
    int length = 40,
    String destinationDirectory = '/downloads',
    bool saveToGallery = false,
    DateTime? updatedAt,
  }) {
    final path = p.join(tempDir.path, '.$id.lspart');
    File(path).writeAsBytesSync(List.filled(length, 1));
    return PartialEntry(
      id: id,
      senderFingerprint: senderFingerprint,
      sha256: sha256,
      size: size,
      fileName: 'video.mp4',
      partialPath: path,
      partialUri: null,
      destinationDirectory: destinationDirectory,
      saveToGallery: saveToGallery,
      committed: committed,
      createdAt: updatedAt ?? now,
      updatedAt: updatedAt ?? now,
    );
  }

  Future<PartialRegistry> registry({Future<void> Function(PartialEntry)? deleteContent}) async {
    final registry = PartialRegistry(filePath: registryPath, now: () => now, deleteContent: deleteContent);
    await registry.load();
    return registry;
  }

  test('match returns offset for same sender, sha256 and size', () async {
    final r = await registry();
    await r.upsert(entry());

    final match = await r.match(senderFingerprint: 'SENDER', sha256: 'abc', size: 100);

    expect(match, isNotNull);
    expect(match!.entry.id, 'e1');
    expect(match.offset, 40);
  });

  test('match returns null for another sender fingerprint', () async {
    final r = await registry();
    await r.upsert(entry());

    expect(await r.match(senderFingerprint: 'OTHER', sha256: 'abc', size: 100), isNull);
    expect(await r.match(senderFingerprint: 'SENDER', sha256: 'def', size: 100), isNull);
    expect(await r.match(senderFingerprint: 'SENDER', sha256: 'abc', size: 99), isNull);
  });

  test('match returns null and drops entry when content is missing', () async {
    final r = await registry();
    final e = entry();
    await r.upsert(e);
    File(e.partialPath!).deleteSync();

    expect(await r.match(senderFingerprint: 'SENDER', sha256: 'abc', size: 100), isNull);
    expect(r.entries, isEmpty);
  });

  test('offset is the smaller of committed and actual length', () async {
    final r = await registry();
    await r.upsert(entry(id: 'longer', sha256: 'a', committed: 30, length: 50));
    await r.upsert(entry(id: 'shorter', sha256: 'b', committed: 80, length: 50));

    expect((await r.match(senderFingerprint: 'SENDER', sha256: 'a', size: 100))!.offset, 30);
    expect((await r.match(senderFingerprint: 'SENDER', sha256: 'b', size: 100))!.offset, 50);
  });

  test('purgeExpired removes entries older than 7 days and deletes content', () async {
    final deleted = <String>[];
    final r = await registry(deleteContent: (e) async => deleted.add(e.id));
    await r.upsert(entry(id: 'old', sha256: 'a', updatedAt: now.subtract(const Duration(days: 8))));
    await r.upsert(entry(id: 'fresh', sha256: 'b', updatedAt: now.subtract(const Duration(days: 1))));

    await r.purgeExpired();

    expect(deleted, ['old']);
    expect(r.entries.map((e) => e.id), ['fresh']);
  });

  test('corrupt registry file loads as empty', () async {
    File(registryPath)
      ..createSync(recursive: true)
      ..writeAsStringSync('{not json');

    final r = await registry();
    expect(await r.match(senderFingerprint: 'SENDER', sha256: 'abc', size: 100), isNull);

    await r.upsert(entry());
    final reloaded = await registry();
    expect(reloaded.entries.map((e) => e.id), ['e1']);
  });

  test('registry survives reload', () async {
    final r = await registry();
    await r.upsert(entry());
    await r.updateCommitted('e1', 40);

    final reloaded = await registry();
    final match = await reloaded.match(senderFingerprint: 'SENDER', sha256: 'abc', size: 100);

    expect(match!.entry.fileName, 'video.mp4');
    expect(match.entry.destinationDirectory, '/downloads');
    expect(match.offset, 40);
  });

  test('concurrent updates are all persisted', () async {
    final r = await registry();
    await r.upsert(entry(id: 'a', sha256: 'a'));
    await r.upsert(entry(id: 'b', sha256: 'b'));

    // Progress of one file and the interruption of another arrive together.
    await Future.wait([
      for (var i = 1; i <= 20; i++) r.updateCommitted(i.isEven ? 'a' : 'b', i),
    ]);

    final reloaded = await registry();
    final committed = {for (final e in reloaded.entries) e.id: e.committed};
    expect(committed, {'a': 20, 'b': 19});
    expect(File('$registryPath.tmp').existsSync(), isFalse);
  });

  test('confirmResumeOffsets drops files whose destination or gallery setting changed', () {
    final same = entry(id: 'same', sha256: 'a');
    final otherFolder = entry(id: 'folder', sha256: 'b', destinationDirectory: '/elsewhere');
    final otherGallery = entry(id: 'gallery', sha256: 'c', saveToGallery: true);

    final offsets = confirmResumeOffsets(
      matches: {
        'f1': (entry: same, offset: 40),
        'f2': (entry: otherFolder, offset: 40),
        'f3': (entry: otherGallery, offset: 40),
      },
      destinationDirectory: '/downloads',
      saveToGallery: false,
    );

    expect(offsets, {'f1': 40});
  });
}
