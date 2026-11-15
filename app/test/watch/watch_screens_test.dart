// Renders LocalSend's real pages at the size of a Unisoc W527 smartwatch
// (408x502 px @ 200 dpi => devicePixelRatio 1.25, ~326x400 logical) and
// reports every layout overflow, plus a golden PNG per screen.
//
// Run (from app/):
//   flutter test test/watch/watch_screens_test.dart --update-goldens
//
// Every overflow is printed as a line starting with `[WATCH-OVERFLOW]`,
// other errors as `[WATCH-ERROR]`, and a per-page summary as `[WATCH-PAGE]`.
// The test does not fail on overflows (it is a report); pass --dart-define=WATCH_STRICT=true to fail on them.
// Pass --dart-define=WATCH_SIZE=phone to render the same scenarios at 412x915 @ 2.625 into goldens_phone/.
// ignore_for_file: avoid_print

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dart_mappable/dart_mappable.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:localsend_app/config/theme.dart';
import 'package:localsend_app/gen/strings.g.dart';
import 'package:localsend_app/model/cross_file.dart';
import 'package:localsend_app/model/persistence/color_mode.dart';
import 'package:localsend_app/model/persistence/favorite_device.dart';
import 'package:localsend_app/model/persistence/receive_history_entry.dart';
import 'package:localsend_app/model/state/nearby_devices_state.dart';
import 'package:localsend_app/model/state/network_state.dart';
import 'package:localsend_app/model/state/send/send_session_state.dart';
import 'package:localsend_app/model/state/send/sending_file.dart';
import 'package:localsend_app/model/state/send/web/web_download_file.dart';
import 'package:localsend_app/model/state/send/web/web_download_session.dart';
import 'package:localsend_app/model/state/send/web/web_download_state.dart';
import 'package:localsend_app/model/state/server/receive_session_state.dart';
import 'package:localsend_app/model/state/server/receiving_file.dart';
import 'package:localsend_app/model/state/server/server_state.dart';
import 'package:localsend_app/model/state/server/web_share_state.dart';
import 'package:localsend_app/pages/about/about_page.dart';
import 'package:localsend_app/pages/device_details_page.dart';
import 'package:localsend_app/pages/home_page.dart';
import 'package:localsend_app/pages/language_page.dart';
import 'package:localsend_app/pages/progress_page.dart';
import 'package:localsend_app/pages/receive_history_page.dart';
import 'package:localsend_app/pages/receive_options_page.dart';
import 'package:localsend_app/pages/receive_page.dart';
import 'package:localsend_app/pages/selected_files_page.dart';
import 'package:localsend_app/pages/send_page.dart';
import 'package:localsend_app/pages/tabs/send_tab.dart';
import 'package:localsend_app/pages/tabs/settings_tab.dart';
import 'package:localsend_app/pages/troubleshoot_page.dart';
import 'package:localsend_app/pages/verify_page.dart';
import 'package:localsend_app/pages/web_share_page.dart';
import 'package:localsend_app/pages/whats_new_page.dart';
import 'package:localsend_app/provider/animation_provider.dart';
import 'package:localsend_app/provider/app_arguments_provider.dart';
import 'package:localsend_app/provider/device_info_provider.dart';
import 'package:localsend_app/provider/favorites_provider.dart';
import 'package:localsend_app/provider/file_transfer_provider.dart';
import 'package:localsend_app/provider/local_ip_provider.dart';
import 'package:localsend_app/provider/logging/discovery_logs_provider.dart';
import 'package:localsend_app/provider/network/nearby_devices_provider.dart';
import 'package:localsend_app/provider/network/send_provider.dart';
import 'package:localsend_app/provider/network/server/server_provider.dart';
import 'package:localsend_app/provider/persistence_provider.dart';
import 'package:localsend_app/provider/selection/selected_receiving_files_provider.dart';
import 'package:localsend_app/provider/selection/selected_sending_files_provider.dart';
import 'package:localsend_app/provider/settings_provider.dart';
import 'package:localsend_app/provider/tv_provider.dart';
import 'package:localsend_app/util/ui/dynamic_colors.dart';
import 'package:localsend_app/widget/dialogs/add_file_dialog.dart';
import 'package:localsend_app/widget/dialogs/address_input_dialog.dart';
import 'package:localsend_app/widget/dialogs/cancel_session_dialog.dart';
import 'package:localsend_app/widget/dialogs/error_dialog.dart';
import 'package:localsend_app/widget/dialogs/favorite_dialog.dart';
import 'package:localsend_app/widget/dialogs/local_network_dialog.dart';
import 'package:localsend_app/widget/dialogs/message_input_dialog.dart';
import 'package:localsend_app/widget/dialogs/no_permission_dialog.dart';
import 'package:localsend_app/widget/dialogs/pin_dialog.dart';
import 'package:localsend_app/widget/dialogs/qr_dialog.dart';
import 'package:localsend_app/widget/dialogs/send_mode_help_dialog.dart';
import 'package:localsend_app/widget/watcher/window_brightness_watcher.dart';
import 'package:localsend_isolates/isolate.dart';
import 'package:localsend_isolates/model/device.dart';
import 'package:localsend_isolates/model/device_info_result.dart';
import 'package:localsend_isolates/model/dto/file_dto.dart';
import 'package:localsend_isolates/model/dto/multicast_dto.dart';
import 'package:localsend_isolates/model/file_status.dart';
import 'package:localsend_isolates/model/file_type.dart';
import 'package:localsend_isolates/model/session_status.dart';
import 'package:localsend_isolates/model/stored_security_context.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:refena_flutter/addons.dart';
import 'package:refena_flutter/refena_flutter.dart';
import 'package:routerino/routerino.dart';
import 'package:share_handler/share_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:system_date_time_format/system_date_time_format.dart';

// ---------------------------------------------------------------------------
// Device profile: Unisoc W527, Android 9, 408x502 px, 200 dpi.
// ---------------------------------------------------------------------------
// --dart-define=WATCH_SIZE=phone renders the same scenarios at a typical phone size
// (412x915 logical @ 2.625) into goldens_phone/, as a baseline proving phone layouts stay unchanged.
const _sizeProfile = String.fromEnvironment('WATCH_SIZE', defaultValue: 'watch');
const _isPhone = _sizeProfile == 'phone';
const _dpr = _isPhone ? 2.625 : 1.25;
const _logicalSize = _isPhone ? Size(412, 915) : Size(326, 400);
final _physicalSize = _logicalSize * _dpr; // watch: 407.5 x 500, phone: 1081.5 x 2401.875
const _goldenDir = _isPhone ? 'goldens_phone' : 'goldens';

