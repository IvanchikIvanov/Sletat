## Sletat Telegram Bot (NestJS)

NestJS-приложение с Telegram-ботом для поиска и мониторинга туров через Sletat (сейчас MOCK API), OpenAI (Whisper + JSON-парсинг), PostgreSQL и Redis.

### Установка

```bash
npm install
```
# Explanation: Устанавливаем зависимости проекта.

Скопируй `.env.example` в `.env` и заполни значения (OpenAI, Telegram, Sletat и т.д.).

### Prisma

```bash
npx prisma generate
```
# Explanation: Генерируем Prisma Client по schema.prisma.

```bash
npx prisma migrate dev --name init
```
# Explanation: Применяем начальную миграцию схемы БД.

### Локальный запуск (без Docker)

```bash
npm run start:dev
```
# Explanation: Запуск NestJS в dev-режиме с ts-node-dev.

### Запуск через Docker Compose

```bash
docker-compose up --build
```
# Explanation: Поднимаем api, postgres и redis через docker-compose.

API по умолчанию слушает порт `3000`, Telegram-бот работает через long polling.

