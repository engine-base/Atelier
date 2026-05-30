# syntax=docker/dockerfile:1.7
# Atelier Web — ローカル開発 / デモ用 Docker image。
#
# pnpm monorepo を丸ごと build context に取り、@atelier/web を build → next start。
# NEXT_PUBLIC_API_URL はブラウザ(client)が叩く URL なので、docker 内部名 (api) では
# なくホスト到達可能な http://localhost:8000 を build arg で焼き込む。

FROM node:20-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /repo

# monorepo 全体をコピー (workspace deps: @atelier/shared, api-client, design-tokens)
COPY . .

# 依存 install (electron 等の postinstall / husky prepare は skip)
RUN pnpm install --frozen-lockfile --ignore-scripts

ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm -F @atelier/web exec next build

EXPOSE 3000

# next start (本番ビルドを serve)
CMD ["pnpm", "-F", "@atelier/web", "exec", "next", "start", "-p", "3000"]
