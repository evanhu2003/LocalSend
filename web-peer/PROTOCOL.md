# LocalSend v2 互通規格(web-peer 實作用)

本文件描述一個 PC 端節點(web-peer)要和**本 repo 的 LocalSend App**(手錶上執行的版本,預設設定)互通時,
必須做到的每一件事。所有規則都來自本 repo 原始碼,並標註 `檔案:行號`。

- 路徑縮寫:`core/` = `packages/core/src/`,`iso/` = `packages/localsend_isolates/`,`app/` = `app/lib/`。
- 標記 **【不確定】** 的地方是從程式碼推論、未實機驗證,或依賴第三方函式庫行為。
- 本 repo 是 LocalSend 協定 **v2.2**,但跟官方文件有幾處**實作差異**(見第 9 節),以本文件為準。

---

## 0. 一頁摘要(實作清單)

| 項目 | 值 |
|---|---|
| 協定版本字串 | `"2.2"`(`core/model/discovery.rs:4`、`iso/lib/constants.dart:10`) |
| HTTP(S) 埠 | `53317`(`iso/lib/constants.dart:14`、`app/provider/persistence_provider.dart:343-344`) |
| 多播群組 / 埠 | IPv4 `224.0.0.167` / UDP `53317`(`core/multicast/mod.rs:28,39`、`iso/lib/constants.dart:24`) |
| IPv6 多播(擴充) | `ff12::fd3a:e420` / UDP `53317`(`core/multicast/mod.rs:35-36`,手錶有開:`iso/rust/src/api/discovery.rs:199`) |
| 傳輸 | 預設 HTTPS(`app/provider/persistence_provider.dart:496-498`),**HTTP/1.1 only** |
| TLS 身分 | 自簽 X.509 **v3** 憑證,RSA-2048 + SHA-256(App 自己的做法) |
| fingerprint | `SHA-256(憑證 DER 位元組)` → **大寫** hex,64 字元 |
| 用戶端憑證 | **雙向必出示**(手錶伺服器強制 mTLS;手錶用戶端永遠出示自己的憑證) |
| 探索回應方式 | **只用 HTTP `POST /api/localsend/v2/register`**,本 repo 從不以 UDP 回應 |
| 探索 register 逾時 | **500 ms**(含 TCP + TLS 握手) |
| 單一 session | 手錶伺服器同時只允許 1 個上傳 session,其餘回 409 |
| nonce / v3 | 手錶用戶端**完全不呼叫**,PC 不需實作 |

---

## 1. TLS 與身分

### 1.1 憑證要求(PC 端自己的憑證)

App 自己產生的憑證(`core/crypto/cert.rs:21-56`):

- RSA-2048 金鑰(`cert.rs:36`),私鑰 PKCS#8 PEM(`cert.rs:37`)。
- Subject 只有 `CN=LocalSend User`,**沒有 SAN**(`cert.rs:26-27,44-47`)。名稱不帶任何意義,身分只看 fingerprint。
- 序號由公鑰雜湊推得(rcgen 預設)(`cert.rs:28-29`)。
- 有效期間是 rcgen 預設 **1975 年 ~ 4096 年**,實務上永不過期(`cert.rs:30-31`)。
- 簽章:rcgen 對 RSA 金鑰用 `sha256WithRSAEncryption`。【不確定:由 rcgen 預設推論,未逐位元檢查】

對方(手錶)驗證 PC 憑證時實際檢查的條件(不論 PC 是伺服器或用戶端都一樣):

1. **時間有效**:`notBefore <= 現在 <= notAfter`,否則 `Time validity error`(`core/crypto/cert.rs:75-78`)。
   → 手錶時鐘可能不準,**notBefore 請設在很久以前(例如 2000-01-01),notAfter 設很遠(例如 2099 以後)**。
2. **自簽章正確**:`cert.verify_signature(None)` 用憑證自己的公鑰驗證簽章(`cert.rs:94`)。必須真的是自簽。
   x509-parser 0.18(`features = ["verify"]`,`packages/core/Cargo.toml:43`)支援 RSA PKCS#1 v1.5(SHA-256 等)、ECDSA P-256/P-384、Ed25519。
3. **能被 webpki 解析**:TLS 握手簽章驗證交給 rustls 的 `WebPki*Verifier`(`core/http/client/server_cert_verifier.rs:78,117-133`、`core/http/server/common/client_cert_verifier.rs:29,68-84`),
   rustls 0.23 會用 `webpki::EndEntityCert::try_from` 解析憑證(`~/.cargo/registry/.../rustls-0.23.43/src/webpki/verify.rs:162,200`)。webpki 0.103 的硬性要求:
   - **必須是 X.509 v3**(version 欄位 = 2),否則 `UnsupportedCertVersion`(`rustls-webpki-0.103.13/src/cert.rs:81,258-267`)。
   - TBS 內的 signature AlgorithmIdentifier 必須和外層**逐位元相同**(`webpki cert.rs:84-90`)。
   - 不可有 issuerUniqueID / subjectUniqueID(`webpki cert.rs:97-100`)。
   - 不可有未知的 critical extension。【不確定:依 webpki `UnknownExtensionPolicy` 預設推論】
   - 序號採寬鬆解析(`lenient_certificate_serial_number`,`webpki cert.rs:82`),但**建議序號為正整數、≤ 20 bytes**(node-forge 請避免最高位元為 1 的序號,或在前面補 `00`)。
4. **不檢查主機名稱**:對方以 IP 連線,hostname 被刻意忽略(`server_cert_verifier.rs:99-101`)。不需 SAN。
5. **不要求 CA、不檢查 KeyUsage/EKU 等**:伺服器端「只要有效就信任」(`client_cert_verifier.rs:60-65`),
   用戶端只用自訂驗證器,不委派給 WebPki 鏈驗證(`server_cert_verifier.rs:71-73,91-115`)。

