import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:logging/logging.dart';

final _logger = Logger('PartialRegistry');

/// A partially received file that a later transfer of the same file from
/// the same sender can continue (resumable uploads).
class PartialEntry {
  final String id;

  /// The certificate fingerprint of the sender. Only this sender may continue
  /// the file.
  final String senderFingerprint;

  /// SHA-256 of the complete file, as announced by the sender.
  final String sha256;

  /// Size of the complete file in bytes.
  final int size;

  /// The name the sender gave the file.
  final String fileName;

  /// Location of the partial file: a path, or (Android SAF) a document URI.
  final String? partialPath;
  final String? partialUri;

  /// Where the complete file should end up, and whether it goes to the gallery.
  /// A later transfer only continues the file when these are unchanged.
  final String destinationDirectory;
  final bool saveToGallery;

  /// Bytes of the file durably stored in the partial file.
  final int committed;

  final DateTime createdAt;
  final DateTime updatedAt;

  const PartialEntry({
    required this.id,
    required this.senderFingerprint,
    required this.sha256,
    required this.size,
    required this.fileName,
    required this.partialPath,
    required this.partialUri,
    required this.destinationDirectory,
    required this.saveToGallery,
    required this.committed,
    required this.createdAt,
    required this.updatedAt,
  });

  PartialEntry copyWith({int? committed, DateTime? updatedAt}) {
    return PartialEntry(
      id: id,
      senderFingerprint: senderFingerprint,
      sha256: sha256,
      size: size,
      fileName: fileName,
      partialPath: partialPath,
      partialUri: partialUri,
      destinationDirectory: destinationDirectory,
      saveToGallery: saveToGallery,
      committed: committed ?? this.committed,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'senderFingerprint': senderFingerprint,
    'sha256': sha256,
    'size': size,
    'fileName': fileName,
    'partialPath': partialPath,
    'partialUri': partialUri,
    'destinationDirectory': destinationDirectory,
    'saveToGallery': saveToGallery,
    'committed': committed,
    'createdAt': createdAt.toUtc().toIso8601String(),
    'updatedAt': updatedAt.toUtc().toIso8601String(),
  };

  factory PartialEntry.fromJson(Map<String, Object?> json) {
    return PartialEntry(
      id: json['id'] as String,
      senderFingerprint: json['senderFingerprint'] as String,
      sha256: json['sha256'] as String,
      size: json['size'] as int,
      fileName: json['fileName'] as String,
      partialPath: json['partialPath'] as String?,
      partialUri: json['partialUri'] as String?,
      destinationDirectory: json['destinationDirectory'] as String,
      saveToGallery: json['saveToGallery'] as bool,
      committed: json['committed'] as int,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}

/// A partial file that matches a file offered by a sender, and the offset the
/// transfer of the file can continue at.
typedef PartialMatch = ({PartialEntry entry, int offset});

/// The partially received files, persisted as JSON at [filePath].
///
/// Survives the application being killed: the file is replaced atomically and
/// a damaged file is treated as empty.
class PartialRegistry {
  final String filePath;
  final DateTime Function() _now;

  /// The actual length of an entry's partial file; `-1` when it is gone and
  /// `null` when it cannot be determined (e.g. a SAF document).
  final Future<int?> Function(PartialEntry) _lengthOf;

  /// Deletes an entry's partial file.
  final Future<void> Function(PartialEntry) _deleteContent;

  final Map<String, PartialEntry> _entries = {};

  PartialRegistry({
    required this.filePath,
    DateTime Function()? now,
    Future<int?> Function(PartialEntry)? lengthOf,
    Future<void> Function(PartialEntry)? deleteContent,
  }) : _now = now ?? DateTime.now,
       _lengthOf = lengthOf ?? _pathLength,
       _deleteContent = deleteContent ?? _deletePath;

  List<PartialEntry> get entries => List.unmodifiable(_entries.values);

  Future<void> load() async {
    _entries.clear();
    final file = File(filePath);
    if (!await file.exists()) {
      return;
    }
    try {
      final json = jsonDecode(await file.readAsString()) as Map<String, Object?>;
      for (final raw in json['entries'] as List<Object?>) {
        final entry = PartialEntry.fromJson(raw as Map<String, Object?>);
        _entries[entry.id] = entry;
      }
    } catch (e) {
      _logger.warning('Ignoring the damaged partial file registry', e);
      _entries.clear();
    }
  }

  /// The partial file of [sha256] and [size] received from [senderFingerprint].
  ///
  /// Entries whose partial file is gone are dropped.
  Future<PartialMatch?> match({required String senderFingerprint, required String sha256, required int size}) async {
    for (final entry in _entries.values.toList()) {
      if (entry.senderFingerprint != senderFingerprint || entry.sha256.toLowerCase() != sha256.toLowerCase() || entry.size != size) {
        continue;
      }
      final length = await _lengthOf(entry);
      if (length == -1) {
        await remove(entry.id);
        continue;
      }
      return (entry: entry, offset: min(entry.committed, length ?? entry.committed));
    }
    return null;
  }

  Future<void> upsert(PartialEntry entry) async {
    _entries[entry.id] = entry;
    await _save();
  }

  Future<void> updateCommitted(String id, int committed) async {
    final entry = _entries[id];
    if (entry == null) {
      return;
    }
    _entries[id] = entry.copyWith(committed: committed, updatedAt: _now());
    await _save();
  }

  Future<void> remove(String id, {bool deleteContent = false}) async {
    final entry = _entries.remove(id);
    if (entry == null) {
      return;
    }
    if (deleteContent) {
      await _tryDelete(entry);
    }
    await _save();
  }

  /// Deletes entries (and their partial files) not updated for [maxAge].
  Future<void> purgeExpired({Duration maxAge = const Duration(days: 7)}) async {
    final cutoff = _now().subtract(maxAge);
    final expired = _entries.values.where((entry) => entry.updatedAt.isBefore(cutoff)).toList();
    if (expired.isEmpty) {
      return;
    }
    for (final entry in expired) {
      _logger.info('Deleting the expired partial file of ${entry.fileName}');
      _entries.remove(entry.id);
      await _tryDelete(entry);
    }
    await _save();
  }

  Future<void> _tryDelete(PartialEntry entry) async {
    try {
      await _deleteContent(entry);
    } catch (e) {
      _logger.warning('Could not delete the partial file of ${entry.fileName}', e);
    }
  }

  Future<void> _save() async {
    final file = File(filePath);
    await file.parent.create(recursive: true);
    final temp = File('$filePath.tmp');
    await temp.writeAsString(jsonEncode({'entries': _entries.values.map((entry) => entry.toJson()).toList()}), flush: true);
    await temp.rename(filePath);
  }
}

Future<int?> _pathLength(PartialEntry entry) async {
  final path = entry.partialPath;
  if (path == null) {
    return null;
  }
  final file = File(path);
  return await file.exists() ? await file.length() : -1;
}

Future<void> _deletePath(PartialEntry entry) async {
  final path = entry.partialPath;
  if (path != null && await File(path).exists()) {
    await File(path).delete();
  }
}

/// The offsets to offer the sender once the receiver accepted: a file only
/// continues when its partial file was meant for the same destination
/// ([destinationDirectory], [saveToGallery]); otherwise it starts over.
Map<String, int> confirmResumeOffsets({
  required Map<String, PartialMatch> matches,
  required String destinationDirectory,
  required bool saveToGallery,
}) {
  return {
    for (final MapEntry(key: fileId, value: match) in matches.entries)
      if (match.offset > 0 && match.entry.destinationDirectory == destinationDirectory && match.entry.saveToGallery == saveToGallery)
        fileId: match.offset,
  };
}
