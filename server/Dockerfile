FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8787
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "src/index.mjs"]
