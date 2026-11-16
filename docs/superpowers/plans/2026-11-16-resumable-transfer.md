# 斷點續傳 實作計畫

> **給代理執行者：** 必須搭配 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 逐項執行。步驟用勾選框（`- [ ]`）追蹤。

**目標：** 兩台本分支 App 之間傳檔時，斷線、App 重開或取消後都能從已確定寫入的位置續傳，並用整檔 SHA-256 驗證。

**架構：** 在 v2 的 prepare-upload／upload 上加能力協商、`offset` 參數與新端點 `upload-offset`。Rust 核心負責工作階段狀態、寫入與驗證。Dart 伺服器隔離區負責半成品登記簿與存放位置。Dart 上傳隔離區負責自動重連。官方版裝置看不到任何差異。

**技術：** Rust（tokio、hyper、reqwest、sha2）、flutter_rust_bridge 2.12.0、Dart／Flutter 3.47.9（Refena、dart_mappable）、Android Kotlin（SAF）。

**規格：** `docs/superpowers/specs/2026-11-16-resumable-transfer-design.md`

## 全域限制

- 一律用 `fvm flutter`／`fvm dart`；Dart 格式寬度 150（`fvm dart format`）。
- `packages/core` 一律用 `--features full` 建置與測試。
- 環境變數：每個指令前先 `source <暫存區>/env.sh`，裡面設定 `JAVA_HOME`、`ANDROID_HOME`、rustup 與 cargo 的 PATH。
- 協定名稱逐字照用：
  - 請求與回應的 `resumeSupport` 值為 `1`
  - 回應的 `resumeOffsets` 是 `{fileId: 位元組數}`，只列大於 0 的
  - upload 的查詢參數是 `offset`
  - 新端點是 `POST /api/localsend/v2/upload-offset`，回 `{"offset": N}`
  - 位置不符時回 409，本體是 `{"message": "Offset mismatch", "offset": N}`
- 數值：
  - 接收端閒置逾時 **5 分鐘**
  - 傳送端重試間隔 **1、2、4、8、15、30 秒**，之後每 30 秒一次，總長 **5 分鐘**
  - 半成品保留 **7 天**
  - 每寫入 **16 MiB** 呼叫一次 `sync_data` 並回報確定位置
- 檔案位置：
  - 登記簿：`<應用程式支援目錄>/resume/partials.json`
  - 半成品檔名：`.<正式檔名>.lspart`
- 續傳的前提：只在 TLS 模式下，而且傳送端提供了 `sha256`。續傳過的檔案一律驗證整檔 SHA-256，即使接收端關閉了「驗證檢查碼」。
- 與官方版、web-peer 互傳時行為不變：沒有 `resumeSupport` 的工作階段，必須走原本的程式路徑。
- 提交：直接在 `main` 提交，訊息用中文，結尾附 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。只加入自己改的檔案；這個資料夾還有其他工作階段在改 `web-peer/`。
- 程式碼產生工具若把 `app/test/mocks.mocks.dart` 改成 80 欄格式，要還原。

## 審閱重點

規格隱含、但各任務測試沒直接涵蓋，最可能讓使用者踩到的情況：

1. **登記簿 JSON 損毀**（App 在寫入途中被殺）：伺服器照常啟動，當成空的登記簿，不得崩潰。→ 任務 7 加測試。
2. **0 位元組檔案**，雙方都支援續傳：照常完成，不會卡在查詢位置。→ 任務 3 加測試。
3. **同一個工作階段裡，一個檔案續傳、一個從頭傳**（同時 2 個並行）：兩個都完成，SHA-256 都正確。→ 任務 3 加測試。
4. **傳送端在退避等待期間按取消**：立刻停止重試，不再送任何請求。→ 任務 9 加測試。
5. **重試途中工作階段已經不在**（403）：停止重試、標成失敗，不能無限重試。→ 任務 9 加測試。

---

### 任務 0：工具鏈與基準

**檔案：** 無（只驗證環境）

- [ ] **步驟 1：確認工具版本**
  執行 `rustc --version`（1.97.1）、`fvm flutter --version`（3.47.9）、`sdkmanager --list_installed`（有 platform-tools、platforms;android-36、build-tools;36.0.0）。

- [ ] **步驟 2：安裝 FRB 程式碼產生工具**
  執行 `cargo install flutter_rust_bridge_codegen --version 2.12.0 --locked`，預期 `flutter_rust_bridge_codegen --version` 印出 2.12.0。

- [ ] **步驟 3：Rust 基準測試**
  在 `packages/core` 執行 `cargo test --features full`，預期全部 PASS，記下測試數量。

- [ ] **步驟 4：Dart 基準**
  在 `app/` 依序執行：
  - `fvm flutter pub get`
  - `fvm dart run build_runner build -d`
  - `fvm dart run slang`
  - `fvm flutter analyze`
  - `fvm flutter test`

  另外在 `packages/localsend_isolates` 執行 `fvm flutter test`。

  預期都通過。若基準本來就有失敗，記錄下來，不在本計畫修正。

- [ ] **步驟 5：基準 APK**
  在 `app/` 執行 `fvm flutter build apk --debug --target-platform android-arm64`。NDK 由 Gradle 自動下載；授權已接受。預期產出 APK，證明 Android 建置鏈可用。

---

### 任務 1：協定資料結構與能力協商（Rust 核心）

