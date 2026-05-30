# Atelier Bridge 配布スクリプト

このディレクトリは Bridge (Electron / MCP server) の配布パイプライン用シェル
スクリプトを保持する。Vibeyard fork (electron-forge ベース) の取り込みが完了する
までは placeholder として scope を予約する。

| スクリプト | 対象 | 役割 |
|---|---|---|
| `build-dmg.sh` | macOS | .dmg (signed + notarized) |
| `build-msi.sh` | Windows | .msi (Authenticode 署名) |
| `build-linux.sh` | Linux | AppImage + .deb |
| `release-npm.sh` | npm registry | MCP server 単独版を `@atelier/bridge` で publish |

## 環境変数

```bash
# macOS
APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID
CSC_LINK, CSC_KEY_PASSWORD  # cert + p12 password
# Windows
CSC_LINK, CSC_KEY_PASSWORD
# npm
NPM_TOKEN
```

## CI 連携

将来的に `.github/workflows/release-bridge.yml` (T-I-XX) で本スクリプト群を呼び、
git tag `bridge-v*` で自動配布する。
