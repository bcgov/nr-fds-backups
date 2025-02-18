FROM node:22-slim
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app
COPY package*.json backup.js ./
RUN npm ci

USER node
CMD ["npm", "run", "backup"]