**檔案：**
- 修改：`packages/core/src/http/dto_v2.rs`（`PrepareUploadRequestDtoV2`、`PrepareUploadResponseDtoV2`）
- 修改：`packages/core/src/http/dto.rs`（通用 `PrepareUploadRequestDto`、`PrepareUploadResponseDto`，以及兩邊的 `From`；`ErrorResponse`）
- 修改：`packages/core/src/http/server/v2.rs`（`prepare_upload`、`PrepareUploadDecisionV2`、`ServerEventV2::PrepareUpload`）
- 修改：`packages/core/src/http/server/common/session.rs`（`UploadSessionV2`）
- 建立：`packages/core/tests/v2_resume.rs`（TLS 測試輔助函式照 `v2_tls_pinning.rs` 的寫法：`generate_identity`、`start_tls_server`、`client`）

**介面：**
- 產出：
  - `pub const RESUME_SUPPORT_VERSION: u32 = 1;`（放在 `dto_v2.rs`）
  - 請求 DTO（v2 與通用版都加）：`resume_support: Option<u32>`，序列化名稱 `resumeSupport`，`None` 時省略
  - 回應 DTO：
    - `resume_support: Option<u32>`
    - `resume_offsets: HashMap<String, u64>`，`#[serde(default, skip_serializing_if = "HashMap::is_empty")]`
  - 決定：`PrepareUploadDecisionV2::AcceptWithOffsets { file_ids: HashSet<String>, offsets: HashMap<String, u64> }`。原本的 `Accept(HashSet<String>)` 保留，等同於 offsets 是空的。
  - 事件：`ServerEventV2::PrepareUpload` 新增欄位 `resumable: bool`
  - 工作階段：`UploadSessionV2` 新增 `resumable: bool`、`sender_cert_fingerprint: Option<String>`；`SessionFileV2` 新增 `committed: u64`
  - 錯誤回應：`ErrorResponse` 新增 `offset: Option<u64>`（`None` 時省略）

- [ ] **步驟 1：寫失敗的測試**（`v2_resume.rs`）
  - `test_resume_negotiated_over_tls`：請求帶 `resume_support: Some(1)`，App 回 `AcceptWithOffsets`，其中 `offsets = {"a": 10}`。
    - 斷言：回應的 `resume_support == Some(1)`、`resume_offsets["a"] == 10`。
    - 斷言：事件的 `resumable == true`。
  - `test_resume_not_negotiated_without_request_flag`：請求不帶旗標。
    - 斷言：回應 JSON 原文沒有 `resumeSupport`、也沒有 `resumeOffsets` 字串。
    - 斷言：事件的 `resumable == false`。
  - `test_resume_not_negotiated_over_http`：用 `v2_server.rs` 那種 HTTP 伺服器，請求帶旗標。
    - 斷言：回應沒有新欄位、`resumable == false`。
  - `test_offsets_ignored_when_not_resumable`：未協商成功時 App 給了 offsets。
    - 斷言：回應沒有 `resumeOffsets`，檔案的 `committed` 為 0（以後續 upload 不帶 offset 能成功來驗證）。

- [ ] **步驟 2：執行，確認失敗**
  `cargo test --features full --test v2_resume`，預期編譯失敗：欄位、變體不存在。

- [ ] **步驟 3：實作**
  `resumable = 請求.resume_support >= 1 且 client_info.cert_fingerprint().is_some()`。決定裡的 offsets 只在 `resumable` 時套用到 `SessionFileV2.committed`，而且必須 `<= dto.size`，否則視為 0。修正 `v2_server.rs` 等既有測試因新欄位產生的編譯錯誤（補 `..` 或預設值）。

- [ ] **步驟 4：執行，確認通過**
  執行 `cargo test --features full`，預期全部 PASS（含既有測試）。

- [ ] **步驟 5：提交**　`feat(core):續傳能力協商與 DTO 欄位`

---

### 任務 2：可從中間續寫的寫入器（Rust 核心）

**檔案：**
- 修改：`packages/core/src/http/server/common/save.rs`
- 測試：同檔案的 `#[cfg(test)] mod tests`

**介面：**
- 產出：
  - `FileUploadTarget::Path` 與 `::Fd` 新增 `offset: u64`。
  - `progress_tx` 的型別改為 `Option<mpsc::Sender<UploadProgress>>`。
  - `pub struct UploadProgress { pub written: u64, pub committed: u64 }`：兩者都是**絕對位置**。
  - `save_req_to_target(req, target, file_size, expected_sha256, verify_prefix: bool, timestamps, abort: CancellationToken) -> SaveOutcome`
  - `pub(crate) struct SaveOutcome { pub result: SaveResult, pub committed: u64 }`
  - `pub(crate) const SYNC_INTERVAL: u64 = 16 * 1024 * 1024;`

- [ ] **步驟 1：寫失敗的測試**
  - `test_writer_resumes_at_offset`：既有檔案內容是 `b"hello world"`，`offset = 6`，送入 `b"there"`。
    - 斷言：檔案內容等於 `b"hello there"`、`committed == 11`、`result == Success`。
  - `test_writer_truncates_tail_beyond_offset`：既有檔案 20 位元組，`offset = 5`，送入 3 位元組，`file_size = 8`。
    - 斷言：檔案長度為 8。
  - `test_writer_hashes_prefix_when_resuming`：`expected_sha256` 是整檔雜湊，前段從磁碟讀回。
    - 斷言：`Success`。
    - 再把磁碟上的前段竄改 1 個位元組後重跑，斷言：`HashMismatch`。
  - `test_writer_reports_committed_on_abort`：送出 `SYNC_INTERVAL + 100` 位元組後觸發 `abort`。
    - 斷言：`result == Failed`。
    - 斷言：`committed` 等於檔案實際長度，而且 `>= SYNC_INTERVAL`。
  - `test_writer_progress_is_absolute`：`offset = 100`。
    - 斷言：第一個進度事件的 `written > 100`。