**建議做法(Node)**:用 `node-forge`(或依賴它的 `selfsigned`)產生 RSA-2048、v3、`sha256WithRSAEncryption`、
`CN=LocalSend User`、無 extension(或只放非 critical 的 basicConstraints)、notBefore 2000-01-01、notAfter 2099-12-31 的憑證,
**存到磁碟重複使用**(fingerprint 改變會讓手錶上的「我的最愛」與 pin 失效)。

### 1.2 fingerprint 公式

```
fingerprint = uppercase_hex( SHA-256( 憑證的 DER 位元組 ) )   // 64 個字元,0-9A-F
```

- 定義:`core/crypto/cert.rs:99-106`(`{byte:02X}`,大寫)。測試向量:`cert.rs:276-284`(`4BADDE53A7F7CD...52FA`,與 Dart 端一致)。
- 是對**整份憑證 DER** 做雜湊,不是對公鑰。
- Node:`crypto.createHash('sha256').update(derBuffer).digest('hex').toUpperCase()`;
  對方憑證 DER 用 `socket.getPeerCertificate().raw` 取得。
- 比對規則:
  - 手錶伺服器 register:`payload.fingerprint.to_ascii_uppercase() == cert_fingerprint`(`core/http/server/v2.rs:164-167`)→ body 可大小寫不拘,但**請一律送大寫**。
  - 手錶用戶端 pin:預期值會先轉大寫再比(`server_cert_verifier.rs:79,105-111`)。
  - 多播自我過濾是**精確字串比較**(`core/multicast/mod.rs:376`)。
- HTTPS 模式下,body 內的 `fingerprint` 只是「宣稱」;真正身分是 TLS 憑證的 fingerprint
  (`core/http/dto_v2.rs:36-38`、`core/discovery/mod.rs:168-176`、`app/provider/network/server/controller/receive_controller.dart:86-89`)。

### 1.3 雙向 TLS(mTLS)— 誰出示什麼

| 角色 | 手錶當伺服器(PC 傳檔給手錶 / PC 對手錶 register) | 手錶當用戶端(手錶傳檔給 PC / 手錶對 PC register) |
|---|---|---|
| 伺服器憑證 | 手錶的憑證 | **PC 的憑證** |
| 用戶端憑證 | **PC 必須出示自己的憑證**,否則握手失敗 | 手錶**永遠**出示自己的憑證(`core/http/client/mod.rs:224`) |

- 手錶伺服器:`client_auth_mandatory = mandatory`(`client_cert_verifier.rs:46-48`),而 `mandatory = (WebShare == Disabled)`(`core/http/server/mod.rs:384-386`)。
  預設沒開網頁分享 → `Disabled`(`app/provider/network/server/server_provider.dart:150-163` 的 `null => WebMode.disabled()`)→ **強制 mTLS**。
  若手錶開了「網頁分享/網頁接收」,用戶端憑證變成選填,但若出示仍會驗證(`mod.rs:384-385`)。
- 手錶伺服器對用戶端憑證只做 1.1 節的「有效性」檢查(`client_cert_verifier.rs:54-66`),失敗 → 握手失敗(`ApplicationVerificationFailure`)。
- 伺服器會在 CertificateRequest 中帶 root hint = 自己憑證的 subject(`client_cert_verifier.rs:25-26,50-52`)。
  OpenSSL(Node)用戶端只要設定了 `cert`/`key` 就會無條件送出,不受 hint 影響。【不確定:依 OpenSSL 行為】
- **PC 當伺服器**時:Node `https.createServer({ key, cert, requestCert: true, rejectUnauthorized: false })`,
  再自行用 `req.socket.getPeerCertificate().raw` 算 fingerprint(不能用 `rejectUnauthorized: true`,因為對方是自簽)。
- **PC 當用戶端**時:`https.request({ key, cert, rejectUnauthorized: false, ... })`,
  在 `secureConnect` 時比對對方 fingerprint,不符就 `destroy()`(手錶自己也是在握手階段就擋,`server_cert_verifier.rs:52-54`)。

### 1.4 fingerprint 不符時的後果

- 手錶 → PC 的 register(回應 PC 的多播):手錶 pin 住 PC 在多播中宣稱的 fingerprint(`core/discovery/mod.rs:517-528`)。
  PC 的 TLS 憑證不符 → 握手失敗,手錶**不會**把 PC 加入裝置列表(`discovery/mod.rs:556-563`,只記 debug log)。
- PC → 手錶的 register:body `fingerprint` 和 PC 的用戶端憑證不符 → 仍回 **200** 和手錶資訊,但**靜默忽略**這次註冊
  (不發 Register 事件、手錶列表不會出現 PC)(`core/http/server/v2.rs:162-192`)。
- 手錶傳檔給 PC:手錶用戶端 pin 住它所知道的 PC fingerprint(`app/provider/network/send_provider.dart:93-95`、`iso/lib/src/isolate/child/http_provider.dart:25-33`),
  PC 憑證變了 → 握手失敗,上傳失敗。
- PC 傳檔給手錶:手錶伺服器不比對 prepare-upload `info.fingerprint` 和憑證,但會把**憑證 fingerprint**當作寄件者身分
  (`core/http/server/v2.rs:281-288`、`receive_controller.dart:86-100`)。

### 1.5 TLS 版本、ALPN、HTTP 版本

- rustls 預設 TLS 1.2 + 1.3(用 ring provider,`core/http/client/mod.rs:208`、`core/http/server/mod.rs:228`)。Node 預設 OK。
- 手錶用戶端 ALPN **只提供 `http/1.1`**(`core/http/client/mod.rs:228-230`)。PC 伺服器**不可**只接受 `h2`;不設 ALPN 或設 `['http/1.1']` 皆可。
- 手錶伺服器只跑 **HTTP/1.1**(hyper `http1::Builder`,`core/http/server/mod.rs:533-554`),伺服器端未設定 ALPN(`mod.rs:556-572`)。
- 手錶用戶端不走 proxy、不跟隨 redirect(`core/http/client/mod.rs:235-242`)。PC 不要回 3xx。
- rustls 對 IP 位址不送 SNI。PC 伺服器不能依賴 SNI。【不確定:依 rustls 行為】

