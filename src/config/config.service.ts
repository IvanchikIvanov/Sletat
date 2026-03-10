import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  transcriptionModel: string;
  proxyUrl?: string;
}

export interface SletatConfig {
  login: string;
  password: string;
  searchBaseUrl: string;
  claimsBaseUrl: string;
  mode: 'mock' | 'api';
  protocol: 'json' | 'xml';
  claimsProtocol: 'json' | 'xml';
}

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get port(): number {
    return this.configService.get<number>('PORT', 3000);
  }

  get publicBaseUrl(): string {
    return this.configService.get<string>('PUBLIC_BASE_URL', '');
  }

  get telegramToken(): string {
    return this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
  }

  get telegramUsePolling(): boolean {
    return this.configService.get<string>('TELEGRAM_USE_POLLING', 'true') === 'true';
  }

  get openAi(): OpenAiConfig {
    return {
      apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY'),
      model: this.configService.get<string>('OPENAI_MODEL', 'gpt-4.1-mini'),
      transcriptionModel: this.configService.get<string>(
        'OPENAI_TRANSCRIPTION_MODEL',
        'gpt-4o-mini-transcribe',
      ),
      proxyUrl: this.configService.get<string>('OPENAI_PROXY_URL') || undefined,
    };
  }

  get sletat(): SletatConfig {
    return {
      login: this.configService.getOrThrow<string>('SLETAT_LOGIN'),
      password: this.configService.getOrThrow<string>('SLETAT_PASSWORD'),
      searchBaseUrl: this.configService.getOrThrow<string>('SLETAT_SEARCH_BASE_URL'),
      claimsBaseUrl: this.configService.getOrThrow<string>('SLETAT_CLAIMS_BASE_URL'),
      mode: this.configService.get<'mock' | 'api'>('SLETAT_MODE', 'api'),
      protocol: this.configService.get<'json' | 'xml'>('SLETAT_PROTOCOL', 'json'),
      claimsProtocol: this.configService.get<'json' | 'xml'>('SLETAT_CLAIMS_PROTOCOL', 'xml'),
    };
  }

  getString(key: string): string {
    return this.configService.getOrThrow<string>(key);
  }

  get databaseUrl(): string {
    return this.configService.getOrThrow<string>('DATABASE_URL');
  }

  get redisUrl(): string {
    return this.configService.getOrThrow<string>('REDIS_URL');
  }

  get embeddingModel(): string {
    return this.configService.get<string>(
      'OPENAI_EMBEDDING_MODEL',
      'text-embedding-3-small',
    );
  }

  get monitoringIntervalMs(): number {
    return Number(this.configService.get<string>('MONITORING_INTERVAL_MS', '900000'));
  }
}

