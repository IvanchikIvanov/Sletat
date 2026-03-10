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



### Настройка реальной интеграции Sletat

По умолчанию включен реальный клиент (`SLETAT_MODE=api`). Для локальных тестов можно вернуть заглушку (`SLETAT_MODE=mock`).

Ключевые переменные окружения:

- `SLETAT_PROTOCOL` — формат шлюза поиска (`json` или `xml`).
- `SLETAT_CLAIMS_PROTOCOL` — формат шлюза заявок/платежей (`json` или `xml`).
- `SLETAT_ENDPOINT_DEPARTURE_CITIES`, `SLETAT_ENDPOINT_COUNTRIES`, `SLETAT_ENDPOINT_MEALS`, `SLETAT_ENDPOINT_HOTELS`.
- `SLETAT_ENDPOINT_SEARCH`, `SLETAT_ENDPOINT_ACTUALIZE`.
- `SLETAT_ENDPOINT_CLAIM_CREATE`, `SLETAT_ENDPOINT_CLAIM_INFO`, `SLETAT_ENDPOINT_PAYMENTS`.

Эти переменные позволяют зафиксировать пути методов в точном соответствии с вашей версией документации Sletat без изменения кода.


Подробный пошаговый гайд по установке и настройке: `SETUP_GUIDE_RU.md`.


### Troubleshooting npm install

Если при `npm install` возникает ошибка:

```
404 Not Found - @types/telegraf
```

это означает, что у вас локально/в ветке все еще присутствует устаревшая dev-зависимость `@types/telegraf`.

Решение:

1. Убедиться, что в `package.json` **нет** строки `@types/telegraf`.
2. Обновить ветку до коммита с фиксом (или удалить зависимость вручную):

```bash
npm pkg delete devDependencies.@types/telegraf
rm -rf node_modules package-lock.json
npm install --legacy-peer-deps
```

3. Для установки с GitHub взять ветку с фиксами, если `main` еще не обновлен:

```bash
git fetch --all
git checkout codex/verify-project-requirements-against-documentation
```
