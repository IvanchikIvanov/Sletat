import * as Joi from 'joi';

export function validateEnv(config: Record<string, unknown>) {
  const schema = Joi.object({
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
    PORT: Joi.number().port().default(3000),
    PUBLIC_BASE_URL: Joi.string().uri().required(),

    TELEGRAM_BOT_TOKEN: Joi.string().required(),
    TELEGRAM_USE_POLLING: Joi.string().valid('true', 'false').default('true'),

    OPENAI_API_KEY: Joi.string().required(),
    OPENAI_MODEL: Joi.string().default('gpt-4.1-mini'),
    OPENAI_TRANSCRIPTION_MODEL: Joi.string().default('gpt-4o-mini-transcribe'),

    SLETAT_LOGIN: Joi.string().required(),
    SLETAT_PASSWORD: Joi.string().required(),
    SLETAT_SEARCH_BASE_URL: Joi.string().uri().required(),
    SLETAT_CLAIMS_BASE_URL: Joi.string().uri().required(),

    DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),
    REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),

    MONITORING_INTERVAL_MS: Joi.number().integer().min(60000).default(900000),
  });

  const { error, value } = schema.validate(config, {
    abortEarly: false,
    allowUnknown: true,
    stripUnknown: false,
  });

  if (error) {
    throw new Error(`Config validation error: ${error.message}`);
  }

  return value;
}