- [ ] **步驟 2：執行，確認失敗**
  `cargo test --features full -p localsend save::tests`，預期編譯失敗。

- [ ] **步驟 3：實作**
  - Path：用讀寫模式開檔，不清空。
  - Fd：直接用描述符。
  - 先 `set_len(offset)`，再 `seek(offset)`。
  - `verify_prefix` 為真時，先讀回 `[0, offset)` 初始化雜湊器。對 Path／Fd 目標，雜湊移到寫入器內計算；Stream 目標必須 `offset == 0`。
  - 每累積 `SYNC_INTERVAL` 就 flush、`sync_data`，並送出 `UploadProgress`。
  - 中斷時（本體錯誤或 `abort`）：flush、`sync_data`，`set_len(committed)`。
  - 呼叫端 `v2::upload` 先以 `verify_prefix = false`、`offset = 0` 接上，保持現有行為。

- [ ] **步驟 4：執行，確認通過**
  `cargo test --features full`，預期全部 PASS。

- [ ] **步驟 5：提交**　`feat(core):寫入器支援從中間續寫與確定位置回報`

---

### 任務 3：接收端的續傳工作階段（Rust 核心）

**檔案：**
- 修改：`packages/core/src/http/server/v2.rs`（`upload`、`finalize_file`、`cancel`、`prepare_upload`、新的 `upload_offset`、`UploadGuard`）
- 修改：`packages/core/src/http/server/common/session.rs`
- 修改：`packages/core/src/http/server/common/error.rs`（新增 `AppError::OffsetMismatch(u64)`）
- 修改：`packages/core/src/http/server/mod.rs`（路由 `POST /api/localsend/v2/upload-offset`；`ServerConfigV2.resume_idle_timeout: Duration`；`V2State` 同名欄位）
- 測試：`packages/core/tests/v2_resume.rs`

**介面：**
- 使用：任務 1 的 `resumable`、`committed`；任務 2 的 `SaveOutcome`、`UploadProgress`、`abort`。
- 產出：
  - `FileStatusV2::Interrupted`
  - `SessionFileV2` 新增：
    - `abort: CancellationToken`：每次上傳嘗試都換新的
    - `settled: Arc<tokio::sync::Notify>`
  - `ServerEventV2::FileUpload` 新增 `offset: u64`
  - `ServerEventV2::FileInterrupted { session_id: String, file_id: String, committed: u64 }`
  - `SessionEndReasonV2::IdleTimeout`、`SessionEndReasonV2::Superseded`
  - `ServerHandle::reset_v2_file(&self, session_id: &str, file_id: &str) -> bool`：把 `committed` 歸 0、狀態改為 `Pending`，給 App 在半成品打不開時使用。
  - `pub const DEFAULT_RESUME_IDLE_TIMEOUT: Duration = Duration::from_secs(300);`

- [ ] **步驟 1：寫失敗的測試**（`v2_resume.rs`）
  - `test_upload_with_offset_appends`：協商 `offsets = {"a": 4}`，目標檔已有 4 位元組，帶 `offset=4` 上傳其餘部分。
    - 斷言：200，檔案 SHA-256 正確。
  - `test_offset_mismatch_returns_409_with_offset`：帶 `offset=3`，但 `committed` 是 4。
    - 斷言：409，本體 `offset == 4`、`message == "Offset mismatch"`。
  - `test_interrupted_upload_keeps_session`：本體送一半就丟棄連線。
    - 斷言：收到 `FileInterrupted` 事件，其 `committed > 0`；沒有 `SessionEnd`。
    - 接著呼叫 upload-offset，斷言回的值等於 `committed`。
  - `test_upload_offset_aborts_stale_upload`：上傳進行中（本體送一半、連線還沒斷）時呼叫 upload-offset。
    - 斷言：回 200，而且舊請求已結束。
    - 再從回傳位置續傳，斷言完成。
  - `test_resume_from_new_ip_same_cert`：用同一個身分、不同的來源位址（綁 `::1` 或 `127.0.0.2`）續傳。
    - 斷言：200。
  - `test_resume_rejected_for_other_cert`：用另一個身分呼叫 upload-offset。
    - 斷言：403。
  - `test_idle_timeout_ends_session`：`resume_idle_timeout = 200ms`，中斷後等待。
    - 斷言：收到 `SessionEnd`，原因是 `IdleTimeout`。
    - 斷言：之後另一個傳送端的 prepare-upload 會成功。
  - `test_same_sender_supersedes_session`：中斷後，同一個身分再送 prepare-upload（帶旗標）。
    - 斷言：舊工作階段收到 `SessionEnd`，原因是 `Superseded`。
    - 斷言：新請求得到 200。
  - `test_other_sender_blocked_during_grace`：另一個身分送 prepare-upload。
    - 斷言：409。
  - `test_hash_mismatch_resets_offset`：續傳後整檔雜湊不符。
    - 斷言：422；upload-offset 回 0。
  - `test_resume_zero_byte_file`（審閱重點 2）：0 位元組檔案帶旗標。
    - 斷言：上傳 200，工作階段以 `Finished` 結束。
  - `test_resume_one_of_two_files`（審閱重點 3）：兩個檔案，一個 `offset > 0`、一個 0，同時上傳。
    - 斷言：兩個都 200，雜湊都正確，工作階段以 `Finished` 結束。
  - `test_legacy_session_unchanged`：不帶旗標，中斷。
    - 斷言：檔案標成失敗，單一檔案時工作階段結束。
    - 斷言：換來源 IP 上傳回 403（既有行為）。
  - `test_reset_v2_file`：中斷後呼叫 `reset_v2_file`。
    - 斷言：upload-offset 回 0。

