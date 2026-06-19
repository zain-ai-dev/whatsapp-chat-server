FROM node:18-alpine

WORKDIR /app

COPY package.json .

RUN npm install

COPY chat-state-server.js .

EXPOSE 3000

CMD ["node", "chat-state-server.js"]
