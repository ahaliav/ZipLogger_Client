FROM node:22-alpine AS vendor
WORKDIR /src
COPY package.json ./
# Pulls @ziplogger/browser from npm and copies its ESM entry into vendor/.
RUN npm install --omit=dev --no-audit --no-fund

FROM nginx:1.27-alpine
COPY index.html app.js /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=vendor /src/vendor/ziplogger-browser.js /usr/share/nginx/html/vendor/
COPY docker-entrypoint.d/10-config.sh /docker-entrypoint.d/10-config.sh
RUN chmod +x /docker-entrypoint.d/10-config.sh