---

## 2. 資料結構(JSON,精確欄位名稱)

所有 DTO 都是 `camelCase`。未知欄位一律忽略(沒有 `deny_unknown_fields`)。

### 2.1 列舉值

- `protocol`:`"http"` | `"https"`,**只接受全小寫**,其他值 → JSON 解析失敗(`core/model/discovery.rs:36-60`)。
- `deviceType`:序列化為 `"mobile"` | `"desktop"` | `"web"` | `"headless"` | `"server"`(`discovery.rs:66-89`);
  解析時大小寫不拘,未知值 → `desktop`(`discovery.rs:86-99`)。手錶(Android)送 `"mobile"`(`app/util/native/device_info_helper.dart:27-29`)。
  PC 建議送 `"desktop"`。
- `deviceModel`:自由字串,可省略。手錶送 Android brand 的 PascalCase(`device_info_helper.dart:40-42`)。PC 建議 `"Windows"`。

### 2.2 `MulticastDto`(UDP 宣告)

`core/model/discovery.rs:105-141`,傳送時額外加上 `announce: true`(`core/multicast/mod.rs:174-189`):

| 欄位 | 型別 | 必要 | 說明 |
|---|---|---|---|
| `alias` | string | 是 | 顯示名稱 |
| `version` | string | 是 | `"2.2"` |
| `deviceModel` | string | 否(None 時省略) | |
| `deviceType` | string | 否(None 時省略) | 見 2.1 |
| `fingerprint` | string | 是 | 見 1.2 |
| `port` | number(u16) | 是 | **自己的 HTTP(S) 伺服器埠** |
| `protocol` | string | 是 | `"https"` |
| `download` | bool | 否(預設 false) | 下載 API(網頁分享)是否啟用;PC 送 `false` |
| `announce` | bool | — | 傳送端固定 `true`;接收端**不讀**這個欄位 |

範例(手錶實際會送出的格式):

```json
{"alias":"Nice Orange","version":"2.2","deviceModel":"Xiaomi","deviceType":"mobile","fingerprint":"4BADDE53A7F7CDEEED93189FD898E02BF6B4806CA4C05DE0ACE08319B86552FA","port":53317,"protocol":"https","download":false,"announce":true}
```

注意:本 repo **不送也不讀 `announcement`**(舊版 v1 欄位)。PC 可以額外帶,但手錶會忽略。

### 2.3 `RegisterDto`(register 請求 body,以及 prepare-upload 的 `info`)

`core/http/dto_v2.rs:15-50`:

| 欄位 | 型別 | 必要 |
|---|---|---|
| `alias` | string | 是 |
| `version` | string | 是 |
| `deviceModel` | string | 否 |
| `deviceType` | string | 否 |
| `fingerprint` | string | 是 |
| `port` | number | 是 |
| `protocol` | `"http"`/`"https"` | 是 |
| `download` | bool | 否(預設 false;手錶送出時一定有) |

手錶送出時 `download` 一定會序列化(沒有 skip,`dto_v2.rs:47-49`),`deviceModel`/`deviceType` 為 None 時省略。

```json
{"alias":"Nice Orange","version":"2.2","deviceModel":"Xiaomi","deviceType":"mobile","fingerprint":"<手錶 fingerprint>","port":53317,"protocol":"https","download":false}
```

### 2.4 `RegisterResponseDto`(register 回應)

`core/http/dto_v2.rs:55-84`:`alias`(必)、`version`(必)、`deviceModel`(選)、`deviceType`(選)、
`fingerprint`(選,預設 `""`)、`download`(選,預設 false)。**沒有** `port`/`protocol`。

```json
{"alias":"我的電腦","version":"2.2","deviceModel":"Windows","deviceType":"desktop","fingerprint":"<PC fingerprint>","download":false}
```

### 2.5 `InfoDto`(`GET /api/localsend/v2/info` 回應)

`core/http/dto_v2.rs:139-166`:同 2.4(`fingerprint` 為必要欄位)。

### 2.6 `FileDto`

`core/model/transfer.rs:134-155`:

| 欄位 | 型別 | 必要 | 說明 |
|---|---|---|---|
| `id` | string | 是 | session 內唯一;手錶用 UUID v4(`send_provider.dart:101`) |
| `fileName` | string | 是 | 可含 `/` 表示子資料夾 |
| `size` | number(u64) | 是 | 位元組數,上傳時**必須精確相符** |
| `fileType` | string | 是 | **MIME 類型**;手錶用 `lookupMimeType(fileName) ?? 'application/octet-stream'`(`iso/lib/util/rust.dart:56-62`) |
| `sha256` | string | 否 | 小寫 hex(`core/crypto/hash.rs:23-26,105-107`);比對時不分大小寫 |
| `preview` | string | 否 | 文字訊息內容(見 6.4) |
| `metadata` | object | 否 | `{"modified": RFC3339, "accessed": RFC3339}`,兩者皆可省略(`transfer.rs:149-155,185-196`) |

注意:Rust 線上格式是 `sha256`;Dart 端舊 DTO 裡的 `hash` 鍵(`iso/lib/model/dto/file_dto.dart:96,112`)**不是**線上格式,不要用。
手錶預設會計算並送出 `sha256`(`app/provider/persistence_provider.dart:399-401`),也預設會驗證收到的 `sha256`(`persistence_provider.dart:407-409`)。

### 2.7 `PrepareUploadRequestDto` / `PrepareUploadResponseDto`

`core/http/dto_v2.rs:89-111`:

```json
// 請求
{
  "info": { /* RegisterDto,見 2.3 */ },
  "files": {
    "<fileId>": {"id":"<fileId>","fileName":"photo.jpg","size":324242,"fileType":"image/jpeg","sha256":"<小寫hex>","metadata":{"modified":"2026-11-16T01:23:45.123Z"}}
  }
}
// 回應 200(只包含被接受的檔案)
{"sessionId":"<uuid>","files":{"<fileId>":"<token>"}}
```

### 2.8 錯誤回應 body

