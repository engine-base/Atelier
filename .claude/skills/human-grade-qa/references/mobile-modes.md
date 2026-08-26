# Mobile Modes — モバイル QA

モバイル UI / モバイル app が含まれる場合の追加考慮。

## 対象の判定

以下があれば mobile 対象:

- `ios/` / `android/` ディレクトリ（React Native, Expo, Flutter, native）
- `capacitor.config.*` / `ionic.config.*`
- レスポンシブ Web で「mobile breakpoint」がある
- PWA（`manifest.json`, `service-worker.*`）

## レスポンシブ Web の場合

Chrome MCP で実行。

### ビューポート

| 端末想定 | width × height |
|---|---|
| iPhone SE | 375 × 667 |
| iPhone 15 Pro | 393 × 852 |
| iPad mini | 768 × 1024 |
| Desktop | 1440 × 900 |

`resize_window` で切替。最低 mobile + desktop の 2 解像度。

### touch 操作

- click → tap として動くか
- long press / swipe / pinch が必要なケースは `javascript_tool` で `TouchEvent` を発火
- スクロール時の sticky header / bottom sheet 崩れ確認

### ソフトウェアキーボード

- input フォーカス時にビューポート縮小
- IME 変換中の入力イベント

## iOS Simulator

`xcrun simctl` 系コマンドで操作。Bash 経由:

```bash
# 起動中シミュレータ一覧
xcrun simctl list devices booted

# URL を Safari で開く
xcrun simctl openurl booted https://localhost:5173

# スクショ保存
xcrun simctl io booted screenshot .qa/runs/<run>/screenshots/ios/$(date +%H%M%S).png

# 通知を送る
xcrun simctl push booted <bundle-id> payload.json
```

UI 自動操作は `xcodebuild test` (XCUITest) もしくはチュートリアル時のみヒト依頼に回す。

## Android Emulator

```bash
# adb 経由
adb devices
adb shell input tap <x> <y>
adb shell input text "hello"
adb exec-out screencap -p > screenshot.png
```

## ネイティブ機能はヒトに依頼

以下は **物理デバイスが要る** ため依頼テンプレを使う:

- 生体認証（Face ID / Touch ID）
- カメラ実機
- NFC / Bluetooth
- プッシュ通知（実 APNs/FCM）
- アプリ内課金（実 Sandbox 越え）
- 位置情報（実 GPS）

## オフライン / 弱回線

- DevTools Network を offline / slow 3G に
- Service Worker キャッシュが効くか
- 失敗 → 自動リトライ
- オフライン作成 → オンライン復帰時の sync

## アクセシビリティ

- VoiceOver / TalkBack 必要なら **ヒト依頼**
- 軽量チェック: `axe-core` を `javascript_tool` で注入し違反列挙

```js
fetch('https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.0/axe.min.js')
  .then(r => r.text())
  .then(eval)
  .then(() => axe.run())
  .then(r => r.violations)
```

ただし CDN ロードは CSP で弾かれることがあるので、できれば repo にローカルコピーを置く。

## 機種固有

- iPhone notch / Dynamic Island エリアで UI が隠れる
- iPad split view
- Android keyboard suggestion bar
- Tablet landscape

これらは可能な範囲でビューポート切替 + safe area inset の CSS 検査で代替。
完全検証は物理デバイス必須 → 依頼。
