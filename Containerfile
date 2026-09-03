FROM node:25-alpine AS builder

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server

COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client

COPY server/ ./server/
RUN npm run build --prefix server
RUN npm ci --omit=dev --prefix server

COPY client/ ./client/
# Serve the app from a subfolder behind a reverse proxy, e.g. --build-arg BASE_PATH=/mediathek/
# The client bundle bakes this in, so it is a build-time value rather than a runtime one.
ARG BASE_PATH=/
ENV VITE_BASE_PATH=$BASE_PATH
RUN npm run build --prefix client

RUN mkdir -p /dist/client && \
    mkdir -p /dist/data && \
    cp -R /app/server/dist/* /dist/ && \
    cp -R /app/client/dist/* /dist/client/

FROM node:25-alpine

ENV NODE_ENV=production

RUN addgroup -S mediathekviewweb && adduser -S mediathekviewweb -G mediathekviewweb

WORKDIR /mediathekviewweb

COPY --from=builder /dist .

RUN chown mediathekviewweb:mediathekviewweb /mediathekviewweb/data

USER mediathekviewweb
EXPOSE 8000

CMD [ "node", "app.js" ]
