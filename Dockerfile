FROM node:24-alpine

WORKDIR /app

# Keep the image self-contained: the deterministic synthetic dataset is
# generated during the image build and served with the prototype.
COPY package.json ./
COPY scripts/ ./scripts/
COPY data/ ./data/
COPY backend/ ./backend/
COPY docs/ ./docs/
COPY index.html styles.css app.js server.mjs CAPABILITIES.md README.md ./
RUN node scripts/verify-data.mjs && mkdir -p /app/storage && chown node:node /app/storage

ENV NODE_ENV=production
ENV APP_ENV=demo
ENV DEMO_MODE=true
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
