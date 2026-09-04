# 通し R5 — 本番実測 (2026-09-04, web=52e14809b385 / prod(pre-launch))

## 本番の版
name="atelier-build" content="52e14809b385"

## GAP-327: セッション cookie の受け渡し口が middleware の門の内側にある
POST /api/session -> HTTP/2 307  location: /signin?redirect=%2Fapi%2Fsession 
DELETE /api/session -> HTTP/2 307  location: /signin?redirect=%2Fapi%2Fsession 
GET /api/session/token -> HTTP/2 307  location: /signin?redirect=%2Fapi%2Fsession%2Ftoken 

## 参考: 本番 API の版 (GAP-285 / GAP-315 が未反映)
/health -> {"status":"ok","service":"atelier-api","version":"0.1.0"}
/health/capabilities -> {"detail":"Not Found"}
