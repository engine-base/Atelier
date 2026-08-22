/**
 * ReconsentNotice — GAP-206: 規約が新しくなったことを本人に伝えて同意を取る。
 *
 * **これまでの実態**:
 *   同意の記録は新規登録のときだけで、**既に登録済みの人へ再同意を求める導線が
 *   無かった**。GAP-188（各自の Claude 契約が必要）と GAP-204（複製・模倣の
 *   禁止 / 機械学習への利用禁止）を規約へ足したが、旧版に同意したままの
 *   利用者にはその条項が効きにくい状態だった。
 *
 * **やらないこと（意図的）**:
 *   **同意するまで使わせない、という強制はしない。** それは法務レビューの結果と
 *   経営判断で決めることで、実装が先走ってよいものではない。ここで作るのは
 *   「求められる状態」であって「強制」ではない。閉じることもできる。
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FileText, X } from 'lucide-react';

import { getJson, sendJson } from '../../lib/auth/connector';

interface ConsentStatus {
  readonly doc_type: string;
  readonly current_version: string | null;
  readonly accepted_version: string | null;
  readonly needs_consent: boolean;
}

interface ConsentStatusList {
  readonly items: readonly ConsentStatus[];
  readonly needs_consent: boolean;
}

const LABEL: Record<string, string> = {
  terms_of_service: '利用規約',
  privacy_policy: 'プライバシーポリシー',
};

const HREF: Record<string, string> = {
  terms_of_service: '/terms',
  privacy_policy: '/privacy',
};

/** この画面を閉じたことを覚えるキー（版が変わればまた出る）。 */
const DISMISS_KEY = 'atelier.reconsent.dismissed';

function dismissedVersions(): string {
  try {
    return window.localStorage.getItem(DISMISS_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 出ている版の組み合わせを 1 つの文字列にする（版が変われば別物になる）。 */
export function versionKey(items: readonly ConsentStatus[]): string {
  return items
    .filter((i) => i.needs_consent)
    .map((i) => `${i.doc_type}:${i.current_version ?? ''}`)
    .sort()
    .join('|');
}

export function ReconsentNotice() {
  const [pending, setPending] = useState<readonly ConsentStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(() => {
    getJson<ConsentStatusList>('/me/consents')
      .then((res) => {
        const items = res.data.items.filter((i) => i.needs_consent);
        setPending(items);
        // 同じ版で一度閉じていれば出さない（版が変われば再び出る）
        setHidden(items.length > 0 && dismissedVersions() === versionKey(items));
      })
      .catch(() => {
        // 未ログイン等では出さない（ここでエラーを見せる必要はない）
        setPending([]);
      });
  }, []);

  useEffect(load, [load]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const item of pending) {
        if (!item.current_version) continue;
        await sendJson('POST', '/me/consents', {
          doc_type: item.doc_type,
          version: item.current_version,
        });
      }
      load();
    } catch {
      setError(
        '同意を記録できませんでした。内容が更新された可能性があります。読み直してからもう一度お試しください。',
      );
      load();
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, versionKey(pending));
    } catch {
      /* 保存できなくても閉じられる */
    }
    setHidden(true);
  };

  if (pending.length === 0 || hidden) return null;

  return (
    <div
      role="region"
      aria-label="規約の更新のお知らせ"
      className="border-b border-border bg-tertiary-container px-md py-2 text-[12.5px] leading-[1.6] text-on-tertiary-container sm:px-[24px]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FileText size={14} aria-hidden="true" className="shrink-0" />
        <span className="flex-1 min-w-[200px]">
          <strong className="font-semibold">
            {pending.map((p) => LABEL[p.doc_type] ?? p.doc_type).join('・')}
          </strong>
          を更新しました。内容をご確認のうえ、同意をお願いします。
        </span>
        {pending.map((p) => (
          <Link
            key={p.doc_type}
            href={HREF[p.doc_type] ?? '/terms'}
            className="shrink-0 rounded-md border border-current px-2 py-[3px] font-medium hover:opacity-80"
          >
            {LABEL[p.doc_type] ?? p.doc_type}を読む
          </Link>
        ))}
        <button
          type="button"
          onClick={() => void accept()}
          disabled={busy}
          className="shrink-0 rounded-md bg-primary px-3 py-[5px] font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '記録中…' : '同意する'}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="あとで"
          title="あとで（次に更新されたらまた表示します）"
          className="shrink-0 rounded-sm p-[3px] hover:bg-black/5"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
