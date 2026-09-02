# アーキテクチャ設計書
プロジェクト名：
作成日：YYYY-MM-DD
バージョン：1.0

## システム概要図

```mermaid
graph TB
    subgraph Client
        Browser[ブラウザ / モバイルアプリ]
    end
    subgraph Frontend
        Next[Next.js / React App]
    end
    subgraph Backend
        API[API Server]
        Auth[認証サービス]
    end
    subgraph Data
        DB[(PostgreSQL)]
        Cache[(Redis)]
        Storage[S3 / Storage]
    end
    subgraph External
        Ext1[外部サービス1]
        Ext2[外部サービス2]
    end

    Browser --> Next
    Next --> API
    API --> Auth
    API --> DB
    API --> Cache
    API --> Storage
    API --> Ext1
```

## コンポーネント一覧
| コンポーネント | 技術 | 役割 | スケーリング方針 |
|-------------|------|------|-------------|
| フロントエンド | | | |
| APIサーバー | | | |
| データベース | | | |
| キャッシュ | | | |
| 認証 | | | |

## データフロー図
```mermaid
sequenceDiagram
    participant U as ユーザー
    participant F as フロントエンド
    participant A as APIサーバー
    participant D as DB

    U->>F: 操作
    F->>A: API呼び出し
    A->>D: クエリ
    D-->>A: 結果
    A-->>F: レスポンス
    F-->>U: 画面更新
```

## 技術スタック選定理由
| 技術 | 採用理由 | 代替案 | 却下理由 |
|-----|---------|-------|---------|
| | | | |

## 非機能要件の対応方針
| 要件 | 方針 | 実装方法 |
|-----|------|---------|
| 可用性 | | |
| スケーラビリティ | | |
| セキュリティ | | |
| パフォーマンス | | |

## デプロイ構成
```mermaid
graph LR
    Dev[開発環境] -->|PR Merge| Staging[ステージング]
    Staging -->|承認| Prod[本番環境]
```
