# Commons — one process, one JSON file, no build step.
#
#   docker build -t commons .
#   docker run -p 3000:3000 -v commons-data:/data \
#     -e EMAIL_PROVIDER=resend -e EMAIL_API_KEY=... -e EMAIL_FROM='Commons <hello@example.org>' \
#     -e COMMUNITY_MODERATORS=yourhandle commons
#
# The image sets NODE_ENV=production, so it refuses to start until a way to
# send one-time codes is configured (see docs/deploy.md). To try it without
# one, pass -e NODE_ENV=development and codes are printed to the container log.

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Commons state lives on a volume so it survives the container.
ENV COMMUNITY_DATA=/data/community.json

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY data/fixtures.json ./data/fixtures.json

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/community/health || exit 1

CMD ["node", "--experimental-strip-types", "src/server.ts"]