- [ ] **步驟 2：執行，確認失敗**
  `cargo test --features full --test v2_resume`。

- [ ] **步驟 3：實作**
  - 驗證身分：`resumable` 的工作階段比對 `sender_cert_fingerprint`；其他工作階段照舊比對 IP。適用於 upload、upload-offset、cancel。
  - upload：接受 `Pending` 或 `Interrupted` 狀態，而且 `offset` 必須等於 `committed`，否則回 409。
    - `verify_prefix = resumable && offset > 0 && dto.sha256.is_some()`。
    - `resumable` 的工作階段一律驗證整檔雜湊：`expected_sha256 = dto.sha256`，不看 `verify_checksums`。其他工作階段照舊。
    - 為此在測試清單補上 `test_resumed_file_verified_even_when_verification_disabled`：`verify_checksums = false`，續傳後的內容和 `sha256` 不符，斷言回 422。
  - `finalize_file`：
    - `resumable` 時，`Failed` 改為 `Interrupted`，並記錄 `committed`，送出 `FileInterrupted`。
    - `HashMismatch` 時 `committed = 0`。
    - 每次結束都要 `settled.notify_waiters()`。
  - `upload_offset`：如果檔案在 `InProgress`，先 `abort.cancel()`，再等 `settled`（最多 10 秒），然後回 `committed`。檔案已完成時回 `dto.size`。
  - 閒置看門狗：工作階段建立時 spawn 一個任務。沒有任何 `InProgress` 的時間超過 `resume_idle_timeout` 時，把 `Interrupted` 改為 `Failed`、清空槽位、送出 `SessionEnd(IdleTimeout)`。
  - 取代：prepare-upload 遇到槽位被占用時，如果舊工作階段是 `resumable`、新請求也帶旗標，而且兩邊的憑證指紋相同，就中斷所有進行中的上傳、送出 `SessionEnd(Superseded)`、清空槽位，再照常處理新請求。

- [ ] **步驟 4：執行，確認通過**
  `cargo test --features full` 與 `cargo clippy --features full`，預期全部 PASS，沒有警告。

- [ ] **步驟 5：提交**　`feat(core):接收端續傳工作階段、upload-offset 端點與閒置逾時`

---

### 任務 4：傳送端客戶端（Rust 核心）

**檔案：**
- 修改：`packages/core/src/model/transfer.rs`（`FileContent`）
- 修改：`packages/core/src/http/client/mod.rs`（`LsHttpClient::upload`、`upload_body`、新的 `upload_offset`、`into_error`）
- 修改：`packages/core/src/http/client/v2.rs`（`upload` 加 `offset`、新的 `upload_offset`）
- 修改：`packages/core/src/http/client/v3.rs`（簽名跟著改；v3 一律 `offset = 0`）
- 修改：`packages/core/src/http/mod.rs`（`StatusCodeError` 新增 `offset: Option<u64>`）
- 測試：`transfer.rs` 的 tests、`v2_resume.rs`

**介面：**
- 產出：
  - `FileContent::into_stream_from(self, offset: u64) -> FileStream`
    - Path：seek。
    - Fd：用 `lseek`，失敗時讀掉前 `offset` 個位元組。
    - Stream：丟掉前 `offset` 個位元組。
    - `into_stream()` 等同 `into_stream_from(0)`。
  - `LsHttpClient::upload(protocol, ip, port, public_key, session_id, file_id, token, content, offset: u64, progress, cancel)`：`progress` 收到的是絕對位置。
  - `LsHttpClient::upload_offset(protocol, ip, port, public_key, session_id, file_id, token) -> Result<u64, ClientError>`
  - `StatusCodeError.offset`：從錯誤本體 `{"offset": N}` 解析出來。

- [ ] **步驟 1：寫失敗的測試**
  - `test_into_stream_from_path_skips_prefix`（transfer.rs）：
    - 斷言：檔案 `b"abcdef"` 從 2 開始讀到 `b"cdef"`。
    - 斷言：offset 等於檔案長度時讀到空的。
  - `test_into_stream_from_stream_skips_prefix`：
    - 斷言：分成 `[b"ab", b"cdef"]` 兩塊送入，從 3 開始讀到 `b"def"`。
  - `test_client_resumes_after_interruption`（v2_resume.rs）：用 `LsHttpClient` 上傳到一半，用 cancel token 中斷；呼叫 `upload_offset` 得到 N，再用 `upload(offset = N)` 完成。
    - 斷言：檔案雜湊正確。
    - 斷言：進度回呼的第一個值大於 N。
  - `test_client_parses_409_offset`：
    - 斷言：`ClientError::StatusCode(e)` 的 `e.status == 409`、`e.offset == Some(4)`。

