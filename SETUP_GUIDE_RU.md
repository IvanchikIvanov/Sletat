# Гайд: установка и настройка Telegram-бота Sletat

Этот гайд описывает запуск проекта из репозитория в двух режимах:
- **локально** (Node.js + локальные Postgres/Redis),
- **через Docker Compose** (рекомендуется для быстрого старта).

---

## 1. Что делает бот

Бот умеет:
- принимать текстовые и голосовые запросы в Telegram,
- распознавать голос через OpenAI,
- парсить запрос в параметры тура,
- выполнять поиск через Sletat,
- создавать подписки на мониторинг,
- отправлять уведомления и запускать сценарий бронирования.

Ключевые модули подключаются в `AppModule`: Config, Persistence, OpenAI, Sletat, Search, Subscriptions, Monitoring, Booking, Telegram, Health.

---

## 2. Требования

Перед запуском убедитесь, что установлены:
- **Node.js 20+**,
- **npm**,
- **PostgreSQL 16+**,
- **Redis 7+**,
- **Docker + Docker Compose** (если будете запускать в контейнерах).

Также потребуются доступы:
- токен Telegram-бота,
- API-ключ OpenAI,
- логин/пароль и endpoint'ы Sletat.

---

## 3. Переменные окружения (.env)

1) Скопируйте шаблон:

```bash
cp .env.example .env
```

2) Заполните обязательные поля:
- `TELEGRAM_BOT_TOKEN`
- `OPENAI_API_KEY`
- `SLETAT_LOGIN`
- `SLETAT_PASSWORD`
- `SLETAT_SEARCH_BASE_URL`
- `SLETAT_CLAIMS_BASE_URL`
- `DATABASE_URL`
- `REDIS_URL`

3) Режим интеграции Sletat:
- `SLETAT_MODE=api` — реальный API-клиент,
- `SLETAT_MODE=mock` — заглушка.

4) Формат шлюзов:
- `SLETAT_PROTOCOL=json|xml` — для поискового контура,
- `SLETAT_CLAIMS_PROTOCOL=json|xml` — для заявок/платежей.

5) Endpoint'ы методов Sletat (можно переопределять под вашу документацию):
- `SLETAT_ENDPOINT_DEPARTURE_CITIES`
- `SLETAT_ENDPOINT_COUNTRIES`
- `SLETAT_ENDPOINT_MEALS`
- `SLETAT_ENDPOINT_HOTELS`
- `SLETAT_ENDPOINT_SEARCH`
- `SLETAT_ENDPOINT_ACTUALIZE`
- `SLETAT_ENDPOINT_CLAIM_CREATE`
- `SLETAT_ENDPOINT_CLAIM_INFO`
- `SLETAT_ENDPOINT_PAYMENTS`

---

## 4. Запуск через Docker Compose (рекомендуется)

```bash
docker-compose up --build
```

Что поднимется:
- `postgres` на `5432`,
- `redis` на `6379`,
- `api` на `${PORT}` (по умолчанию `3000`).

Проверка health:

```bash
curl http://localhost:3000/health
```

---

## 5. Локальный запуск (без Docker)

1) Установите зависимости:

```bash
npm install
```

2) Сгенерируйте Prisma client:

```bash
npx prisma generate
```

3) Примените миграции:

```bash
npx prisma migrate dev --name init
```

4) Запустите бота:

```bash
npm run start:dev
```

---

## 6. Проверка после запуска

1) Найдите бота в Telegram и отправьте `/start`.
2) Отправьте текстовый запрос: 
   `Турция, 2 взрослых, 7 ночей, бюджет 150000`.
3) Проверьте, что бот возвращает результаты и кнопки:
   - «Следить за ценой»
   - «Бронировать лучший вариант».
4) Проверьте `/subscriptions`.

---

## 7. Частые проблемы

### 7.1 Ошибка валидации конфига на старте
Проверьте заполненность обязательных env-переменных. Валидация выполняется через Joi в `config.validation.ts`.

### 7.2 Бот не отвечает в Telegram
- неверный `TELEGRAM_BOT_TOKEN`,
- ограничение сети,
- процесс не запущен.

### 7.3 Проблемы с OpenAI voice
Проверьте `OPENAI_API_KEY` и `OPENAI_TRANSCRIPTION_MODEL`.

### 7.4 Проблемы с Sletat
- проверьте `SLETAT_MODE` (`api` vs `mock`),
- проверьте base URL и endpoint'ы,
- проверьте логин/пароль.

---

## 8. Рекомендованный порядок запуска в проде

1) Настроить Postgres и Redis.
2) Заполнить `.env` с реальными секретами.
3) Включить `SLETAT_MODE=api`.
4) Проверить health endpoint.
5) Проверить `/start`, текстовый поиск, голосовой поиск, подписки, бронирование.
6) Настроить внешний мониторинг и сбор логов.
