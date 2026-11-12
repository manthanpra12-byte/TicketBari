FROM node:20-alpine
WORKDIR /app

# copy package.json first so Docker can cache the npm install step
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

CMD ["node", "src/index.js"]