- [ ] **步驟 2：執行，確認失敗**
- [ ] **步驟 3：實作**
  只在 `offset > 0` 時才在網址加 `offset` 參數。
- [ ] **步驟 4：執行，確認通過**
  `cargo test --features full`、`cargo clippy --features full`。
- [ ] **步驟 5：提交**　`feat(core):客戶端支援從指定位置上傳與查詢已收位置`

---

### 任務 5：FRB 介面與綁定

**檔案：**
- 修改：`packages/localsend_isolates/rust/src/api/http.rs`
  - `RsHttpClient::upload` 加 `offset: u64`
  - 新的 `upload_offset`
  - `RsHttpClientError::StatusCode` 加 `offset: Option<u64>`
- 修改：`packages/localsend_isolates/rust/src/api/model.rs`（`_PrepareUploadRequestDto`、`_PrepareUploadResponseDto` 鏡像加新欄位）
- 修改：`packages/localsend_isolates/rust/src/api/server.rs`
- 產生：`packages/localsend_isolates/lib/rust/**`、`rust/src/frb_generated.rs`（用程式碼產生工具）
- 修改：所有呼叫端，讓 Dart 能編譯；先用 `offset: 0`、`resumeOffsets: null` 接上，保持現有行為：
  - `packages/localsend_isolates/lib/src/task/upload/http_upload.dart`
  - `packages/localsend_isolates/lib/src/task/server/http_server.dart`
  - `server_isolate.dart`
  - `upload_isolate.dart`
  - `app/lib/provider/network/send_provider.dart`

**介面：**
- 產出（Dart 端名稱由程式碼產生工具自動轉成 camelCase）：
  - `RsServerEvent::PrepareUpload` 新增 `resumable: bool`
  - `RsServerEvent::FileUpload` 新增 `offset: u64`
  - 新的 `RsServerEvent::FileInterrupted { session_id, file_id, committed: u64 }`
  - `_SessionEndReasonV2` 鏡像新增 `IdleTimeout`、`Superseded`
  - `respond_prepare_upload(accepted_file_ids: Option<Vec<String>>, resume_offsets: Option<HashMap<String, u64>>)`
  - `respond_file_upload(sink: StreamSink<RsUploadProgress>, session_id, file_id, path, file_descriptor, file_size: u64, offset: u64)`，其中 `pub struct RsUploadProgress { pub written: u64, pub committed: u64 }`
  - `RsHttpServer::reset_file_upload(session_id: String, file_id: String) -> bool`
  - `start_server` 以 `DEFAULT_RESUME_IDLE_TIMEOUT` 建立設定

- [ ] **步驟 1：改 Rust API**
  `packages/localsend_isolates/rust` 執行 `cargo check`，預期通過。
- [ ] **步驟 2：重新產生綁定**
  在 `packages/localsend_isolates` 執行 `flutter_rust_bridge_codegen generate`。如果 `app/test/mocks.mocks.dart` 被改成 80 欄，執行 `git checkout -- app/test/mocks.mocks.dart`。
- [ ] **步驟 3：調整 Dart 呼叫端**
  照上面的預設值接上，`HttpServerFileUploadProgressEvent.progress` 改用 `written / fileSize`。
- [ ] **步驟 4：驗證**
  - `packages/localsend_isolates`：`fvm dart run build_runner build -d`
  - `app/`：`fvm flutter analyze`、`fvm flutter test`

  預期都通過，行為不變。
- [ ] **步驟 5：提交**　`feat(isolates):FRB 介面加入續傳參數並重新產生綁定`

---

### 任務 6：Android 存檔通道

**檔案：**
- 修改：`app/android/app/src/main/kotlin/org/localsend/localsend_app/MainActivity.kt`
- 修改：`packages/localsend_isolates/lib/util/android_channel.dart`

**介面：**
- 產出（Dart）：
  - `Future<int> openFileForResumeAndroid({required String uri})`：用 `"rw"` 開檔，回傳描述符。Provider 不支援時拋出 `PlatformException`，code 為 `OPEN_FAILED`。
  - `Future<String?> renameDocumentAndroid({required String uri, required String displayName})`：回傳新的 URI；Provider 不支援改名時回 `null`（Kotlin 端攔下 `UnsupportedOperationException`）。
  - `Future<void> deleteDocumentAndroid({required String uri})`：給到期清理用。
- Kotlin 的 method 名稱：`openFileForResume`、`renameDocument`、`deleteDocument`。錯誤處理照 `handleOpenFileForWriting` 的寫法。

- [ ] **步驟 1：實作 Kotlin 與 Dart 包裝**
- [ ] **步驟 2：驗證**
  `fvm flutter analyze`，以及 `fvm flutter build apk --debug --target-platform android-arm64`，預期建置成功。功能由任務 12 的實機測試驗證，平台通道沒有自動化測試基礎設施。
- [ ] **步驟 3：提交**　`feat(android):新增以 rw 開檔、改名與刪除文件的通道`

---

### 任務 7：半成品登記簿（Dart）

**檔案：**
- 建立：`packages/localsend_isolates/lib/src/task/server/partial_registry.dart`
- 測試：`packages/localsend_isolates/test/task/server/partial_registry_test.dart`