`{"message":"..."}`,`Content-Type: application/json`(`core/http/dto.rs:22-26`、`core/http/server/common/error.rs:21-46`、`core/http/server/common/response.rs:22-41`)。
手錶用戶端會讀 `message`;若不是 JSON 就直接用整個 body 當訊息(`core/http/client/mod.rs:333-349`)。

---

## 3. 探索(Discovery)

### 3.1 多播 socket(手錶端行為,PC 照做)

`core/multicast/socket.rs`(以下行號為該檔行號):

- IPv4:每個介面一個 socket,`SO_REUSEADDR`(Unix 另加 `SO_REUSEPORT`),綁 **`0.0.0.0:53317`**,`IP_ADD_MEMBERSHIP(224.0.0.167, 介面位址)`,
  `IP_MULTICAST_IF = 介面位址`,`IP_MULTICAST_LOOP = 1`,`TTL = 1`(`socket.rs:90-123`)。
- IPv6:`IPV6_V6ONLY`,綁 `[::]:53317`,依介面 index 加入 `ff12::fd3a:e420`,hops = 1(`socket.rs:125-155`)。IPv6 是 LocalSend 擴充,IPv4 才是基準(`core/multicast/mod.rs:30-34`)。**PC 只做 IPv4 即可。**
- 宣告發送到 `224.0.0.167:53317`(`socket.rs:47`)。
- 收到的 datagram 解析失敗就略過;`fingerprint == 自己` 就略過(loopback)(`core/multicast/mod.rs:367-378`)。
- **Node(Windows)**:`dgram.createSocket({type:'udp4', reuseAddr:true})` → `bind(53317)` → `addMembership('224.0.0.167', '192.168.50.17')`
  → `setMulticastInterface('192.168.50.17')`、`setMulticastTTL(1)`、`setMulticastLoopback(true)`。PC 上若有官方 LocalSend 在跑,53317 會衝突。

### 3.2 宣告(announce)時機

- 一次宣告 = **3 個 datagram 的 burst**,延遲 100 ms、再 500 ms、再 2000 ms(累計約 0.1 s / 0.6 s / 2.6 s)(`core/multicast/mod.rs:41-49,224-234`)。
- 手錶在以下時機宣告:
  - 探索啟動時(App 啟動、網路設定改變後重啟)(`iso/lib/src/task/discovery/discovery.dart:99-100`)。
  - 「傳送」分頁開啟時若裝置列表為空(`app/pages/tabs/send_tab_vm.dart:228-233`),以及手動重新整理(`app/pages/tabs/send_tab.dart:341`)
    → `StartSmartScan` → staged scan(`app/provider/network/scan_facade.dart:12-34`、`core/discovery/mod.rs:296-334`)。
- **沒有週期性宣告**(本 repo 找不到計時器重送)。【不確定:僅以 grep 確認 app 內無 `Timer.periodic` 觸發掃描】
- PC 建議:啟動時發一次 burst,UI 提供「重新掃描」按鈕再發;可選擇每 30–60 秒補發一次(非協定要求)。

### 3.3 收到宣告時要怎麼回應 — 只用 HTTP

本 repo 的明確規則:**宣告只會被送出,永遠不以 UDP 回應;回應是對宣告者做 HTTP register**(`core/multicast/mod.rs:1-6`、`core/model/discovery.rs:101-104`)。

手錶收到 PC 的宣告時(`core/discovery/mod.rs:472-489,506-565`):

1. 若手錶伺服器沒在跑,不回應(`discovery/mod.rs:381-389,482-484`、`discovery.dart:51-57`)。
2. 對 `https://<datagram 來源 IP>:<message.port>/api/localsend/v2/register` 送 POST,
   **pin 住宣告中的 `fingerprint`**(`discovery/mod.rs:517-541`),逾時 **500 ms**(`discovery/mod.rs:23-26`、`iso/lib/constants.dart:16-19`、`discovery.dart:78`)。
3. 200 且 JSON 解析成功 → 用「宣告中的 fingerprint / port / protocol」+「回應中的 alias / version / deviceModel / deviceType / download」建立裝置(`discovery/mod.rs:543-555,569-589`)。

PC 收到手錶的宣告時,**PC 必須**:

- 對 `https://<來源 IP>:<message.port>/api/localsend/v2/register` POST 自己的 `RegisterDto`,用 PC 憑證做 mTLS,
  並檢查手錶的伺服器憑證 fingerprint == 宣告中的 `fingerprint`。
- body 的 `fingerprint` 必須等於 PC 用戶端憑證的 fingerprint,`port`/`protocol` 必須是 PC 伺服器的真實值——
  手錶會用 **register 請求的來源 IP + body 的 `port`/`protocol`** 建立通道(`receive_controller.dart:55-65`、`iso/lib/util/rust.dart:196-210`)。
- 可同時用手錶的 register 回應更新 UI。

**UDP 回應的替代路徑(非正式)**:手錶的接收端完全不看 `announce` 旗標,任何能解析的 MulticastDto 都被當成宣告並觸發 HTTP register
(`core/multicast/mod.rs:367-388`、`discovery/mod.rs:475-489`)。所以 PC 若發送 UDP(多播或單播到手錶 `:53317`),效果就是「讓手錶來 register PC」。
這不是協定要求,只是一個觀察到的特性。【不確定:單播到手錶 53317 理論上可收到(socket 綁 0.0.0.0),未實測】

### 3.4 子網掃描(手錶的備援)

若宣告後 1 秒內沒有任何裝置被確認(`scan_facade.dart:31`、`discovery/mod.rs:301-330`),手錶會對本機 `/24` 每個 IP 的 `53317` 送 register
(同時 50 個,`discovery/mod.rs:33,342-379`),**不 pin**(`discovery/mod.rs:142-152`),逾時 500 ms。
→ PC 伺服器必須隨時能回應**未預期**的 register;此時手錶採用 PC 的 **TLS 憑證 fingerprint**(而非 body)作為身分(`discovery/mod.rs:168-176`)。

---

