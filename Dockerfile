FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node src ./src
COPY --chown=node:node LICENSE NOTICE.md ./
USER node
ENV HOST=0.0.0.0 PORT=3100
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
