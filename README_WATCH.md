# LocalSend 手錶版(W527 / 小糯米系統)

這是 [LocalSend](https://github.com/localsend/localsend)(Apache-2.0)的本機修改版,
讓 LocalSend 能在 **Unisoc W527 方形智慧手錶**(Android 9、326x400dp)上正常使用。
手機、平板、桌面版的外觀**完全不變**(已用截圖逐像素比對確認)。

> 這份修改只供自己使用,不會送回 LocalSend 官方(官方不接受 AI 產生的程式碼貢獻)。

## 實測裝置

| 項目 | 數值 |
|---|---|
| 機型 | XG_Watch(紫光展銳 W527,小糯米系統) |
| 系統 | Android 9(API 28) |
| 螢幕 | 408x502 px、200 dpi → 326x400 dp |
| CPU 架構 | arm64-v8a、armeabi-v7a |
| Google 服務 | 無 |

## 改了什麼

所有縮小、精簡的調整都只在「小螢幕」時生效。判斷條件是
`SizingInformation.isCompactScreen(context)`:短邊 < 360dp **且** 長邊 < 480dp。
一般手機的長邊至少約 480dp,所以不會被影響。

| 畫面 | 原本的問題 | 修改後 |
|---|---|---|
| 傳送等待頁 | 內容溢出,狀態文字和「驗證」按鈕重疊 | 上半部可以捲動,「取消」固定在底部 |
| 新增檔案面板 | 只看得到第一排按鈕 | 面板可用整個螢幕高度,6 個選項都能點 |
| 進度頁 | 底部卡片佔掉大半螢幕,檔名被截到約 10 個字 | 卡片縮小,檔名可換行顯示 |
| QR 碼對話框 | 固定 200x200,網址和「關閉」重疊 | QR 依寬度縮放,內容可以捲動 |
| 說明對話框 | 文字被截斷 | 內容可以捲動 |
| 連結分享頁 | 網址列太寬,最後一個按鈕被裁掉 | 網址換行,三個按鈕都完整 |
| 裝置名稱 | 名稱太長時字被縮到幾乎看不見 | 改成用「…」截斷 |
| 底部導覽列 | 高 80dp,內容只剩約 320dp | 改成 56dp,只顯示選中項的文字 |

修改過的檔案都在 `app/lib/`:
`widget/responsive_builder.dart`、`pages/send_page.dart`、`pages/progress_page.dart`、
`pages/web_share_page.dart`、`pages/receive_page.dart`、`pages/home_page.dart`、
`pages/tabs/receive_tab.dart`、`widget/dialogs/*`、`widget/list_tile/*`。

## 建置環境

| 工具 | 版本 / 位置 |
|---|---|
| Flutter | 3.47.9,裝在 `C:\flutter`(沒有使用 fvm) |
| Rust | 1.97.1,另外加 `aarch64-linux-android`、`armv7-linux-androideabi`、`x86_64-linux-android` 三個編譯目標 |
| Android SDK | `C:\Users\evanh\AppData\Local\Android\Sdk` |
| Java | 17 |
| Visual Studio | 需要 C++ 編譯工具(Rust 要用) |

LocalSend 的網路功能是 Rust 寫的,所以編 Android 版一定要裝 Rust。

## 編譯 APK

### 1. 簽名設定(只需要做一次)

建立 `app/android/key.properties`,指向 Android 的 debug 金鑰。這個檔案已被 `.gitignore` 排除:

```properties
storeFile=C:/Users/evanh/.android/debug.keystore
storePassword=android
keyAlias=androiddebugkey
keyPassword=android
```

### 2. 編譯

在 Git Bash 執行:

```bash
export PATH="/c/flutter/bin:$HOME/.cargo/bin:$PATH"
export ANDROID_HOME="C:/Users/evanh/AppData/Local/Android/Sdk"
cd /c/ProjectGit/localsend/app
flutter pub get
dart run build_runner build -d
dart run slang
# 不開 Windows「開發人員模式」也能編:編譯期間暫時把桌面版資料夾改名
mv windows _windows_off && mv linux _linux_off
flutter build apk --release --no-pub --android-skip-build-dependency-validation --target-platform android-arm,android-arm64
mv _windows_off windows && mv _linux_off linux
```

產出的檔案在 `app/build/app/outputs/flutter-apk/app-release.apk`(約 80MB)。

兩個特殊處理的原因:

- **桌面版資料夾改名**:Flutter 在 Windows 上處理外掛時要建立符號連結,必須開啟「開發人員模式」。
  只編 Android 版用不到 `windows/`、`linux/`,所以暫時改名就能避開這個需求。
  如果編譯中途失敗,記得把兩個資料夾的名稱改回來。
- **`--android-skip-build-dependency-validation`**:LocalSend 用的 Gradle 是 8.13,
  Flutter 要求至少 8.14。這個版本差距不影響實際建置,所以跳過這項檢查。

第一次編譯要編 Rust,大約需要 15 到 20 分鐘。

## 安裝到手錶

1. 電腦和手錶連同一個 Wi-Fi。
2. 在電腦上開一個簡單的下載服務(任何 HTTP 伺服器都可以),例如:
   ```bash
   cd app/build/app/outputs/flutter-apk && python -m http.server 8765
   ```
3. 把 `http://<電腦IP>:8765/app-release.apk` 做成 QR 碼,用手錶掃描下載;
   或直接在手錶瀏覽器輸入這個網址。
4. 在瀏覽器的「下載」清單點開 APK,允許「安裝未知來源的應用程式」。

如果 Windows 防火牆把網路設成「公用網路」,手錶可能連不到電腦。
遇到時在防火牆跳出的視窗按「允許存取」,或把網路類型改成「私人網路」。

## 使用方式

- **電腦 ↔ 手錶**:兩邊都裝 LocalSend(電腦裝官方版就可以),連同一個網路就會自動找到對方。
- **用手機熱點**:手錶連手機熱點時,手機和手錶可以直接互傳。
  電腦也要連上同一個熱點才能互傳;部分手機的熱點會隔離連線裝置,這時電腦和手錶之間就傳不了。

## 測試

小螢幕測試會把 82 個畫面情境渲染成手錶尺寸和手機尺寸的截圖,並檢查有沒有內容溢出:

```bash
cd /c/ProjectGit/localsend/app
# 手錶尺寸(326x400),有任何溢出就判定失敗
/c/flutter/bin/flutter test --no-pub test/watch/watch_screens_test.dart --dart-define=WATCH_STRICT=true
# 手機尺寸(412x915),和 test/watch/goldens_phone/ 的截圖比對
/c/flutter/bin/flutter test --no-pub test/watch/watch_screens_test.dart --dart-define=WATCH_SIZE=phone
# 全部測試
/c/flutter/bin/flutter test --no-pub
```

截圖存放位置:手錶尺寸在 `app/test/watch/goldens/`,手機尺寸在 `app/test/watch/goldens_phone/`。
修改版面後要更新截圖,加上 `--update-goldens`。

## 已知限制

- 進度頁的浮動狀態卡會蓋住最後一個檔案的狀態,往上捲就看得到。
- 「本機網路權限」面板空間較小,內容要在面板內捲動(這個面板在 Android 9 上不會出現)。
- 使用的是 debug 金鑰簽名,和官方版簽名不同,不能直接覆蓋安裝官方版。
- 更新到新版 LocalSend 時,要把這次的修改合併過去,再跑一次上面的測試確認。
