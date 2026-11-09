# syntax=docker/dockerfile:1
# Review artifact for the S$0 POC. Read docs/poc/render-neon-free-assessment.md
# before deployment for the protected request-driven processing profile.
FROM node:24-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
ENV PRONTO_LOW_MEMORY_BUILD=1
ENV NODE_OPTIONS=--max-old-space-size=1536
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
# Explicit input list excludes dotenv files, private deployment JSON and Git.
COPY src ./src
# Source-side evaluation helpers import the corpus types during Next typechecking.
# These fixtures are build inputs; the runner still copies only standalone output.
COPY evals ./evals
COPY public ./public
COPY next.config.ts tsconfig.json postcss.config.mjs ./
RUN pnpm exec next build --webpack

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=10000
ENV NODE_OPTIONS=--max-old-space-size=256
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 10000
CMD ["node", "server.js"]