**介面：**
- 產出：
  - `class PartialEntry`，欄位：
    - `id`
    - `senderFingerprint`
    - `sha256`
    - `size`
    - `fileName`
    - `String? partialPath`
    - `String? partialUri`
    - `destinationDirectory`
    - `bool saveToGallery`
    - `int committed`
    - `DateTime createdAt`、`DateTime updatedAt`

    提供 `toJson`／`fromJson`；用手寫的 Map 轉換，不加程式碼產生。
  - `class PartialRegistry`
    - `PartialRegistry({required String filePath, DateTime Function()? now, Future<int?> Function(PartialEntry)? lengthOf, Future<void> Function(PartialEntry)? deleteContent})`
    - `Future<void> load()`：檔案不存在或 JSON 損毀時當成空的，不拋例外。
    - `Future<({PartialEntry entry, int offset})?> match({required String senderFingerprint, required String sha256, required int size})`
      - `offset = min(committed, lengthOf(entry) ?? committed)`
      - `lengthOf` 回 `-1` 代表檔案不存在：刪除這筆紀錄並回 `null`
    - `Future<void> upsert(PartialEntry entry)`
    - `Future<void> updateCommitted(String id, int committed)`
    - `Future<void> remove(String id, {bool deleteContent = false})`
    - `Future<void> purgeExpired({Duration maxAge = const Duration(days: 7)})`：連同內容一起刪除。
    - 儲存時先寫 `<filePath>.tmp` 再改名。
  - `Map<String, int> confirmResumeOffsets({required Map<String, ({PartialEntry entry, int offset})> matches, required String destinationDirectory, required bool saveToGallery})`：目的資料夾或存相簿設定不同的檔案不列入（等於從 0 開始）。

- [ ] **步驟 1：寫失敗的測試**
  - `match returns offset for same sender, sha256 and size`
  - `match returns null for another sender fingerprint`
  - `match returns null and drops entry when content is missing`
  - `offset is the smaller of committed and actual length`
  - `purgeExpired removes entries older than 7 days and deletes content`：注入 `now`，斷言 `deleteContent` 被呼叫。
  - `corrupt registry file loads as empty`（審閱重點 1）：寫入 `{not json`。
    - 斷言：`load()` 不拋例外。
    - 斷言：`match` 回 `null`。
    - 斷言：之後 `upsert` 能正常寫入。
  - `registry survives reload`：`upsert` 後建立新的實例並 `load`，斷言能比對到。
  - `confirmResumeOffsets drops files whose destination or gallery setting changed`

- [ ] **步驟 2：執行，確認失敗**
  `fvm flutter test test/task/server/partial_registry_test.dart`（在 `packages/localsend_isolates`）。
- [ ] **步驟 3：實作**
- [ ] **步驟 4：執行，確認通過**
- [ ] **步驟 5：提交**　`feat(isolates):半成品登記簿`

---

### 任務 8：接收端整合（Dart 伺服器隔離區與存檔）

**檔案：**
- 修改：`packages/localsend_isolates/lib/src/task/server/file_saver.dart`
- 修改：`packages/localsend_isolates/lib/src/isolate/child/server_isolate.dart`
  - `HttpServerPrepareUploadEvent` 新增 `Map<String, int> resumeOffsets`
  - `HttpServerReceiveConfig` 新增 `bool resumable`、`String senderFingerprint`
  - 新事件 `HttpServerFileInterruptedEvent`
  - `HttpServerStartTask` 新增 `String resumeRegistryPath`
  - `_ReceiveSession` 保存比對結果與登記簿 id
- 修改：`app/lib/provider/network/server/server_provider.dart`（帶入登記簿路徑，用 `path_provider` 的應用程式支援目錄加上 `resume/partials.json`）
- 修改：`app/lib/provider/network/server/controller/receive_controller.dart`（把 `resumeOffsets`、`resumable`、`senderFingerprint` 帶進接收設定；處理中斷事件）
- 測試：`packages/localsend_isolates/test/task/server/file_saver_test.dart`（建立）

**介面：**
- 使用：任務 5 的 FRB 事件與回應；任務 6 的 Android 通道；任務 7 的 `PartialRegistry`、`confirmResumeOffsets`。
- 產出（`file_saver.dart`）：
  - `String partialFileName(String finalName)`：回傳 `.$finalName.lspart`。
  - `Future<FileSaveTarget> preparePartialSaveTarget({required String destinationDirectory, required String cacheDirectory, required String fileName, required bool saveToGallery, required Set<String> createdDirectories, int? androidSdkInt})`：建立新的半成品。存相簿時路徑是 `<cacheDirectory>/resume/<隨機 id>.lspart`。
  - `Future<FileSaveTarget> reopenPartialSaveTarget(PartialEntry entry)`：路徑直接回傳；URI 改用 `openFileForResumeAndroid`。
  - `Future<String> finalizePartialSaveTarget({required FileSaveTarget target, required String finalName, required Set<String> createdDirectories})`：改名成不衝突的正式檔名，回傳最終路徑或 URI。
    - 一般路徑：同一個資料夾內改名。
    - SAF：`renameDocumentAndroid`，回 `null` 時退回「建立正式檔名的文件、串流複製、刪除半成品」。

      **與規格 §5.4 的差異**：規格寫的是退回「一開始就用正式檔名」，但改名支援只有到最後才知道，所以改成複製。
    - 存相簿的情況不呼叫這個函式，照舊走 `saveCachedFileToGallery`。