## 4. PC 必須提供(SERVE)的 HTTPS 端點 — 接收手錶傳來的檔案

手錶當用戶端時**只會**呼叫下列 v2 端點(`iso/lib/src/isolate/child/http_provider.dart:29` 固定 v2;探索也用 `LsHttpClientV2`,`core/discovery/mod.rs:145-152`)。
**不會呼叫** `/api/localsend/v3/nonce`、`/v3/register`(全 repo 無 `LsHttpClientVersion.v3` 呼叫端),也**不會呼叫** `/info`(Dart 端無呼叫)。

共通:

- 所有請求都走 mTLS,手錶出示自己的憑證(1.3)。
- 路徑格式 `https://<host>:<port>/api/localsend/v2<path>`,query 以 `application/x-www-form-urlencoded` 編碼(`core/http/client/url.rs:21-48`)。
- 手錶判斷成功的條件:register 必須 **200**(`core/http/client/v2.rs:99-101`);prepare-upload `< 400`,且 **204 = 不用傳**(`v2.rs:189-200`);upload 必須 **200**(`v2.rs:268-270`);cancel 不看回應(`v2.rs:301`)。
- HTTPS 回應一律要有 TLS 對方憑證(手錶會讀 `TlsInfo`,`core/http/client/mod.rs:274-307`)——正常 TLS 一定有。

### 4.1 `POST /api/localsend/v2/register`

- 請求:`Content-Type: application/json`,body = 手錶的 `RegisterDto`(2.3)(`core/http/client/v2.rs:74-97`)。
- 回應:**200** + `RegisterResponseDto`(2.4),`Content-Type: application/json`。
  - `fingerprint` 送 PC 憑證 fingerprint(手錶在 HTTPS 模式會改用 TLS 憑證值,但請保持一致)。
  - 若手錶發現回應 fingerprint(HTTPS 時是憑證 fingerprint)等於自己,會當成「連到自己」而忽略(`discovery/mod.rs:177-179`)。
- **必須在 500 ms 內完成**(含握手)。
- PC 應驗證 `body.fingerprint.toUpperCase() == 手錶用戶端憑證 fingerprint`,相符才把手錶加入列表(仿照 `core/http/server/v2.rs:162-192`),
  並以「請求來源 IP + body.port + body.protocol」作為手錶通道。

### 4.2 `GET /api/localsend/v2/info`(以及 `GET /api/localsend/v1/info`)

- 手錶不會呼叫;官方舊版(v1.17 以前)會用 v1 路徑探測(`core/http/server/mod.rs:646-652`)。建議照樣提供,回 200 + `InfoDto`(2.5)。

### 4.3 `POST /api/localsend/v2/prepare-upload`

手錶送出(`core/http/client/v2.rs:149-208`、`app/provider/network/send_provider.dart:234-345`):

- Query:只有在 PC 要求 PIN 時才會帶 `?pin=<PIN>`(`v2.rs:159-171`)。
- Header:`Content-Type: application/json`(`v2.rs:176`)。
- Body:`PrepareUploadRequestDto`(2.7)。`info` 由手錶自身資訊組成:`fingerprint` = 手錶憑證 hash,`port`、`protocol`、`download`(`send_provider.dart:234-245`、`core/http/dto.rs:51-64`)。
- **沒有逾時**:手錶用戶端不設 timeout(`send_provider.dart:95` 呼叫 `pinnedTo` 時無 `timeoutMs`;`core/http/client/mod.rs:244-246`)。PC 可以讓請求一直等到使用者在 PC UI 上按接受/拒絕。
- 手錶在等待中取消:直接**中斷連線**(`v2.rs:180-183`、`send_provider.dart:709-721`:此時還沒有 remoteSessionId,只在本地關閉)。
  → PC 必須監聽 `req`/socket 的 `close`,把 pending 狀態清掉,並撤下 UI 對話框。

PC 的回應與手錶的處理(`send_provider.dart:272-345,354-386`):

| 狀態碼 | 意義 | 手錶行為 |
|---|---|---|
| **200** + `{"sessionId","files":{fileId:token}}` | 接受(可只接受部分檔案) | 只上傳 `files` 裡有 token 的檔案,其餘標記略過(`send_provider.dart:388-401`) |
| **204**(無 body) | 不需要傳檔(例如只收文字訊息) | 視為「已讀並關閉」,結束(`send_provider.dart:354-357,375-386`) |
| **401** | 需要 PIN / PIN 錯誤 | 跳出 PIN 對話框,帶 `?pin=` 重試(`send_provider.dart:274-299`) |
| **403** | 拒絕 | 顯示「已拒絕」(`send_provider.dart:300-307`) |
| **409** | 忙碌(已有其他 session) | 顯示「對方忙碌」(`send_provider.dart:308-315`) |
| **429** | PIN 嘗試次數過多 | 顯示「嘗試次數過多」(`send_provider.dart:316-323`) |
| 其他 ≥400 | 錯誤 | 顯示 `message`(`send_provider.dart:324-332`) |

- 若 200 的 body 解析失敗 → 手錶顯示錯誤(`send_provider.dart:359-373`)。
- 參考手錶伺服器自己的實作:`files` 為空 → 400 `"No files provided"`(`core/http/server/v2.rs:248-250`);JSON 錯誤 → 400 `"Invalid JSON body"`(`core/http/server/common/collect_to_json.rs:11-17`);
  sessionId 與每個檔案的 token 都用 UUID v4(`v2.rs:258,326`)。PC 照做即可。
- 建議 PC 以 `certFingerprint`(TLS)作為寄件者身分,`info.alias` 只用於顯示(`receive_controller.dart:86-100`)。

### 4.4 `POST /api/localsend/v2/upload?sessionId=…&fileId=…&token=…`

手錶送出(`core/http/client/v2.rs:233-273`、`iso/lib/src/task/upload/http_upload.dart:34-50`、`iso/lib/src/isolate/child/upload_isolate.dart`):

