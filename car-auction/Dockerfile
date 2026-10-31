# صورة إنتاج: Node 22 على Alpine، مستخدم غير جذري، اعتماديات الإنتاج فقط
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY db ./db
COPY scripts/init-db.js ./scripts/init-db.js
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s CMD wget -qO- http://127.0.0.1:4000/readyz || exit 1
# يهيّئ قاعدة البيانات بأمان عند الإقلاع (لا يمس قاعدة موجودة) ثم يشغّل الخادم
CMD ["sh", "-c", "node scripts/init-db.js && exec node src/server.js"]
