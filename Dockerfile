FROM mcr.microsoft.com/playwright:v1.41.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

# Zainstaluj przeglądarkę Chromium
RUN npx playwright install chromium

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