const _strict = bool.fromEnvironment('WATCH_STRICT');

final _boundaryKey = GlobalKey();

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

Directory? _findFlutterCache() {
  final candidates = <String>[
    if (Platform.environment['FLUTTER_ROOT'] != null) '${Platform.environment['FLUTTER_ROOT']}/bin/cache',
    'C:/flutter/bin/cache',
  ];
  // flutter_tester lives in <flutter>/bin/cache/artifacts/engine/<platform>/
  var dir = File(Platform.resolvedExecutable).parent;
  for (var i = 0; i < 6; i++) {
    if (dir.path.endsWith('cache') || dir.uri.pathSegments.where((s) => s.isNotEmpty).lastOrNull == 'cache') {
      candidates.insert(0, dir.path);
      break;
    }
    dir = dir.parent;
  }
  for (final c in candidates) {
    final d = Directory('$c/artifacts/material_fonts');
    if (d.existsSync()) {
      return d;
    }
  }
  return null;
}

final _loadedFonts = <String>[];

Future<void> _loadFonts() async {
  final materialFonts = _findFlutterCache();
  if (materialFonts == null) {
    print('[WATCH-ERROR] material fonts not found; goldens will use the test font');
    return;
  }

  Future<ByteData> read(String path) async {
    final bytes = await File(path).readAsBytes();
    return ByteData.view(bytes.buffer);
  }

  final roboto = FontLoader('Roboto');
  for (final f in materialFonts.listSync().whereType<File>()) {
    final name = f.uri.pathSegments.last;
    if (name.startsWith('roboto-') && name.endsWith('.ttf')) {
      roboto.addFont(read(f.path));
      _loadedFonts.add(name);
    }
  }
  // Android renders CJK through the system fallback font (Noto Sans CJK).
  // The test engine has no system fallback, so add a CJK face to the Roboto family.
  for (final cjk in const ['C:/Windows/Fonts/NotoSansTC-VF.ttf', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']) {
    if (File(cjk).existsSync()) {
      roboto.addFont(read(cjk));
      _loadedFonts.add(cjk);
      break;
    }
  }
  await roboto.load();

  final icons = FontLoader('MaterialIcons')..addFont(read('${materialFonts.path}/materialicons-regular.otf'));
  await icons.load();
  _loadedFonts.add('materialicons-regular.otf');

  // Also register the CJK face under its own family, used as a fallback below.
  for (final cjk in const ['C:/Windows/Fonts/NotoSansTC-VF.ttf']) {
    if (File(cjk).existsSync()) {
      final l = FontLoader('NotoSansTC')..addFont(read(cjk));
      await l.load();
    }
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class _FakeServerService extends ServerService {
  final ServerState? initial;

  _FakeServerService(this.initial);

  @override
  ServerState? init() => initial;

  @override
  Future<ServerState?> startServerFromSettings() async {
    final s = ref.read(settingsProvider);
    return startServer(alias: s.alias, port: s.port, https: s.https);
  }

  @override
  Future<ServerState?> startServer({required String alias, required int port, required bool https, WebShareState? web}) async {
    if (state != null) {
      return null;
    }
    state = ServerState(alias: alias, port: port, https: https, session: null, web: web);
    return state;
  }

  @override
  Future<void> stopServer() async {
    state = null;
  }

  @override
  Future<void> restartServerWithWebDownload({
    required String alias,
    required int port,
    required bool https,
    required List<CrossFile> files,
    String? pin,
  }) async {
    await restartServer(
      alias: alias,
      port: port,
      https: https,
      web: WebShareDownload(
        pin: pin,
        state: WebDownloadState(
          sessions: const {
            's1': WebDownloadSession(sessionId: 's1', pending: true, ip: '192.168.1.57', deviceInfo: 'Chrome (Windows)'),
            's2': WebDownloadSession(sessionId: 's2', pending: false, ip: '192.168.1.80', deviceInfo: 'Safari (iOS)'),
          },
          files: {
            for (final (i, f) in files.indexed)
              'f$i': WebDownloadFile(
                file: FileDto(id: 'f$i', fileName: f.name, size: f.size, fileType: f.fileType, hash: null, preview: null, metadata: null),
                asset: null,
                path: f.path,
                bytes: f.bytes,
              ),
          },
          autoAccept: false,
        ),
      ),
    );
  }

  @override
  Future<void> setWebPin(String? pin) async {}

  @override
  Future<void> ensureRunning() async {}

  @override
  Future<void> acceptFileRequest(Map<String, String> fileNameMap) async {}

  @override
  void declineFileRequest() {}

  @override
  void cancelSession() {}

  @override
  void closeSession() {}
}

class _FakeNearbyDevicesService extends NearbyDevicesService {
  final Map<String, Device> initialDevices;

  _FakeNearbyDevicesService(Ref ref, this.initialDevices)
    : super(
        isolateController: ref.notifier(parentIsolateProvider),
        favoriteService: ref.notifier(favoritesProvider),
        discoveryLogs: ref.notifier(discoveryLoggerProvider),
      );

  @override
  NearbyDevicesState init() => NearbyDevicesState(
    runningFavoriteScan: false,
    runningIps: const {},
    devices: initialDevices,
    signalingDevices: const {},
  );
}

class _FakeLocalIpService extends LocalIpService {
  _FakeLocalIpService(super.settingsService);

  @override
  NetworkState init() => const NetworkState(localIps: ['192.168.1.23'], initialized: true);

  @override
  get initialAction => null;
}

class _FakeShareHandler extends ShareHandlerPlatform {
  @override
  Future<SharedMedia?> getInitialSharedMedia() async => null;

  @override
  Future<void> resetInitialSharedMedia() async {}

  @override
  Future<void> recordSentMessage({
    required String conversationIdentifier,
    required String conversationName,
    String? conversationImageFilePath,
    String? serviceName,
  }) async {}

  @override
  Stream<SharedMedia> get sharedMediaStream => const Stream.empty();
}

class _FakeSendNotifier extends SendNotifier {
  final Map<String, SendSessionState> initial;

  _FakeSendNotifier(this.initial);

  @override
  Map<String, SendSessionState> init() => initial;
}

class _FakeSelectedSendingFiles extends SelectedSendingFilesNotifier {
  final List<CrossFile> initial;

  _FakeSelectedSendingFiles(this.initial);

  @override
  List<CrossFile> init() => initial;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const _securityContext = StoredSecurityContext(
  privateKey: 'PRIVATE',
  publicKey: 'PUBLIC',
  certificate: 'CERT',
  certificateHash: 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90',
);

const _phone = Device(
  signalingId: null,
  ip: '192.168.1.57',
  version: '2.1',
  port: 53317,
  https: true,
  fingerprint: 'FFEEDDCCBBAA99887766554433221100FFEEDDCCBBAA99887766554433221100',
  alias: 'Smart Strawberry',
  deviceModel: 'Samsung Galaxy S24 Ultra',
  deviceType: DeviceType.mobile,
  download: false,
  channels: [HttpChannel(host: '192.168.1.57', port: 53317, https: true)],
);

const _laptop = Device(
  signalingId: null,
  ip: '192.168.1.80',
  version: '2.1',
  port: 53317,
  https: true,
  fingerprint: '00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF',
  alias: 'Accurate Pineapple With A Very Long Name',
  deviceModel: 'Windows',
  deviceType: DeviceType.desktop,
  download: false,
  channels: [HttpChannel(host: '192.168.1.80', port: 53317, https: true)],
);

const _files = [
  FileDto(id: 'f1', fileName: 'IMG_20261115_093012_HDR.jpg', size: 4823112, fileType: FileType.image, hash: null, preview: null, metadata: null),
  FileDto(
    id: 'f2',
    fileName: 'Quarterly report - final version (2).pdf',
    size: 1234567,
    fileType: FileType.pdf,
    hash: null,
    preview: null,
    metadata: null,
  ),
  FileDto(id: 'f3', fileName: 'VID_20261114_181500.mp4', size: 98234112, fileType: FileType.video, hash: null, preview: null, metadata: null),
];

const _crossFiles = [
  CrossFile(
    name: 'IMG_20261115_093012_HDR.jpg',
    fileType: FileType.image,
    size: 4823112,
    thumbnail: null,
    asset: null,
    path: '/storage/emulated/0/DCIM/IMG_20261115_093012_HDR.jpg',
    bytes: null,
    lastModified: null,
    lastAccessed: null,
  ),
  CrossFile(
    name: 'Quarterly report - final version (2).pdf',
    fileType: FileType.pdf,
    size: 1234567,
    thumbnail: null,
    asset: null,
    path: '/storage/emulated/0/Download/report.pdf',
    bytes: null,
    lastModified: null,
    lastAccessed: null,
  ),
  CrossFile(
    name: 'notes.txt',
    fileType: FileType.text,
    size: 22,
    thumbnail: null,
    asset: null,
    path: null,
    bytes: [104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 32, 102, 114, 111, 109, 32, 119, 97, 116, 99, 104],
    lastModified: null,
    lastAccessed: null,
  ),
];

/// Start time a few seconds ago, so the remaining-time label shows a realistic value instead of hundreds of hours.
int _recentStart() => DateTime.now().subtract(const Duration(seconds: 20)).millisecondsSinceEpoch;

ReceiveSessionState _receiveSession(
  SessionStatus status, {
  List<FileDto> files = _files,
  Device sender = _phone,
  bool finished = false,
}) {
  final start = _recentStart();
  return ReceiveSessionState(
    sessionId: 'rs1',
    status: status,
    sender: sender,
    senderAlias: sender.alias,
    files: {
      for (final f in files)
        f.id: ReceivingFile(
          file: f,
          token: null,
          desiredName: f.fileName,
          path: finished ? '/storage/emulated/0/Download/${f.fileName}' : null,
          savedToGallery: finished && f.fileType == FileType.image,
          errorMessage: null,
        ),
    },
    startTime: start,
    endTime: finished ? start + 15000 : null,
    destinationDirectory: '/storage/emulated/0/Download',
    cacheDirectory: '/data/cache',
    saveToGallery: true,
    createdDirectories: const {},
  );
}

SendSessionState _sendSession(SessionStatus status, {int hashedFileCount = 1, String? errorMessage, Map<String, String> fileErrors = const {}}) {
  final start = _recentStart();
  return SendSessionState(
    sessionId: 'ss1',
    remoteSessionId: null,
    background: false,
    status: status,
    target: _laptop,
    files: {
      for (final f in _files)
        f.id: SendingFile(
          file: f,
          token: null,
          thumbnail: null,
          asset: null,
          path: '/sdcard/${f.fileName}',
          bytes: null,
          errorMessage: fileErrors[f.id],
        ),
    },
    hashedFileCount: hashedFileCount,
    startTime: start,
    endTime: status == SessionStatus.sending || status == SessionStatus.waiting ? null : start + 15000,
    sendingTasks: null,
    errorMessage: errorMessage,
  );
}

/// The server as it runs in the real app (started by postInit), so "my device" shows the real alias.
const _runningServer = ServerState(alias: 'Wise Watch', port: 53317, https: true, session: null, web: null);

List<FileDto> _manyFiles(int n) => [
  for (var i = 0; i < n; i++)
    FileDto(
      id: 'm$i',
      fileName: 'Holiday_photo_${2026 + i}_IMG_${1000 + i}.jpg',
      size: 2000000 + i * 12345,
      fileType: FileType.image,
      hash: null,
      preview: null,
      metadata: null,
    ),
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class _Report {
  final String page;
  final overflows = <String>[];
  final otherErrors = <String>{};
  final renderErrors = <String>{};
  final goldens = <String>[];

  _Report(this.page);
}

final _reports = <_Report>[];

String _relevantLocation(String text) {
  final lines = text.split('\n');
  final idx = lines.indexWhere((l) => l.contains('The relevant error-causing widget was'));
  if (idx != -1) {
    for (var i = idx + 1; i < lines.length && i < idx + 6; i++) {
      final l = lines[i].trim();
      final m = RegExp(r'file:///\S*?/(lib/\S+)').firstMatch(l);
      if (m != null) {
        return '${l.split(':file:').first} ${m.group(1)}';
      }
    }
  }
  final fileLine = lines.firstWhere((l) => l.contains('package:localsend_app/') || l.contains('/lib/'), orElse: () => '');
  return fileLine.trim();
}

String _rendererInfo(FlutterErrorDetails details) {
  final s = details.toString();
  final m = RegExp(r'(The overflowing (?:RenderFlex|Render\w+) has[^\n]*)').firstMatch(s);
  final constraints = RegExp(r'constraints: (BoxConstraints\([^)]*\))').firstMatch(s);
  return [if (m != null) m.group(1)!, if (constraints != null) 'constraints=${constraints.group(1)}'].join(' ');
}

void _mockPlatformChannels(WidgetTester tester) {
  final messenger = tester.binding.defaultBinaryMessenger;
  Future<Object?> nullHandler(MethodCall call) async => null;
  for (final name in const [
    'org.localsend.localsend_app/localsend',
    'org.localsend.localsend_app/platform',
    'com.kasem.flutter_displaymode',
    'flutter_displaymode',
    'com.shoutsocial.share_handler',
    'share_handler',
    'dev.fluttercommunity.plus/connectivity',
    'dev.fluttercommunity.plus/network_info',
    'dev.fluttercommunity.plus/device_info',
    'dev.fluttercommunity.plus/wakelock_plus',
    'wakelock_plus',
    'miguelruivo.flutter.plugins.filepicker',
    'plugins.flutter.io/path_provider',
    'plugins.flutter.io/url_launcher_android',
    'plugins.flutter.io/in_app_purchase',
    'io.material.plugins/dynamic_color',
    'system_date_time_format',
    'flutter.baseflow.com/permissions/methods',
    'tray_manager',
    'window_manager',
    'screen_retriever',
  ]) {
    messenger.setMockMethodCallHandler(MethodChannel(name), (call) async {
      if (call.method == 'requestLocalNetworkPermission') {
        return true;
      }
      return nullHandler(call);
    });
  }
  // permission_handler: report granted
  messenger.setMockMethodCallHandler(const MethodChannel('flutter.baseflow.com/permissions/methods'), (call) async {
    switch (call.method) {
      case 'checkPermissionStatus':
        return 1;
      case 'requestPermissions':
        return {for (final p in (call.arguments as List)) p: 1};
      default:
        return null;
    }
  });
}

class _Env {
  final RefenaContainer container;
  final _Report report;

  _Env(this.container, this.report);

  BuildContext get navContext => container.read(navigationProvider).key.currentContext!;
}

Future<_Env> _setUp(
  WidgetTester tester, {
  required String page,
  required AppLocale locale,
  ServerState? server,
  Map<String, SendSessionState> send = const {},
  List<CrossFile> selected = const [],
  Map<String, Device> nearby = const {},
  Map<String, Object> extraPrefs = const {},
}) async {
  tester.view.physicalSize = _physicalSize;
  tester.view.devicePixelRatio = _dpr;
  tester.platformDispatcher.textScaleFactorTestValue = 1.0;
  tester.platformDispatcher.localesTestValue = [locale.flutterLocale];
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearAllTestValues);

  _mockPlatformChannels(tester);
  ShareHandlerPlatform.instance = _FakeShareHandler();

  MapperContainer.globals.use(const FileDtoMapper());

  PackageInfo.setMockInitialValues(
    appName: 'LocalSend',
    packageName: 'org.localsend.localsend_app',
    version: '1.18.0',
    buildNumber: '100',
    buildSignature: '',
  );

  SharedPreferences.setMockInitialValues({
    'ls_version': 4,
    'ls_security_context': jsonEncode(_securityContext),
    'ls_show_token': 'show-token',
    'ls_alias': 'Wise Watch',
    'ls_color': ColorMode.localsend.name,
    'ls_locale': locale.languageTag,
    'ls_whats_new': '1.18.0',
    'ls_favorites': [
      jsonEncode(
        const FavoriteDevice(
          id: 'fav1',
          fingerprint: 'FFEEDDCCBBAA99887766554433221100FFEEDDCCBBAA99887766554433221100',
          ip: '192.168.1.57',
          port: 53317,
          alias: 'Smart Strawberry',
          customAlias: false,
        ).toJson(),
      ),
    ],
    'ls_receive_history': [
      jsonEncode(
        ReceiveHistoryEntry(
          id: 'h1',
          fileName: 'IMG_20261115_093012_HDR.jpg',
          fileType: FileType.image,
          path: '/storage/emulated/0/Download/IMG_20261115_093012_HDR.jpg',
          savedToGallery: false,
          isMessage: false,
          fileSize: 4823112,
          senderAlias: 'Smart Strawberry',
          timestamp: DateTime.utc(2026, 11, 15, 9, 30),
        ).toJson(),
      ),
      jsonEncode(
        ReceiveHistoryEntry(
          id: 'h2',
          fileName: 'Hello from the phone, this is a fairly long text message',
          fileType: FileType.text,
          path: null,
          savedToGallery: false,
          isMessage: true,
          fileSize: 56,
          senderAlias: 'Accurate Pineapple',
          timestamp: DateTime.utc(2026, 11, 14, 18, 15),
        ).toJson(),
      ),
    ],
    ...extraPrefs,
  });

  final persistence = (await tester.runAsync(() => PersistenceService.initialize(supportsDynamicColors: false)))!;
  await tester.runAsync(() => LocaleSettings.setLocale(locale));

  final container = RefenaContainer(
    overrides: [
      persistenceProvider.overrideWithValue(persistence),
      deviceRawInfoProvider.overrideWithValue(DeviceInfoResult(deviceType: DeviceType.mobile, deviceModel: 'W527', androidSdkInt: 28)),
      appArgumentsProvider.overrideWithValue(const <String>[]),
      tvProvider.overrideWithValue(false),
      dynamicColorsProvider.overrideWithValue(null),
      sleepProvider.overrideWithInitialState((ref) => false),
      parentIsolateProvider.overrideWithNotifier((ref) {
        final settings = ref.read(settingsProvider);
        return IsolateController(
          initialState: ParentIsolateState.initial(
            SyncState(
              rootIsolateToken: Object(),
              securityContext: _securityContext,
              deviceInfo: DeviceInfoResult(deviceType: DeviceType.mobile, deviceModel: 'W527', androidSdkInt: 28),
              alias: settings.alias,
              port: settings.port,
              networkWhitelist: settings.networkWhitelist,
              networkBlacklist: settings.networkBlacklist,
              protocol: ProtocolType.https,
              multicastGroup: settings.multicastGroup,
              discoveryTimeout: settings.discoveryTimeout,
              serverRunning: true,
              download: false,
            ),
          ),
        );
      }),
      serverProvider.overrideWithNotifier((ref) => _FakeServerService(server)),
      nearbyDevicesProvider.overrideWithNotifier((ref) => _FakeNearbyDevicesService(ref, nearby)),
      localIpProvider.overrideWithNotifier((ref) => _FakeLocalIpService(ref.notifier(settingsProvider))),
      sendProvider.overrideWithNotifier((ref) => _FakeSendNotifier(send)),
      selectedSendingFilesProvider.overrideWithNotifier((ref) => _FakeSelectedSendingFiles(selected)),
    ],
  );
  Routerino.navigatorKey = container.read(navigationProvider).key;
  setDefaultRouteTransition();

  final report = _Report('${page}_${locale.languageTag}');
  _reports.add(report);
  return _Env(container, report);
}

/// Android resolves CJK glyphs through the system font fallback (Noto Sans CJK); flutter_tester has none,
/// so the same fallback is added explicitly. Latin text still uses Roboto exactly like on the device.
ThemeData _withCjkFallback(ThemeData theme) {
  const fallback = ['NotoSansTC'];
  return theme.copyWith(
    textTheme: theme.textTheme.apply(fontFamilyFallback: fallback),
    primaryTextTheme: theme.primaryTextTheme.apply(fontFamilyFallback: fallback),
  );
}

/// Same MaterialApp as [LocalSendApp] in main.dart, minus the desktop-only watchers and with a configurable home.
class _TestApp extends StatelessWidget {
  final Widget Function() home;

  const _TestApp(this.home);

  @override
  Widget build(BuildContext context) {
    final ref = context.ref;
    final (themeMode, colorMode, customColor) = ref.watch(
      settingsProvider.select((settings) => (settings.theme, settings.colorMode, settings.customColor)),
    );
    final dynamicColors = ref.watch(dynamicColorsProvider);
    return MaterialApp(
      title: t.appName,
      locale: TranslationProvider.of(context).flutterLocale,
      supportedLocales: AppLocaleUtils.supportedLocales,
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      debugShowCheckedModeBanner: false,
      theme: _withCjkFallback(getTheme(colorMode, customColor, Brightness.light, dynamicColors)),
      darkTheme: _withCjkFallback(getTheme(colorMode, customColor, Brightness.dark, dynamicColors)),
      themeMode: colorMode == ColorMode.oled ? ThemeMode.dark : themeMode,
      builder: (context, child) => WindowBrightnessWatcher(child: child!),
      navigatorKey: context.read(navigationProvider).key,
      home: RouterinoHome(builder: home),
    );
  }
}

/// Runs [action] in an error zone so that uncaught async errors of the app (isolate / plugin calls
/// that cannot work in a widget test) are recorded instead of failing the test.
Future<void> _guarded(_Env env, Future<void> Function() action) async {
  final completer = Completer<(Object, StackTrace)?>();
  // ignore: unawaited_futures
  runZonedGuarded(
    () async {
      try {
        await action();
        completer.complete(null);
      } catch (e, st) {
        completer.complete((e, st));
      }
    },
    (e, st) {
      final location = st.toString().split('\n').firstWhere((l) => l.contains('package:localsend'), orElse: () => '');
      final entry = 'async ${e.runtimeType}: ${e.toString().split('\n').first} | ${location.trim()}';
      if (env.report.otherErrors.add(entry)) {
        print('[WATCH-ERROR] ${env.report.page}: $entry');
      }
    },
  );
  final result = await completer.future;
  if (result != null) {
    Error.throwWithStackTrace(result.$1, result.$2);
  }
}

/// Runs [body] with FlutterError.onError replaced, collecting overflows into the env report.
Future<void> _run(WidgetTester tester, _Env env, Widget Function() home, Future<void> Function() body) async {
  final original = FlutterError.onError;
  FlutterError.onError = (details) {
    final text = details.exceptionAsString();
    if (text.contains('overflowed') || text.contains('OVERFLOWING')) {
      final firstLine = text.split('\n').first.trim();
      final entry = '$firstLine | widget: ${_relevantLocation(details.toString())} | ${_rendererInfo(details)}';
      env.report.overflows.add(entry);
      print('[WATCH-OVERFLOW] ${env.report.page}: $entry');
    } else {
      final entry =
          '[${details.library ?? ''}] ${details.exception.runtimeType}: ${text.split('\n').take(3).join(' ')} | ${_relevantLocation(details.toString())}';
      env.report.otherErrors.add(entry);
      if (details.library == 'widgets library' || details.library == 'rendering library') {
        env.report.renderErrors.add(entry);
      }
      print('[WATCH-ERROR] ${env.report.page}: $entry');
    }
  };
  try {
    await _guarded(env, () async {
      await tester.pumpWidget(
        RepaintBoundary(
          key: _boundaryKey,
          child: RefenaScope.withContainer(
            container: env.container,
            child: SDTFScope(
              child: TranslationProvider(
                child: _TestApp(home),
              ),
            ),
          ),
        ),
      );
      await _settle(tester, env);
      await body();
    });
  } catch (e) {
    env.report.renderErrors.add('harness: $e');
    print('[WATCH-RENDER-FAILED] ${env.report.page}: $e');
    rethrow;
  } finally {
    await _guarded(env, () async {
      // Tear down the tree so that pending timers of the pages are cancelled.
      await tester.pumpWidget(const SizedBox());
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(seconds: 1));
      }
    });
    _collectAsync(tester, env);
    FlutterError.onError = original;
    final r = env.report;
    print('[WATCH-PAGE] ${r.page}: overflows=${r.overflows.length} errors=${r.otherErrors.length} goldens=${r.goldens.join(',')}');
  }
  if (_strict) {
    expect(env.report.overflows, isEmpty);
  }
}

void _collectAsync(WidgetTester tester, _Env env) {
  Object? e;
  while ((e = tester.takeException()) != null) {
    env.report.otherErrors.add('pending ${e.runtimeType}: ${e.toString().split('\n').first}');
  }
}

/// pumpAndSettle that tolerates infinite animations.
Future<void> _settle(WidgetTester tester, _Env env) async {
  // Let delayed starts (InitialFadeTransition, sleepAsync, ...) fire before settling.
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(milliseconds: 500));
  }
  try {
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 5));
  } on FlutterError catch (e) {
    if (!e.toString().contains('pumpAndSettle timed out')) {
      rethrow;
    }
    // infinite animation (spinner / rotating icon): just advance time
    await tester.pump(const Duration(seconds: 1));
  }
  // Asset images decode with real I/O, which fake async never runs.
  await tester.runAsync(() async {
    for (final element in find.byType(Image).evaluate()) {
      final image = element.widget as Image;
      try {
        await precacheImage(image.image, element, onError: (_, _) {}).timeout(const Duration(seconds: 2));
      } catch (_) {
        // missing file paths of fixture thumbnails: keep the error placeholder
      }
    }
  });
  await tester.pump(const Duration(milliseconds: 100));
  _collectAsync(tester, env);
}

