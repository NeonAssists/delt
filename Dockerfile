FROM node:20-alpine

WORKDIR /app

# Copy only what the marketing site needs
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY marketing-server.js ./
COPY demo.html explainer.html install.html delt-installer.html install.sh uninstall.sh ./
COPY public/ ./public/

EXPOSE 3000
CMD ["node", "marketing-server.js"]
