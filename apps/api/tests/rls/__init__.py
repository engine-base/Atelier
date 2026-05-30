"""RLS 越境試験 (Bundle N: T-I-05..08).

各試験は越境=0 rows を不変条件として検証する。CI Gate #10 RLS isolation matrix
が個別 migration の越境を担保するのに加え、本ディレクトリは「複数 entity を
またいだ越境シナリオ」(workspace + project + Bridge + client_portal + service_role)
を統合検証する。

T-D-22 (R-T08 設計) と T-A-35 (R-T08 クライアント別 JWT) で実装した cross-tenant
分離を最終確認する位置付け。
"""
