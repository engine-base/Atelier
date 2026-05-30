# 本番ドメイン・SSL・カスタムドメイン (T-I-21)

Atelier の本番リリース時に必要な DNS / SSL 周りの手順書。

## 本番ドメイン

| 用途 | ドメイン | プロバイダ |
|---|---|---|
| Web 本体 | `app.atelier.example` | Vercel |
| API | `api.atelier.example` | Fly.io |
| クライアントポータル | `client.atelier.example` (route group `/client`) | Vercel |
| 公開 LP / 規約 | `atelier.example` | Vercel |
| Bridge 更新 manifest | `bridge.atelier.example` | Vercel + S3 |

## DNS 設定 (Cloudflare 想定)

```
@                A      <Vercel anycast IP>
www              CNAME  atelier.example
app              CNAME  cname.vercel-dns.com.
api              CNAME  <fly app>.fly.dev.
client           CNAME  cname.vercel-dns.com.
bridge           CNAME  cname.vercel-dns.com.
_dmarc           TXT    "v=DMARC1; p=quarantine; rua=mailto:dmarc@atelier.example"
@                TXT    "v=spf1 include:_spf.google.com -all"
```

DKIM は SES / SendGrid 設定後にプロバイダ発行値を追加する。

## SSL / TLS

- Vercel / Fly.io 共に **自動 Let's Encrypt** 取得。
- 強制 HTTPS は Vercel / Fly.io 側で有効化。
- HSTS は `next.config.ts` の `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` で送出済 (T-F-XX)。
- `preload` リストへの追加は本番安定 1 ヶ月後に申請。

## カスタムドメイン (顧客用)

クライアントが自社ドメインで Atelier クライアントポータルを公開する場合:

1. 顧客が `customer.example.com` を CNAME で `cname.vercel-dns.com.` に向ける
2. Vercel Project で `customer.example.com` を Custom Domain に追加
3. `client_invitations` 配布 URL を `https://customer.example.com/client/...` に切替
4. R-T08 完全分離は維持 (project_id claim ベース、ドメインでの分離ではない)

## チェックリスト (本番リリース前)

- [ ] 全 5 ドメインで `dig` で正しい CNAME を確認
- [ ] `curl -I https://app.atelier.example` で HSTS ヘッダを確認
- [ ] `openssl s_client` で証明書チェーンを確認
- [ ] SPF / DKIM / DMARC を `dig TXT` で確認
- [ ] `_dmarc` の rua アドレスにメール集約を設定
- [ ] Cloudflare の TLS mode = "Full (strict)" に設定 (Vercel/Fly 経由でも)
