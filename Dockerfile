FROM node:20-alpine
WORKDIR /app
COPY package.json router.config.json ./
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8787
# State is written next to the config; mount a volume on /data to keep daily counters across container restarts.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
# Binding 0.0.0.0 inside the container: the server refuses to start without ROUTER_TOKEN (docker run -e ROUTER_TOKEN=...).
CMD ["node", "src/server.js", "--host", "0.0.0.0", "--port", "8787", "--config", "router.config.json", "--state", "/data/router.state.json"]
