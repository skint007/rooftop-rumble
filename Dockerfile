# Rooftop Rumble: one Node process serves the page and the WebSocket rooms.
# Node strips TypeScript types itself, so there's no build stage.
FROM node:26.13.1-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY public ./public
COPY src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null http://127.0.0.1:8080/ || exit 1
CMD ["node", "--no-warnings", "src/server/server.ts"]