- [ ] **步驟 1：寫失敗的測試**（`file_saver_test.dart`，只測路徑情況）
  - `partialFileName hides the file`：斷言 `partialFileName('a.jpg') == '.a.jpg.lspart'`。
  - `finalizePartialSaveTarget renames to the final name`
  - `finalizePartialSaveTarget picks a numbered name on conflict`：已有 `a.jpg`，斷言結果是 `a (1).jpg`，依 `digestFilePathAndPrepareDirectory` 的既有規則。
- [ ] **步驟 2：執行，確認失敗**
- [ ] **步驟 3：實作 `file_saver.dart`**
- [ ] **步驟 4：串接伺服器隔離區**
  - 伺服器隔離區啟動時：`load()` 後立刻 `purgeExpired()`。
  - 收到 PrepareUpload 且 `resumable` 時：
    1. `purgeExpired`
    2. 對有 `sha256` 的檔案呼叫 `match`
    3. 把 offsets 附在事件上
  - 收到接受決定時：用 `confirmResumeOffsets` 再確認一次，再 `respondPrepareUpload(..., resumeOffsets)`。
  - `_handleFileUpload` 在 `resumable` 而且檔案有 `sha256` 時：
    1. 取得目標：比對到就用 `reopenPartialSaveTarget`，否則用 `preparePartialSaveTarget`，並 `upsert` 一筆紀錄。
    2. 以 `event.offset` 呼叫 `respondFileUpload`。
    3. 每次 `committed` 變大時 `updateCommitted`。
    4. 成功後：一般存檔走 `finalizePartialSaveTarget`，Android 一般路徑在改名後對最終路徑呼叫 `scanFileAndroid`；存相簿照舊搬進相簿，再刪除快取檔。最後 `remove(id)`。
    5. 收到 `RsServerEvent_FileInterrupted` 時，用事件裡的 `committed` 呼叫 `updateCommitted`。
    6. 開檔失敗時：`resetFileUpload`，並 `remove(id, deleteContent: true)`。
  - 沒有 `resumable` 時完全走原本的程式。
  - `RsServerEvent_FileInterrupted` 轉成 `HttpServerFileInterruptedEvent` 送給主隔離區。
- [ ] **步驟 5：驗證**
  `fvm flutter test`（兩個套件）、`fvm flutter analyze`。
- [ ] **步驟 6：提交**　`feat(isolates):接收端使用半成品續傳並在完成時改名`

---

### 任務 9：傳送端自動重連（Dart）

**檔案：**
- 建立：`packages/localsend_isolates/lib/src/task/upload/resume_policy.dart`
- 修改：`packages/localsend_isolates/lib/src/isolate/child/upload_isolate.dart`
  - `HttpUploadFile` 新增 `int offset`、`bool resumable`
  - 新事件 `HttpUploadFileReconnectingEvent { fileId, attempt }`
- 修改：`packages/localsend_isolates/lib/src/task/upload/http_upload.dart`（`upload` 加 `offset`；新的 `uploadOffset`）
- 修改：`app/lib/provider/network/send_provider.dart`
  - 請求帶 `resumeSupport: createChecksums && target.https ? 1 : null`
  - 記錄回應的 `resumeSupport`、`resumeOffsets`
  - 手動重送也走續傳流程
- 修改：`app/lib/model/state/send/send_session_state.dart`（`bool resumable`）
- 修改：`app/lib/model/state/send/sending_file.dart`（`int resumeOffset`、`int? reconnectAttempt`）
- 測試：`packages/localsend_isolates/test/task/upload/resume_policy_test.dart`

**介面：**
- 產出（`resume_policy.dart`）：
  - `const resumeRetryDelays = [Duration(seconds: 1), Duration(seconds: 2), Duration(seconds: 4), Duration(seconds: 8), Duration(seconds: 15), Duration(seconds: 30)];`
  - `const resumeRetryWindow = Duration(minutes: 5);`
  - `enum UploadFailureKind { connection, offsetMismatch, sessionGone, checksumMismatch, other }`
  - `UploadFailureKind classifyUploadFailure(Object error)`：
    - `RsHttpClientError_StatusCode`：409 → `offsetMismatch`；403、404 → `sessionGone`；422 → `checksumMismatch`；其他 → `other`
    - `RsHttpClientError_Reqwest`、`RsHttpClientError_Io` → `connection`
  - `Future<void> uploadWithResume({required int initialOffset, required Future<int> Function() queryOffset, required Future<void> Function(int offset) upload, required bool Function() isCancelled, required Future<void> Function(Duration) sleep, required DateTime Function() now, void Function(int attempt)? onReconnecting})`
- 退避規則：
  - 第 n 次重試等 `resumeRetryDelays[min(n-1, 5)]`。
  - 從第一次失敗算起超過 `resumeRetryWindow` 就拋出最後的錯誤。
  - `offsetMismatch` 直接用錯誤裡的 offset 重試，不等待、不算次數。
  - `checksumMismatch` 用 offset 0 重試，最多 3 次，沿用既有上限。
  - `sessionGone`、`other` 直接拋出。