- Query 順序 `sessionId`、`fileId`、`token`(`v2.rs:251-255`),form-urlencoded。
- **不帶 Content-Type**,body 是檔案原始位元組串流(`v2.rs:260`)。
- body 由 `reqwest::Body::wrap_stream` 產生(`core/http/client/mod.rs:181-193`),長度未知 → **`Transfer-Encoding: chunked`,沒有 `Content-Length`**。
  PC 伺服器必須支援 chunked(Node 內建支援)。【不確定:依 reqwest 對 stream body 的行為推論】
- 同一個傳送最多 **2 個檔案並行**上傳(`upload_isolate.dart:17,146`),同一 client 重用連線(keep-alive)。
- PC 回 **422** 時,手錶會用同一個 token 重傳該檔,每檔最多 3 次(`upload_isolate.dart:23,190-196`)。
- 手錶不會送 `finish`/`done` 之類的結束請求;所有已接受檔案都上傳完,傳送就結束。

PC 伺服器應做的驗證(仿照手錶伺服器 `core/http/server/v2.rs:369-460`):

1. 缺任一參數 → **400** `"Missing parameters"`(`v2.rs:377-386`)。
2. sessionId 不是目前 session、來源 IP ≠ prepare-upload 的 IP、fileId 不在已接受清單、token 不符、或該檔不在「待上傳」狀態 → **403** `"Invalid token or IP address"`(`v2.rs:388-406,544-549`)。
3. 收到的位元組數必須**剛好等於** `size`,多或少都算失敗(`core/http/server/common/save.rs:284-320`)→ **500**(`v2.rs:454`)。
4. 若有 `sha256` 且有開驗證:不分大小寫比對,不符 → **422** `"Checksum mismatch"`,並把檔案狀態設回「待上傳」以允許重傳(最多 3 次)(`save.rs:224-233`、`v2.rs:455-458,650-679`)。
5. 成功 → **200**,空 body(`v2.rs:453`)。
6. 連線中途中斷 → 該檔視為失敗(`v2.rs:608-648`)。
7. 所有已接受檔案都到達 Finished/Failed → session 結束、釋放單一 session 槽(`v2.rs:680-698`)。

### 4.5 `POST /api/localsend/v2/cancel?sessionId=…`

- 手錶在**上傳階段**取消傳送時呼叫,`sessionId` = PC 在 prepare-upload 給的 sessionId;無 body;手錶不看回應(`v2.rs:284-304`、`send_provider.dart:709-743`)。
- PC 應:若 sessionId 是目前 session 且來源 IP 相符 → 結束 session、刪除未完成檔案、回 200(仿照 `core/http/server/v2.rs:498-534`)。
- 手錶伺服器也接受「沒有 sessionId 的 cancel」來取消 pending 中的 prepare-upload(`v2.rs:471-496`、`core/http/server/common/session.rs:17-22`);
  但手錶**用戶端**在 pending 時不會呼叫 cancel(改為斷線)。PC 伺服器可一併支援,不影響互通。
- 一律回 200(手錶伺服器即使不認得 sessionId 也回 200,`v2.rs:534`)。

### 4.6 其他請求

- 其他路徑回 404(`core/http/server/mod.rs:687-691`)。
- `GET /` 是瀏覽器頁面,手錶不會呼叫,PC 可自由使用——但 **PC 的瀏覽器 UI 不應和 LocalSend API 共用同一個 mTLS 埠**:
  瀏覽器沒有用戶端憑證。建議 UI 另開 `http://127.0.0.1:<另一埠>`。

---

## 5. PC 必須呼叫(CALL)的端點 — 傳檔給手錶

順序:

1. **(探索)** 已透過 3.3 / 3.4 得到手錶的 IP、port、fingerprint。
2. **(選用)** `POST /api/localsend/v2/register`:確認手錶在線、取得最新 alias,並讓手錶列表出現 PC。不是傳檔的前置條件(手錶伺服器的 prepare-upload 不檢查是否註冊過,`core/http/server/v2.rs:227-246`)。
3. `POST /api/localsend/v2/prepare-upload`(可帶 `?pin=`)→ 等手錶使用者按接受。
4. 對每個被接受的檔案 `POST /api/localsend/v2/upload?sessionId=&fileId=&token=`,建議最多 2 個並行。
5. 使用者在 PC 取消時:`POST /api/localsend/v2/cancel?sessionId=<手錶給的 sessionId>`;若 prepare-upload 還在等,直接中斷該連線(或送不帶 sessionId 的 cancel)。

所有請求的共通要求:

- **出示 PC 憑證**(否則 TLS 握手直接失敗,`client_cert_verifier.rs:46-48`、`mod.rs:384-386`)。
- 驗證手錶伺服器憑證 fingerprint == 已知的手錶 fingerprint(仿照 `server_cert_verifier.rs:105-111`)。
- 從**同一個來源 IP** 送 prepare-upload、upload、cancel——手錶伺服器以 IP 綁定 session(`v2.rs:270-274,349-353,394,478,503`)。PC 有多張網卡時要固定走同一個介面。
- 每個 IP 同時最多 **8 條連線**、全部最多 64 條;超過時手錶直接關閉新連線,不回 HTTP 錯誤(`core/http/server/connection_limit.rs:7-14`、`core/http/server/mod.rs:449-469`)。
- 不要使用 HTTP/2。

### 5.1 手錶伺服器對 register 的驗證

- body 必須是合法 `RegisterDto`(必要欄位齊全、`protocol` 小寫),否則 **400** `"Invalid JSON body"`(`collect_to_json.rs:11-17`)。
- `fingerprint`(轉大寫)必須等於 PC 用戶端憑證 fingerprint,否則**靜默忽略**但仍回 200(`v2.rs:162-192`)。
- 回應 200 + 手錶的 `RegisterResponseDto`(`version` 固定 `"2.2"`,`fingerprint` = 手錶憑證 hash,`download` = 手錶是否開網頁下載)(`v2.rs:194-207`)。
- 手錶會把 PC 加入列表,通道 = 「請求來源 IP」+ body 的 `port` + `protocol`(`receive_controller.dart:55-65`、`iso/lib/util/rust.dart:196-210`)。
  若 `fingerprint` 等於手錶自己 → 忽略(`receive_controller.dart:56-59`)。
