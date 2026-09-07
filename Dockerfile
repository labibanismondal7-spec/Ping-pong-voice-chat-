FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p data logs uploads public/uploads && chown -R node:node data logs uploads public/uploads
USER node
EXPOSE 3000
CMD ["node", "scripts/start-production.js"]
