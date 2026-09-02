# ER図
プロジェクト名：
作成日：YYYY-MM-DD

## エンティティ関係図

```mermaid
erDiagram
    USER {
        uuid id PK
        string email UK
        string name
        timestamp created_at
        timestamp updated_at
    }
    
    RESOURCE {
        uuid id PK
        uuid user_id FK
        string title
        text content
        enum status
        timestamp created_at
        timestamp updated_at
    }
    
    TAG {
        uuid id PK
        string name UK
    }
    
    RESOURCE_TAG {
        uuid resource_id FK
        uuid tag_id FK
    }
    
    USER ||--o{ RESOURCE : "creates"
    RESOURCE }o--o{ TAG : "has"
    RESOURCE_TAG }|--|| RESOURCE : ""
    RESOURCE_TAG }|--|| TAG : ""
```

## テーブル定義
### users
| カラム名 | 型 | 制約 | 説明 |
|---------|---|------|------|
| id | UUID | PK, NOT NULL | |
| email | VARCHAR(255) | UNIQUE, NOT NULL | |
| name | VARCHAR(100) | NOT NULL | |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

### （各テーブルを同形式で追加）

## インデックス設計
| テーブル | カラム | 種別 | 理由 |
|---------|-------|------|------|
| | | | |