- 事件用 `try_send`,手錶忙時可能被丟掉,屬可恢復(`v2.rs:169-185`)。PC 可在必要時重送。

### 5.2 手錶伺服器對 prepare-upload 的驗證與回應

`core/http/server/v2.rs:227-367`:

1. **PIN**(先於解析 body):手錶設定了接收 PIN(預設沒有,`app/provider/persistence_provider.dart:468-470`)時:
   - 沒帶 `pin` → 401 `"PIN required"`;帶錯 → 401 `"Invalid PIN"` 並累計;同一 IP 失敗 3 次後 → 429 `"Too many requests"`(`core/http/server/common/pin.rs:9,12-48`)。
     計數存在 LRU(200 個 IP)(`core/http/server/mod.rs:108`),帶對 PIN 時清除。
2. body 解析失敗 → 400 `"Invalid JSON body"`;`files` 為空 → 400 `"No files provided"`(`v2.rs:243-250`)。
3. 檔名做 NFC 正規化(`v2.rs:252-256`)。
4. **單一 session**:槽已被 Pending 或 Active 佔用 → **409** `"Blocked by another session"`(`v2.rs:261-275`)。
5. 等待手錶使用者決定(**無伺服器端逾時**,`v2.rs:293-306`)。
   - 預設 `quickSave = paired`:只有「我的最愛」裡的裝置才自動接受(`persistence_provider.dart:459-462`、`app/provider/settings_provider.dart:64-65`、`receive_controller.dart:129-135`)。
     PC 第一次傳檔時,**手錶使用者必須手動按接受**。
6. 拒絕 → **403** `"Rejected"`(`v2.rs:308-315`)。
7. 接受但選了 0 個檔案(例如文字訊息)→ **204** 無 body(`v2.rs:334-340`)。
8. 接受 → **200** `{"sessionId":"<uuid>","files":{"<fileId>":"<uuid token>"}}`,只含被接受的檔案(`v2.rs:319-366`)。
9. 等待期間 PC 送了不帶 sessionId 的 cancel(同 IP)→ 原本的 prepare-upload 收到 **403** `"Cancelled by sender"`(`v2.rs:300-305`)。
10. App 內部錯誤 → 500(`v2.rs:289-291,297-299`)。

### 5.3 手錶伺服器對 upload 的驗證

見 4.4 的 1–7(那就是手錶自己的實作)。重點:

- `size` 必須精確;若 PC 提供 `sha256`,手錶預設會驗證(`persistence_provider.dart:407-409` → `server_provider.dart:154`)。可以不提供 `sha256`。
- 一個檔案狀態一旦是 InProgress/Finished/Failed 就不能再上傳(403),只有 422 後會回到 Pending(`v2.rs:400-402,670-677`)。
- 上傳失敗的檔案不能重來(除 422 外),整個 session 在所有檔案都 Finished/Failed 後才釋放(`v2.rs:680-686`)。
- **注意**:若 PC 接受後一直不上傳,手錶的 session 槽會一直被佔住,直到手錶使用者關閉/取消。【不確定:App 關閉 session 時是否必呼叫 `cancel_v2_session`,未追完 UI 流程;`core/http/server/mod.rs:192-213` 提供此功能】
- 文件註解寫 upload 可能回 409,但實作中 upload **不會**回 409(只有 400/403/422/500/200)(`core/http/client/v2.rs:227-232` 對照 `core/http/server/v2.rs:369-460`)。

### 5.4 手錶伺服器對 cancel 的處理

`core/http/server/v2.rs:462-535`:

- 若有 Pending 且來源 IP 相符(sessionId 省略或相符)→ 中止等待中的 prepare-upload,回 200。
- 若 sessionId 是 Active session 且 IP 相符 → 清除 session、通知 App(收檔中止),回 200。
- 否則(不是手錶的收件 session)→ 視為「**PC 這個收件端要取消手錶正在傳給 PC 的傳送**」,發 `CancelReceived`(`v2.rs:521-531`)。
  App 會找 `remoteSessionId == sessionId` 且 `target.ip == 來源 IP` 且狀態為 sending 的傳送並中止(`receive_controller.dart:477-497`)。
  → **PC 當收件端想中止手錶的傳送時**:對手錶送 `POST /api/localsend/v2/cancel?sessionId=<PC 自己發的 sessionId>`,且要從手錶上傳時所連的那個 PC IP 發出。
- 永遠回 200。

---

## 6. Session 生命週期

### 6.1 PC 當收件端(手錶 → PC)

```
[Idle] --prepare-upload--> [Pending: 等 PC 使用者決定]
   Pending --使用者拒絕--> 403 --> Idle
   Pending --手錶斷線--> Idle(清除對話框)
   Pending --接受 0 檔--> 204 --> Idle
   Pending --接受 N 檔--> 200 {sessionId, tokens} --> [Active]
   Active  --upload 成功/失敗--> 檔案 Finished/Failed;全部結束 --> Idle
   Active  --cancel?sessionId(同 IP)--> 刪除未完成檔案 --> Idle
   Active  --PC 使用者取消--> 對手錶 POST /cancel?sessionId=<本 session> --> Idle
   任何非 Idle 狀態收到新的 prepare-upload --> 409 "Blocked by another session"
```

建議 PC 照手錶伺服器的單一 session 規則(`core/http/server/mod.rs:64-65`、`core/http/server/v2.rs:261-275`),因為手錶已經會正確處理 409。

### 6.2 PC 當寄件端(PC → 手錶)

```
register(選用) --> prepare-upload(阻塞直到手錶使用者決定)
   401 --> 詢問 PIN --> 帶 ?pin= 重試(3 次錯誤後 429)
   403 拒絕 / 409 忙碌 / 429 --> 結束並顯示
   204 --> 結束(對方已讀)
   200 --> upload × N(≤2 並行)--> 結束
   PC 使用者取消:pending 時中斷連線;Active 時 POST /cancel?sessionId=<手錶的 sessionId>
```

