FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY collectors/vscode/package.json ./collectors/vscode/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/continuum/package.json ./packages/continuum/package.json
COPY packages/cloud/package.json ./packages/cloud/package.json
RUN npm ci --ignore-scripts
COPY packages/contracts/tsconfig.json ./packages/contracts/tsconfig.json
COPY packages/contracts/src ./packages/contracts/src
COPY packages/cloud/tsconfig.json packages/cloud/tsconfig.build.json ./packages/cloud/
COPY packages/cloud/src ./packages/cloud/src
COPY packages/cloud/migrations ./packages/cloud/migrations
RUN npm run build -w @continuum/contracts && npm run build -w @continuum/cloud && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/packages/cloud/package.json ./packages/cloud/package.json
COPY --from=build /app/packages/cloud/dist ./packages/cloud/dist
COPY --from=build /app/packages/cloud/migrations ./packages/cloud/migrations
USER node
EXPOSE 43118
CMD ["node", "packages/cloud/dist/main.js"]
