# Мессенджер «Контур» — сервер в контейнере
FROM node:20-alpine

WORKDIR /app

# только серверные зависимости
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

# код сервера и веб-клиент
COPY server/ ./server/
COPY web/ ./web/

ENV PORT=4000 HOST=0.0.0.0 DATA_DIR=/data WEB_DIR=/app/web
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
CMD ["node", "server.js", "--host", "0.0.0.0"]
