FROM node:24-alpine AS build
WORKDIR /source
RUN npm install -g pnpm@11.25.0
COPY packages/content-format/ packages/content-format/
RUN npm --prefix packages/content-format ci && npm --prefix packages/content-format run build
COPY apps/admin/ apps/admin/
COPY .agents/skills/ .agents/skills/
COPY docs/question-bank-import/ docs/question-bank-import/
RUN pnpm --dir apps/admin install --frozen-lockfile && node apps/admin/scripts/build-bank-skills.mjs
COPY apps/mcp/ apps/mcp/
RUN pnpm --dir apps/mcp install --frozen-lockfile && pnpm --dir apps/mcp build && pnpm --dir apps/mcp prune --prod

FROM node:24-alpine
WORKDIR /app
COPY --from=build /source/apps/mcp/dist/ dist/
COPY --from=build /source/apps/mcp/package.json package.json
COPY --from=build /source/apps/mcp/node_modules/ node_modules/
COPY --from=build /source/apps/admin/public/qanda-bank-skills.zip skills.zip
ENV QANDA_SKILLS_ZIP=/app/skills.zip PORT=8090
COPY apps/mcp/readiness.mjs readiness.mjs
USER node
HEALTHCHECK --interval=5s --timeout=5s --start-period=15s --retries=12 CMD ["node", "readiness.mjs"]
CMD ["node","dist/server.js"]
