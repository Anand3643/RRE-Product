# RRE Tally - the central server that every computer and phone connects to (see docs/HOSTING.md).
# The data is NOT in this container: it is in the central PostgreSQL database (Supabase) given by DATABASE_URL.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# dependencies first (cached between builds); dev tools (electron, test database, css builder) are not installed
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# listen on all interfaces inside the container; the hosting platform's https proxy is in front of it
ENV HOST=0.0.0.0 \
    PORT=4000 \
    RRE_TRUST_PROXY=1 \
    RRE_ENFORCE_AUTH=1 \
    RRE_DB=postgres

EXPOSE 4000
# scratch space only (logs, temporary files): business data is in PostgreSQL, so losing this folder on a redeploy loses nothing
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