Future<void> _golden(WidgetTester tester, _Env env, String suffix) async {
  final name = suffix.isEmpty ? env.report.page : '${env.report.page}_$suffix';
  final path = '$_goldenDir/$name.png';
  await expectLater(find.byKey(_boundaryKey), matchesGoldenFile(path));
  env.report.goldens.add(path);
}

/// Captures the screen, then scrolls the biggest vertical scrollable on screen in viewport steps and captures each step.
Future<void> _captureScrolling(WidgetTester tester, _Env env, {String prefix = '', Finder? within}) async {
  await _golden(tester, env, prefix.isEmpty ? '' : prefix);
  final scrollables = (within != null ? find.descendant(of: within, matching: find.byType(Scrollable)) : find.byType(Scrollable)).hitTestable();
  ScrollableState? best;
  for (final element in scrollables.evaluate()) {
    final state = (element as StatefulElement).state as ScrollableState;
    if (state.axisDirection != AxisDirection.down || !state.position.hasContentDimensions) {
      continue;
    }
    if (state.position.maxScrollExtent <= 0) {
      continue;
    }
    if (best == null || state.position.viewportDimension > best.position.viewportDimension) {
      best = state;
    }
  }
  if (best == null) {
    return;
  }
  var step = 1;
  while (best.position.pixels < best.position.maxScrollExtent - 0.5 && step < 30) {
    final target = (best.position.pixels + best.position.viewportDimension * 0.85).clamp(0.0, best.position.maxScrollExtent);
    best.position.jumpTo(target);
    await tester.pump();
    await _settle(tester, env);
    await _golden(tester, env, '${prefix.isEmpty ? '' : '${prefix}_'}scroll$step');
    step++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadFonts();
    print('[WATCH-FONTS] ${_loadedFonts.join(', ')}');
  });

  tearDownAll(() {
    print('\n======== WATCH REPORT [$_sizeProfile] (${_logicalSize.width}x${_logicalSize.height} logical @ $_dpr) ========');
    for (final r in _reports) {
      print('PAGE ${r.page}: ${r.overflows.length} overflow(s), ${r.otherErrors.length} other error(s)');
      for (final o in r.overflows) {
        print('  OVERFLOW $o');
      }
      for (final o in r.otherErrors) {
        print('  ERROR $o');
      }
      for (final g in r.goldens) {
        print('  GOLDEN test/watch/$g');
      }
    }
  });

  for (final locale in const [AppLocale.zhTw, AppLocale.en]) {
    group(locale.languageTag, () {
      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'home receive tab', (tester) async {
        final env = await _setUp(tester, page: 'home_receive', locale: locale);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.receive, appStart: true), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'home send tab (empty selection, nearby devices)', (tester) async {
        final env = await _setUp(tester, page: 'home_send', locale: locale, nearby: {_phone.fingerprint: _phone, _laptop.fingerprint: _laptop});
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.send, appStart: false), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'home send tab (files selected)', (tester) async {
        final env = await _setUp(
          tester,
          page: 'home_send_selected',
          locale: locale,
          selected: _crossFiles,
          nearby: {_phone.fingerprint: _phone, _laptop.fingerprint: _laptop},
        );
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.send, appStart: false), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'home settings tab', (tester) async {
        final env = await _setUp(tester, page: 'home_settings', locale: locale);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.settings, appStart: false), () async {
          await _captureScrolling(tester, env, within: find.byType(SettingsTab));
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'home settings tab (advanced)', (tester) async {
        final env = await _setUp(tester, page: 'home_settings_advanced', locale: locale, extraPrefs: {'ls_advanced_settings': true});
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.settings, appStart: false), () async {
          await _captureScrolling(tester, env, within: find.byType(SettingsTab));
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'receive page (incoming files)', (tester) async {
        final server = ServerState(alias: 'Wise Watch', port: 53317, https: true, session: _receiveSession(SessionStatus.waiting), web: null);
        final env = await _setUp(tester, page: 'receive_page', locale: locale, server: server);
        env.container.notifier(selectedReceivingFilesProvider).setFiles(_files);
        final vm = _receiveVm();
        await _run(tester, env, () => ReceivePage(vm), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'receive page (text message)', (tester) async {
        const msg = FileDto(
          id: 'm1',
          fileName: 'message.txt',
          size: 120,
          fileType: FileType.text,
          hash: null,
          preview: 'Hi! Here is the link to the document we talked about: https://example.com/some/very/long/path?with=query',
          metadata: null,
        );
        final server = ServerState(
          alias: 'Wise Watch',
          port: 53317,
          https: true,
          session: _receiveSession(SessionStatus.waiting, files: const [msg]),
          web: null,
        );
        final env = await _setUp(tester, page: 'receive_page_message', locale: locale, server: server);
        final vm = _receiveVm(message: msg.preview);
        await _run(tester, env, () => ReceivePage(vm), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'receive options page', (tester) async {
        final server = ServerState(alias: 'Wise Watch', port: 53317, https: true, session: _receiveSession(SessionStatus.waiting), web: null);
        final env = await _setUp(tester, page: 'receive_options', locale: locale, server: server);
        env.container.notifier(selectedReceivingFilesProvider).setFiles(_files);
        final vm = env.container.read(_receiveVm());
        await _run(tester, env, () => ReceiveOptionsPage(vm), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'send page (waiting for receiver)', (tester) async {
        final env = await _setUp(
          tester,
          page: 'send_page',
          locale: locale,
          server: _runningServer,
          send: {'ss1': _sendSession(SessionStatus.waiting)},
        );
        await _run(tester, env, () => const SendPage(showAppBar: false, closeSessionOnClose: true, sessionId: 'ss1'), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'send page (declined)', (tester) async {
        final env = await _setUp(
          tester,
          page: 'send_page_declined',
          locale: locale,
          server: _runningServer,
          send: {'ss1': _sendSession(SessionStatus.declined)},
        );
        await _run(tester, env, () => const SendPage(showAppBar: false, closeSessionOnClose: true, sessionId: 'ss1'), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'progress page (receiving)', (tester) async {
        final server = ServerState(alias: 'Wise Watch', port: 53317, https: true, session: _receiveSession(SessionStatus.sending), web: null);
        final env = await _setUp(tester, page: 'progress_receiving', locale: locale, server: server);
        _seedTransfer(env, 'rs1');
        await _run(tester, env, () => const ProgressPage(showAppBar: false, closeSessionOnClose: true, sessionId: 'rs1'), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'progress page (sending)', (tester) async {
        final env = await _setUp(tester, page: 'progress_sending', locale: locale, send: {'ss1': _sendSession(SessionStatus.sending)});
        _seedTransfer(env, 'ss1');
        await _run(tester, env, () => const ProgressPage(showAppBar: true, closeSessionOnClose: false, sessionId: 'ss1'), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'selected files page', (tester) async {
        final env = await _setUp(tester, page: 'selected_files', locale: locale, selected: _crossFiles);
        await _run(tester, env, () => const SelectedFilesPage(), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'web share page (send via link)', (tester) async {
        final env = await _setUp(tester, page: 'web_share', locale: locale);
        await _run(tester, env, () => const WebSharePage(files: _crossFiles), () async {
          await tester.pump(const Duration(seconds: 1));
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'web receive page (receive via link)', (tester) async {
        final env = await _setUp(tester, page: 'web_receive', locale: locale);
        await _run(tester, env, () => const WebSharePage(), () async {
          await tester.pump(const Duration(seconds: 1));
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'device details page', (tester) async {
        final env = await _setUp(tester, page: 'device_details', locale: locale);
        await _run(tester, env, () => const DeviceDetailsPage(device: _laptop), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'about page', (tester) async {
        final env = await _setUp(tester, page: 'about', locale: locale);
        await _run(tester, env, () => const AboutPage(), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'verify page', (tester) async {
        final env = await _setUp(tester, page: 'verify', locale: locale);
        await _run(
          tester,
          env,
          () => Builder(builder: (context) => VerifyPage(fingerprint: CombinedFingerprint.load(context, _phone.fingerprint))),
          () async {
            await _captureScrolling(tester, env);
          },
        );
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'receive history page', (tester) async {
        final env = await _setUp(tester, page: 'receive_history', locale: locale);
        await _run(tester, env, () => const ReceiveHistoryPage(), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'language page', (tester) async {
        final env = await _setUp(tester, page: 'language', locale: locale);
        await _run(tester, env, () => const LanguagePage(), () async {
          await _golden(tester, env, '');
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'troubleshoot page', (tester) async {
        final env = await _setUp(tester, page: 'troubleshoot', locale: locale);
        await _run(tester, env, () => const TroubleshootPage(), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'whats new page', (tester) async {
        final env = await _setUp(tester, page: 'whats_new', locale: locale);
        await _run(tester, env, () => WhatsNewPage.fromLastVersion(lastVersion: null)!, () async {
          await _captureScrolling(tester, env);
        });
      });

      // ---- dialogs / bottom sheets reachable from the send tab ----

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'send tab: add file bottom sheet', (tester) async {
        final env = await _setUp(tester, page: 'dialog_add_file', locale: locale, selected: _crossFiles);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.send, appStart: false), () async {
          unawaited(AddFileDialog.open(context: env.navContext, options: pickerOptions));
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'send tab: text message dialog (tap Text option)', (tester) async {
        final env = await _setUp(tester, page: 'dialog_message_input', locale: locale);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.send, appStart: false), () async {
          final textOption = find.text(t.sendTab.picker.text);
          if (textOption.evaluate().isNotEmpty) {
            await tester.ensureVisible(textOption.first);
            await tester.pump();
            await tester.tap(textOption.first, warnIfMissed: false);
          } else {
            unawaited(showDialog<String>(context: env.navContext, builder: (_) => const MessageInputDialog()));
          }
          await _settle(tester, env);
          await _golden(tester, env, '');
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'send tab: send mode menu and help dialog', (tester) async {
        final env = await _setUp(tester, page: 'dialog_send_mode', locale: locale, nearby: {_phone.fingerprint: _phone});
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.send, appStart: false), () async {
          final menu = find.byType(PopupMenuButton<dynamic>, skipOffstage: false);
          final menus = find.byWidgetPredicate((w) => w is PopupMenuButton);
          if (menus.evaluate().isNotEmpty) {
            // the last popup menu on the send tab is the send mode menu
            await tester.ensureVisible(menus.last);
            await tester.pump();
            await tester.tap(menus.last, warnIfMissed: false);
            await _settle(tester, env);
            await _golden(tester, env, 'menu');
            await tester.tapAt(const Offset(5, 5));
            await _settle(tester, env);
          }
          menu.evaluate();
          unawaited(showDialog(context: env.navContext, builder: (_) => const SendModeHelpDialog()));
          await _settle(tester, env);
          await _captureScrolling(tester, env, prefix: 'help');
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'send tab: address input dialog', (tester) async {
        final env = await _setUp(tester, page: 'dialog_address_input', locale: locale);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.send, appStart: false), () async {
          unawaited(showDialog(context: env.navContext, builder: (_) => const AddressInputDialog()));
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'send tab: favorites dialog', (tester) async {
        final env = await _setUp(tester, page: 'dialog_favorites', locale: locale);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.send, appStart: false), () async {
          unawaited(showDialog(context: env.navContext, builder: (_) => const FavoritesDialog()));
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'pin dialog', (tester) async {
        final env = await _setUp(tester, page: 'dialog_pin', locale: locale);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.receive, appStart: false), () async {
          unawaited(showDialog(context: env.navContext, builder: (_) => const PinDialog(obscureText: true, showInvalidPin: true)));
          await _settle(tester, env);
          await _golden(tester, env, '');
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'qr dialog (web share link)', (tester) async {
        final env = await _setUp(tester, page: 'dialog_qr', locale: locale);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.receive, appStart: false), () async {
          unawaited(
            showDialog(
              context: env.navContext,
              builder: (_) => const QrDialog(data: 'https://192.168.1.23:53317', label: 'https://192.168.1.23:53317', pin: '123456'),
            ),
          );
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'cancel session bottom sheet', (tester) async {
        final env = await _setUp(tester, page: 'dialog_cancel_session', locale: locale, send: {'ss1': _sendSession(SessionStatus.sending)});
        await _run(tester, env, () => const ProgressPage(showAppBar: true, closeSessionOnClose: false, sessionId: 'ss1'), () async {
          unawaited(env.navContext.pushBottomSheet(() => const CancelSessionDialog()));
          await _settle(tester, env);
          await _golden(tester, env, '');
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'local network permission bottom sheet', (tester) async {
        final env = await _setUp(tester, page: 'dialog_local_network', locale: locale);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.receive, appStart: false), () async {
          unawaited(env.navContext.pushBottomSheet(() => const LocalNetworkDialog()));
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });

      // ---- additional states of the normal receive / send flow ----

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'home receive tab (info box open)', (tester) async {
        final env = await _setUp(tester, page: 'home_receive_info', locale: locale, server: _runningServer);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.receive, appStart: false), () async {
          await tester.tap(find.byKey(const ValueKey('info-btn')), warnIfMissed: false);
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'home send tab (no devices found)', (tester) async {
        final env = await _setUp(tester, page: 'home_send_empty', locale: locale);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.send, appStart: false), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'receive page (long sender alias, 12 files)', (tester) async {
        final files = _manyFiles(12);
        final server = ServerState(
          alias: 'Wise Watch',
          port: 53317,
          https: true,
          session: _receiveSession(SessionStatus.waiting, files: files, sender: _laptop),
          web: null,
        );
        final env = await _setUp(tester, page: 'receive_page_long', locale: locale, server: server);
        env.container.notifier(selectedReceivingFilesProvider).setFiles(files);
        await _run(tester, env, () => ReceivePage(_receiveVm()), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'progress page (receiving, advanced panel open)', (tester) async {
        final server = ServerState(alias: 'Wise Watch', port: 53317, https: true, session: _receiveSession(SessionStatus.sending), web: null);
        final env = await _setUp(tester, page: 'progress_receiving_advanced', locale: locale, server: server);
        _seedTransfer(env, 'rs1');
        await _run(tester, env, () => const ProgressPage(showAppBar: false, closeSessionOnClose: true, sessionId: 'rs1'), () async {
          await tester.tap(find.text(t.general.advanced), warnIfMissed: false);
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'progress page (receiving finished)', (tester) async {
        final server = ServerState(
          alias: 'Wise Watch',
          port: 53317,
          https: true,
          session: _receiveSession(SessionStatus.finished, finished: true),
          web: null,
        );
        final env = await _setUp(tester, page: 'progress_receiving_done', locale: locale, server: server);
        final transfer = env.container.read(fileTransferProvider);
        transfer.setStatuses(sessionId: 'rs1', statuses: {for (final f in _files) f.id: FileStatus.finished});
        for (final f in _files) {
          transfer.setProgress(sessionId: 'rs1', fileId: f.id, progress: 1);
        }
        await _run(tester, env, () => const ProgressPage(showAppBar: false, closeSessionOnClose: true, sessionId: 'rs1'), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'progress page (sending finished with errors)', (tester) async {
        final env = await _setUp(
          tester,
          page: 'progress_sending_error',
          locale: locale,
          send: {
            'ss1': _sendSession(
              SessionStatus.finishedWithErrors,
              hashedFileCount: 3,
              errorMessage: 'Connection reset by peer (os error 104), uri=https://192.168.1.80:53317/api/localsend/v2/upload',
              fileErrors: {'f3': 'Connection reset by peer'},
            ),
          },
        );
        final transfer = env.container.read(fileTransferProvider);
        transfer.setStatuses(sessionId: 'ss1', statuses: {'f1': FileStatus.finished, 'f2': FileStatus.finished, 'f3': FileStatus.failed});
        transfer.setProgress(sessionId: 'ss1', fileId: 'f1', progress: 1);
        transfer.setProgress(sessionId: 'ss1', fileId: 'f2', progress: 1);
        await _run(tester, env, () => const ProgressPage(showAppBar: true, closeSessionOnClose: false, sessionId: 'ss1'), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'send page (checksums done, waiting for accept)', (tester) async {
        final env = await _setUp(
          tester,
          page: 'send_page_waiting',
          locale: locale,
          server: _runningServer,
          send: {'ss1': _sendSession(SessionStatus.waiting, hashedFileCount: 3)},
        );
        await _run(tester, env, () => const SendPage(showAppBar: false, closeSessionOnClose: true, sessionId: 'ss1'), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'send page (finished with error, info button)', (tester) async {
        final env = await _setUp(
          tester,
          page: 'send_page_error',
          locale: locale,
          server: _runningServer,
          send: {'ss1': _sendSession(SessionStatus.finishedWithErrors, hashedFileCount: 3, errorMessage: 'Connection refused (os error 111)')},
        );
        await _run(tester, env, () => const SendPage(showAppBar: false, closeSessionOnClose: true, sessionId: 'ss1'), () async {
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'error dialog (long error)', (tester) async {
        final env = await _setUp(tester, page: 'dialog_error', locale: locale, server: _runningServer);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.send, appStart: false), () async {
          unawaited(
            showDialog(
              context: env.navContext,
              builder: (_) => const ErrorDialog(
                error:
                    'ClientException with SocketException: Connection refused (OS Error: Connection refused, errno = 111), '
                    'address = 192.168.1.80, port = 53317, uri=https://192.168.1.80:53317/api/localsend/v2/prepare-upload',
              ),
            ),
          );
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });

      testWidgets(timeout: const Timeout(Duration(seconds: 120)), 'no permission dialog (file picker)', (tester) async {
        final env = await _setUp(tester, page: 'dialog_no_permission', locale: locale);
        await _run(tester, env, () => const HomePage(initialTab: HomeTab.send, appStart: false), () async {
          unawaited(showDialog(context: env.navContext, builder: (_) => const NoPermissionDialog()));
          await _settle(tester, env);
          await _captureScrolling(tester, env);
        });
      });
    });
  }
}

ViewProvider<ReceivePageVm> _receiveVm({String? message}) {
  return ViewProvider((ref) {
    final session = ref.watch(serverProvider)?.session;
    return ReceivePageVm(
      status: session?.status,
      sender: session?.sender ?? Device.empty,
      showSenderInfo: true,
      files: session?.files.values.map((f) => f.file).toList() ?? [],
      message: message,
      onAccept: () {},
      onDecline: () {},
      onClose: () {},
    );
  });
}

void _seedTransfer(_Env env, String sessionId) {
  final transfer = env.container.read(fileTransferProvider);
  transfer.setStatuses(
    sessionId: sessionId,
    statuses: {'f1': FileStatus.finished, 'f2': FileStatus.sending, 'f3': FileStatus.queue},
  );
  transfer.setProgress(sessionId: sessionId, fileId: 'f1', progress: 1);
  transfer.setProgress(sessionId: sessionId, fileId: 'f2', progress: 0.42);
}
