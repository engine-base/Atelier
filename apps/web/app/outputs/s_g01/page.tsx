'use client';

import * as React from 'react';
import { useState } from 'react';

import { OutputViewer, type CommentPin } from './_components/OutputViewer';

const HTML = '<h2>サンプル成果物</h2><p>クリックでコメントピンを追加できます。</p>';

export default function SG01Page() {
  const [pins, setPins] = useState<CommentPin[]>([
    { id: 'c1', x: 30, y: 20, text: '見出しの fontWeight を確認', author: 'wanda' },
  ]);
  return (
    <div className="mx-auto w-full max-w-4xl px-md py-lg">
      <OutputViewer
        title="サンプル成果物"
        contentHtml={HTML}
        pins={pins}
        onAddPin={(x, y) =>
          setPins((p) => [
            ...p,
            { id: `c-${Date.now()}`, x, y, text: '新規コメント', author: 'you' },
          ])
        }
      />
    </div>
  );
}
