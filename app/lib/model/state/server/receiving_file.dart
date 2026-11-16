import 'package:dart_mappable/dart_mappable.dart';
import 'package:localsend_isolates/model/dto/file_dto.dart';

part 'receiving_file.mapper.dart';

@MappableClass()
class ReceivingFile with ReceivingFileMappable {
  final FileDto file;
  final String? token;
  final String? desiredName; // not null when accepted
  final String? path; // when finished
  final bool savedToGallery; // when finished
  final String? errorMessage; // when failed; the live status is tracked in fileTransferProvider

  /// Bytes of the file this device already holds from an earlier, interrupted
  /// transfer: the transfer continues there.
  final int resumeOffset;

  /// The upload broke off and waits for the sender to reconnect.
  final bool interrupted;

  const ReceivingFile({
    required this.file,
    required this.token,
    required this.desiredName,
    required this.path,
    required this.savedToGallery,
    required this.errorMessage,
    this.resumeOffset = 0,
    this.interrupted = false,
  });
}
