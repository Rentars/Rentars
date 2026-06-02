FROM node:20-alpine AS base

WORKDIR /app

RUN apk add --no-cache libc6-compat wget

COPY package.json ./
RUN npm install --legacy-peer-deps

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001

EXPOSE 3001

CMD ["npm", "run", "dev", "--", "-p", "3001"]
