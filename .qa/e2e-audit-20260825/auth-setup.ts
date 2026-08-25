/**
 * 認証済みの storageState を作る global setup。
 *
 * 直下 37 spec のうち auth ヘルパーを使っているのは 1 本だけで、残りは
 * cookie 無しで保護ページへ行き middleware に /signin へ飛ばされている。
 * 「画面が壊れている」のか「テストがログインしていないだけ」なのかを
 * 分けるため、e2e-seed の QA ユーザーで cookie を入れた状態でも測る。
 */
import { createHmac } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

const SECRET =
  process.env.ATELIER_AUTH_JWT_SECRET ?? 'local-human-qa-secret-at-least-32-characters-long';
const USER = 'a818edcd-8e05-4bd9-a0d1-aaf80c777adf'; // scripts/ci/e2e-seed.sql の QA Human
const WS = '2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69'; // QA Human WS
const ORIGIN = process.env.ATELIER_E2E_BASE_URL ?? 'http://127.0.0.1:3100';

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const p = b64(
  JSON.stringify({
    sub: USER,
    role: 'authenticated',
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
);
const jwt = `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;

export default function globalSetup(): void {
  mkdirSync('/home/user/Atelier/.qa/e2e-audit-20260825', { recursive: true });
  writeFileSync(
    '/home/user/Atelier/.qa/e2e-audit-20260825/storage-state.json',
    JSON.stringify(
      {
        cookies: [
          {
            name: 'atelier_access',
            value: jwt,
            domain: '127.0.0.1',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 3600,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [
          {
            origin: ORIGIN,
            localStorage: [{ name: 'atelier_current_workspace', value: WS }],
          },
        ],
      },
      null,
      2,
    ),
  );
}
