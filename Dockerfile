# 1단계: 클라이언트 빌드
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2단계: 실행. 서버는 Node의 TypeScript 타입 제거 기능으로 .ts를 바로 실행하므로 서버 빌드 단계가 없다.
# 게임은 메모리에만 두므로 볼륨이 필요 없다.
FROM node:24-slim
WORKDIR /app
ENV PORT=3100
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
EXPOSE 3100
CMD ["node", "server/main.ts"]
