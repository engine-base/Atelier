# Atelier Bridge 配布スクリプト

このディレクトリは Bridge (Electron + MCP server) の配布パイプライン用シェル
スクリプトを保持する。**electron-builder で実走確認済** (T-I-11/12 補強)。

| スクリプト | 対象 | 役割 | 確認状況 |
|---|---|---|---|
| `build-dmg.sh` | macOS | .dmg (signed + notarized) | electron-builder 配線済、要 macOS host |
| `build-msi.sh` | Windows | .exe (NSIS) | electron-builder 配線済、要 Windows host or wine |
| `build-linux.sh` | Linux | AppImage + .deb | ✅ ローカルで AppImage 104MB / .deb 95MB 生成確認 |
| `release-npm.sh` | npm registry | MCP server 単独版を `@atelier/bridge` で publish | placeholder |

## ローカル動作確認 (Linux, 2026-05-30)

```bash
pnpm -F @atelier/bridge build              # tsc 0 errors
pnpm -F @atelier/bridge exec electron-builder --linux AppImage deb --publish=never
ls -lh apps/bridge/out/
# atelier-bridge-0.1.0-linux-x86_64.AppImage   104M (ELF executable)
# atelier-bridge-0.1.0-linux-amd64.deb          95M (Debian binary package)
```

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
