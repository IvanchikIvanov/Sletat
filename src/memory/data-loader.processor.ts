import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SletatService } from '../sletat/sletat.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { AppConfigService } from '../config/config.service';
import { SletatDictionaryItem } from '../sletat/sletat.types';

const CITIZENSHIP_COUNTRIES = [
  'Россия',
  'Казахстан',
  'Беларусь',
  'Украина',
  'Узбекистан',
  'Киргизия',
  'Армения',
  'Грузия',
  'Азербайджан',
  'Молдова',
];

@Processor('data-loader')
export class DataLoaderProcessor {
  private readonly logger = new Logger(DataLoaderProcessor.name);
  private readonly openai: OpenAI;

  constructor(
    private readonly sletat: SletatService,
    private readonly knowledge: KnowledgeService,
    private readonly config: AppConfigService,
  ) {
    const agent = this.config.openAi.proxyUrl
      ? new HttpsProxyAgent(this.config.openAi.proxyUrl)
      : undefined;

    this.openai = new OpenAI({
      apiKey: this.config.openAi.apiKey,
      ...(agent && { httpAgent: agent, httpsAgent: agent }),
    });
  }

  @Process('load-sletat-dictionaries')
  async handleLoadDictionaries(job: Job) {
    this.logger.log('Loading Sletat dictionaries into knowledge base...');

    try {
      const countries = await this.sletat.getCountries();
      const departureCities = await this.sletat.getDepartureCities();

      for (const country of countries) {
        const text = `Туристическое направление: ${country.name} (код Sletat: ${country.code}, id: ${country.id})`;
        await this.knowledge.saveKnowledgeExtended({
          text,
          category: 'countries',
          subcategory: 'general',
          source: 'sletat',
          metadata: { sletatId: country.id, code: country.code, name: country.name },
          expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        });
      }

      const citiesText = `Города вылета Sletat: ${departureCities.map((c) => c.name).join(', ')}`;
      await this.knowledge.saveKnowledgeExtended({
        text: citiesText,
        category: 'practical',
        subcategory: 'departure_cities',
        source: 'sletat',
        metadata: { cities: departureCities.map((c) => ({ id: c.id, name: c.name })) },
        expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      });

      this.logger.log(`Loaded ${countries.length} countries and ${departureCities.length} departure cities`);
    } catch (error) {
      this.logger.error('Failed to load Sletat dictionaries', error);
    }
  }

  @Process('load-visa-free')
  async handleLoadVisaFree(job: Job) {
    this.logger.log('Loading visa-free country lists...');

    let sletatCountries: SletatDictionaryItem[] = [];
    try {
      sletatCountries = await this.sletat.getCountries();
    } catch {
      this.logger.warn('Could not load Sletat countries for cross-reference');
    }

    const sletatNames = new Set(sletatCountries.map((c) => c.name.toLowerCase()));

    for (const citizenship of CITIZENSHIP_COUNTRIES) {
      try {
        const visaFreeList = await this.askVisaFreeCountries(citizenship);
        if (!visaFreeList.length) continue;

        const availableInSletat = sletatNames.size > 0
          ? visaFreeList.filter((c) => sletatNames.has(c.toLowerCase()))
          : visaFreeList;

        const text = `Безвизовые страны для граждан ${citizenship}: ${visaFreeList.join(', ')}`;
        await this.knowledge.saveKnowledgeExtended({
          text,
          category: 'countries',
          subcategory: 'visa_free',
          source: 'openai',
          metadata: {
            citizenship,
            countries: visaFreeList,
            availableInSletat,
          },
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        });

        this.logger.log(`Saved visa-free list for ${citizenship}: ${visaFreeList.length} countries`);
      } catch (error) {
        this.logger.error(`Failed to load visa-free for ${citizenship}`, error);
      }
    }
  }

  @Process('enrich-countries')
  async handleEnrichCountries(job: Job) {
    this.logger.log('Enriching country information...');

    try {
      const countries = await this.sletat.getCountries();
      const batch = countries.slice(0, 30);

      for (const country of batch) {
        try {
          const info = await this.askCountryInfo(country.name);
          if (!info) continue;

          await this.knowledge.saveKnowledgeExtended({
            text: info,
            category: 'countries',
            subcategory: 'climate',
            source: 'openai',
            metadata: { countryName: country.name, sletatId: country.id },
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          });
        } catch (error) {
          this.logger.warn(`Failed to enrich country ${country.name}`, error);
        }
      }

      this.logger.log(`Enriched ${batch.length} countries`);
    } catch (error) {
      this.logger.error('Failed to enrich countries', error);
    }
  }

  @Process('cleanup-expired')
  async handleCleanup(job: Job) {
    this.logger.log('Cleaning up expired knowledge entries...');
    await this.knowledge.cleanupExpired();
  }

  private async askVisaFreeCountries(citizenship: string): Promise<string[]> {
    const completion = await this.openai.chat.completions.create({
      model: this.config.openAi.model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Ты эксперт по визовым требованиям. Верни JSON: {"countries": ["страна1", "страна2", ...]}',
        },
        {
          role: 'user',
          content: `Перечисли все популярные туристические страны, куда граждане ${citizenship} могут въехать без визы или с визой по прибытию (e-visa тоже считается). Только названия стран на русском языке.`,
        },
      ],
      temperature: 0.2,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content);
    return Array.isArray(parsed.countries) ? parsed.countries : [];
  }

  private async askCountryInfo(countryName: string): Promise<string | null> {
    const completion = await this.openai.chat.completions.create({
      model: this.config.openAi.model,
      messages: [
        {
          role: 'system',
          content: 'Ты эксперт по туризму. Дай краткую справку (2-3 предложения) для туристического бота.',
        },
        {
          role: 'user',
          content: `Расскажи кратко о ${countryName} для туриста: лучший сезон, климат, валюта, нужна ли виза для россиян, особенности.`,
        },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    return completion.choices[0]?.message?.content ?? null;
  }
}