- [ ] **步驟 1：寫失敗的測試**（全部用假的 `upload`、`queryOffset`、`sleep`、`now`）
  - `reconnects after a connection error and resumes from the queried offset`：第一次 upload 拋出連線錯誤，`queryOffset` 回 40。
    - 斷言：第二次 upload 收到 40。
    - 斷言：`onReconnecting(1)` 被呼叫。
  - `uses the offset of a 409 response without sleeping`
  - `stops when the session is gone`（審閱重點 5）：`queryOffset` 拋出 403。
    - 斷言：拋出例外。
    - 斷言：upload 只被呼叫 1 次。
  - `stops immediately when cancelled during backoff`（審閱重點 4）：`sleep` 期間把 `isCancelled` 設為 true。
    - 斷言：之後 upload 與 `queryOffset` 都不再被呼叫。
  - `gives up after the 5 minute window`：`now` 每次前進 31 秒。
    - 斷言：最後拋出連線錯誤。
    - 斷言：`sleep` 收到的間隔依序是 1、2、4、8、15、30、30… 秒。
  - `restarts from zero after a checksum mismatch, at most 3 attempts`
- [ ] **步驟 2：執行，確認失敗**
- [ ] **步驟 3：實作 `resume_policy.dart`**
- [ ] **步驟 4：串接上傳隔離區與 `send_provider`**
  - `resumable` 為假時，維持原本的 422 重試迴圈。
  - 手動重送且 `resumable` 時，`initialOffset` 先用 `queryOffset` 取得。
- [ ] **步驟 5：驗證**
  `fvm flutter test`（兩個套件）、`fvm flutter analyze`。
- [ ] **步驟 6：提交**　`feat:傳送端斷線自動重連並從已收位置續傳`

---

### 任務 10：介面與語系

**檔案：**
- 修改：`app/assets/i18n/en.json`、`app/assets/i18n/zh-TW.json`，以及其他語系依慣例更新的 `_missing_translations_<locale>.json`
- 修改：傳送端與接收端的進度頁（`app/lib/pages/progress_page.dart`）、接收確認頁（`app/lib/pages/receive_page.dart`），以及 `receive_controller.dart` 的事件處理
- 產生：`app/lib/gen/`（`fvm dart run slang`）

**介面：**
- 新字串（鍵名 → 英文 → 繁中）：
  - `progressPage.reconnecting` → `Reconnecting… (attempt {n})` → `重新連線中…（第 {n} 次）`
  - `progressPage.waitingForReconnect` → `Waiting for the sender to reconnect…` → `等待對方重新連線…`
  - `receivePage.resumeFrom` → `Resumes from {percent}%` → `將從 {percent}% 接續`

- [ ] **步驟 1：加入字串並執行 `fvm dart run slang`**
  預期 `app/test/unit/i18n_test.dart` 通過。
- [ ] **步驟 2：畫面**
  - 傳送端：`reconnectAttempt != null` 時，在檔名下方顯示 `reconnecting`。
  - 接收端：檔案中斷時顯示 `waitingForReconnect`。
  - 確認頁：有 `resumeOffsets` 的檔案顯示 `resumeFrom`。
  - 不在 `isCompactScreen` 的手錶版面上增加列高：一律用同一行的小字。
- [ ] **步驟 3：驗證**
  - `app/` 執行 `fvm flutter test`，含 `test/watch` 的手錶版面測試：`--dart-define=WATCH_STRICT=true` 不能有溢出。
  - `fvm flutter analyze`。
- [ ] **步驟 4：提交**　`feat(app):續傳狀態的畫面與文字`

---

### 任務 11：文件

**檔案：**
- 建立：`docs/resume-protocol.md`：協定擴充第 1 版的規格，內容是全域限制裡的名稱與數值，給日後替 web-peer 實作用。
- 修改：`README.md`：在「和官方版的差異」加一節「斷點續傳」，並在「已知限制」補上：只限本分支、加密模式、開啟檢查碼。

- [ ] **步驟 1：撰寫**
- [ ] **步驟 2：提交**　`docs:續傳協定說明與 README`

---

### 任務 12：全部檢查、APK 與實機測試

- [ ] **步驟 1：全部檢查**
  - Rust：在 `packages/core` 執行 `cargo test --features full`、`cargo clippy --features full`；在 `packages/localsend_isolates/rust` 執行 `cargo check`。
  - Dart：在 `app/` 執行 `rm -rf lib/gen && fvm dart format --set-exit-if-changed lib test`，再重新產生 `lib/gen`；接著跑 `fvm flutter analyze`、`fvm flutter test`；`packages/localsend_isolates` 也跑 `fvm flutter test`。

  預期全部通過。
- [ ] **步驟 2：編 release APK**
  照 README「編譯手錶 APK」的參數：`fvm flutter build apk --release --no-pub --android-skip-build-dependency-validation --target-platform android-arm,android-arm64`。簽名金鑰用使用者提供的 Windows `debug.keystore`；沒有提供時，用本機金鑰並告知使用者要先解除安裝舊版。
- [ ] **步驟 3：模擬器冒煙測試（盡力而為）**
  用 `fever_api35` 安裝 x86_64 debug 版，確認 App 能啟動、能接收一個檔案。
- [ ] **步驟 4：請使用者做實機測試**
  兩支手機，傳一個數百 MB 的檔案，依序測試：
  1. 傳到一半關掉接收端 Wi-Fi 再打開。
  2. 傳到一半強制關閉傳送端 App，再重新傳同一個檔案。
  3. 傳到一半重開接收端手機。
  4. 傳到一半按取消，再重新傳。
  5. 存相簿各做一次，SAF 自訂資料夾各做一次。

  每次都比對 SHA-256，並確認下載資料夾沒有 `.lspart` 殘檔。
- [ ] **步驟 5：提交剩下的變更並回報結果**