### 6.3 逾時一覽

| 情境 | 逾時 | 來源 |
|---|---|---|
| 手錶探索 register(回應宣告、子網掃描) | 500 ms | `iso/lib/constants.dart:19`、`core/discovery/mod.rs:26`、`discovery.dart:78` |
| 手錶 prepare-upload / upload / cancel | 無 | `send_provider.dart:95`、`http_provider.dart:22-25`、`core/http/client/mod.rs:244-246` |
| 手錶伺服器等使用者決定 | 無 | `core/http/server/v2.rs:293-306` |
| 手錶伺服器 HTTP header 讀取 | 未設定 | `core/http/server/mod.rs:543-553`(hyper 未掛 timer)【不確定】 |
| TCP keepalive(手錶伺服器) | 60 s 後每 10 s 探測 | `core/http/server/mod.rs:338-343` |

### 6.4 文字訊息

- 「訊息請求」= 只有 1 個檔案、`fileType` 是 `text/*`、且有 `preview`(`app/model/state/server/receive_session_state.dart:58-63`、`iso/lib/model/dto/file_dto.dart:119-128`)。
- 手錶傳文字給 PC:1 個檔案 `fileType` 由檔名推得(通常 `text/plain`),`preview` = 文字內容(`send_provider.dart:120-122`)。
  PC 顯示 `preview`,回 **204**(官方收件端的做法:接受 0 個檔案,`receive_controller.dart:194-198`)。
- PC 傳文字給手錶:送 1 個 `FileDto`:`fileName` 例如 `"<uuid>.txt"`、`fileType:"text/plain"`、`size` = UTF-8 位元組數、`preview` = 文字;
  手錶顯示訊息,使用者按接受後回 204,不需上傳。

---

## 7. 範例流程

### 7.1 手錶傳檔給 PC

```
手錶                                             PC
 |--UDP 224.0.0.167:53317 {…,"announce":true}--->|
 |<==TLS(PC 出示伺服器憑證,手錶出示用戶端憑證)===|  PC 驗證手錶憑證 fp == 宣告 fp
 |<--POST /api/localsend/v2/register {PC RegisterDto}
 |---200 {手錶 RegisterResponseDto}------------->|
 |   (手錶列表出現 PC;PC 列表出現手錶)
 |==TLS(手錶 pin PC fp)==========================>|
 |--POST /api/localsend/v2/prepare-upload {info, files}-->|  PC UI 跳出「接收?」
 |<--200 {"sessionId":"S","files":{"F1":"T1"}}----|
 |--POST /api/localsend/v2/upload?sessionId=S&fileId=F1&token=T1 (chunked)-->|
 |<--200-------------------------------------------|
```

### 7.2 PC 傳檔給手錶

```
PC                                               手錶
 |==TLS(PC 出示用戶端憑證;PC 驗證手錶 fp)========>|
 |--POST /api/localsend/v2/prepare-upload {info:{…PC…}, files:{F1:{…}}}-->|  手錶 UI「接收?」
 |<--200 {"sessionId":"S","files":{"F1":"T1"}}----|
 |--POST /api/localsend/v2/upload?sessionId=S&fileId=F1&token=T1  body=檔案-->|
 |<--200-------------------------------------------|
```

---

## 8. PC 端 Node.js 實作要點(非協定,經驗建議)

- 一個 `https.Server` 綁 `0.0.0.0:53317`,`requestCert: true, rejectUnauthorized: false`,不設 ALPN(或 `['http/1.1']`)。
  在 request handler 內用 `req.socket.getPeerCertificate()` 取 `raw`;若沒有憑證就回 403(仿照手錶的強制 mTLS)。
- 用戶端用 `https.Agent({ keepAlive: true, cert, key, rejectUnauthorized: false })`,在 `socket.on('secureConnect')` 比對 fingerprint。
  探索用的 register 請求給 500 ms 上下的逾時;prepare-upload 不設逾時。
- 上傳串流用 `fs.createReadStream().pipe(req)`,設 `Content-Length`(手錶的 hyper 兩種都接受)。
- 收檔時用 `req.on('data')` 累計位元組數與 SHA-256,結束時比對 `size` 與 `sha256`;寫到暫存檔,成功才改名。
- Windows 防火牆需允許 Node 的 TCP 53317 與 UDP 53317 入站(首次執行會跳視窗)。
- 憑證與 fingerprint 要持久化在 `web-peer/` 的資料資料夾。

---

## 9. 本 repo 與官方協定文件的差異 / 注意事項

1. **不使用 UDP 回應**:官方文件允許以 UDP(`announce:false`)回覆作為 HTTP 失敗時的備援;本 repo 只送不回,而且收到的任何 DTO 都當宣告(`core/multicast/mod.rs:1-6,367-388`)。
2. **不讀 `announcement` / `announce`**:接收端 DTO 沒有這兩個欄位(`core/model/discovery.rs:105-141`)。
3. **register 有 fingerprint 綁定**:HTTPS 下 body fingerprint 必須等於用戶端憑證,否則靜默忽略(`core/http/server/v2.rs:162-192`)。
4. **pin 在握手階段**:對方憑證不符時連請求都不會送出(`core/http/client/server_cert_verifier.rs:52-54`)。
5. **無 v3/nonce**:手錶伺服器雖有 `/api/localsend/v3/nonce`、`/v3/register` 路由(`core/http/server/mod.rs:677-686`),手錶用戶端不呼叫;PC 不需實作。
6. **upload 用 chunked**,沒有 Content-Length(4.4)。【不確定】
7. **session 以 IP 綁定**:prepare-upload、upload、cancel 必須同一來源 IP(5.0)。
8. **pending 取消**:手錶伺服器接受無 sessionId 的 cancel;手錶用戶端則以斷線取消(4.3、4.5)。
9. **IPv6 多播**是擴充(`ff12::fd3a:e420`),非必要(`core/multicast/mod.rs:30-36`)。
