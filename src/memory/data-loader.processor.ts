import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SletatService } from '../sletat/sletat.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { AppConfigService } from '../config/config.service';
import { CacheRepository } from '../persistence/repositories/cache.repository';
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

const POPULAR_DEPARTURE_IDS = [832, 1264, 1265, 2671, 1580];
const POPULAR_COUNTRY_IDS = [90, 29, 30, 115, 134, 15, 35, 43, 95, 10, 62, 36, 96];

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

@Processor('data-loader')
export class DataLoaderProcessor {
  private readonly logger = new Logger(DataLoaderProcessor.name);
  private readonly openai: OpenAI;

  constructor(
    private readonly sletat: SletatService,
    private readonly knowledge: KnowledgeService,
    private readonly config: AppConfigService,
    private readonly cache: CacheRepository,
  ) {
    const agent = this.config.openAi.proxyUrl
      ? new HttpsProxyAgent(this.config.openAi.proxyUrl)
      : undefined;

    this.openai = new OpenAI({
      apiKey: this.config.openAi.apiKey,
      ...(agent && { httpAgent: agent, httpsAgent: agent }),
    });
  }

  // ─── Загрузка всех справочников в PostgreSQL ───

  @Process('load-sletat-dictionaries')
  async handleLoadDictionaries(_job: Job) {
    this.logger.log('Loading Sletat dictionaries into DB cache...');

    try {
      const departureCities = await this.sletat.getDepartureCities();
      let depCount = 0;
      for (const city of departureCities) {
        await this.cache.upsertDepartureCity({
          id: city.id,
          name: city.name,
          isPopular: POPULAR_DEPARTURE_IDS.includes(Number(city.id)),
        });
        depCount++;
      }

      const meals = await this.sletat.getMeals();
      let mealCount = 0;
      for (const meal of meals) {
        await this.cache.upsertMeal({ id: meal.id, name: meal.name });
        mealCount++;
      }

      let countryCount = 0;
      for (const depId of POPULAR_DEPARTURE_IDS) {
        try {
          const countries = await this.sletat.getCountriesForCity(depId);
          for (const country of countries) {
            await this.cache.upsertCountry({
              id: country.id,
              name: country.name,
              alias: country.code,
              townFromId: depId,
            });
            countryCount++;
          }
        } catch (err) {
          this.logger.warn(`Failed to load countries for dep ${depId}: ${(err as Error).message}`);
        }
      }

      this.logger.log(`DB cache: ${depCount} departures, ${mealCount} meals, ${countryCount} countries`);

      const citiesText = `Города вылета Sletat: ${departureCities.map((c) => c.name).join(', ')}`;
      await this.knowledge.saveKnowledgeExtended({
        text: citiesText,
        category: 'practical',
        subcategory: 'departure_cities',
        source: 'sletat',
        metadata: { cities: departureCities.map((c) => ({ id: c.id, name: c.name })) },
        expiresAt: new Date(Date.now() + 2 * ONE_DAY),
      });
    } catch (error) {
      this.logger.error('Failed to load Sletat dictionaries', error);
    }
  }

  // ─── Загрузка курортов (городов) и отелей по популярным странам ───

  @Process('load-resorts-hotels')
  async handleLoadResortsHotels(_job: Job) {
    this.logger.log('Loading resorts and hotels for popular countries...');

    for (const countryId of POPULAR_COUNTRY_IDS) {
      try {
        const isStale = await this.cache.isStale('resort', ONE_DAY, String(countryId));
        if (!isStale) {
          this.logger.debug(`Resorts for country ${countryId} are fresh, skipping`);
          continue;
        }

        const resorts = await this.sletat.getCities(countryId);
        let resortCount = 0;
        for (const resort of resorts) {
          await this.cache.upsertResort({
            id: resort.id,
            name: resort.name,
            countryId: String(countryId),
          });
          resortCount++;
        }

        const hotels = await this.sletat.getHotels(countryId);
        let hotelCount = 0;
        for (const hotel of hotels) {
          await this.cache.upsertHotel({
            id: hotel.id,
            name: hotel.name,
            countryId: String(countryId),
            resortId: hotel.townId,
            starId: hotel.starId,
            starName: hotel.starName,
            rating: hotel.rating,
            photosCount: hotel.photosCount,
          });
          hotelCount++;
        }

        this.logger.log(`Country ${countryId}: ${resortCount} resorts, ${hotelCount} hotels`);
      } catch (err) {
        this.logger.warn(`Failed to load resorts/hotels for country ${countryId}: ${(err as Error).message}`);
      }
    }
  }

  // ─── Горящие туры в PostgreSQL ───

  @Process('load-showcase-review')
  async handleLoadShowcaseReview(_job: Job) {
    this.logger.log('Loading showcase review (hot tours) into DB...');

    try {
      for (const depId of POPULAR_DEPARTURE_IDS) {
        try {
          const isStale = await this.cache.isStale('hotDeal', ONE_HOUR, String(depId));
          if (!isStale) {
            this.logger.debug(`Hot deals for dep ${depId} are fresh, skipping`);
            continue;
          }

          const showcase = await this.sletat.getShowcaseReview(depId, 'RUB');
          if (!showcase.length) continue;

          const deals = showcase.map((s) => ({
            countryId: s.countryId,
            countryName: s.countryName,
            hotelName: s.hotelName ?? null,
            starName: s.starName ?? null,
            resortName: s.resortName ?? null,
            mealName: s.mealName ?? null,
            minPrice: this.parsePrice(s.minPrice),
            currency: 'RUB',
            minPriceDate: s.minPriceDate ?? null,
            nights: s.nights ?? null,
            offerId: s.offerId ?? null,
            townFromId: depId,
          }));

          const count = await this.cache.replaceHotDeals(depId, deals);
          this.logger.log(`Saved ${count} hot deals for dep ${depId}`);
        } catch (err) {
          this.logger.warn(`Failed to load showcase for dep ${depId}: ${(err as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.error('Failed to load showcase review', error);
    }
  }

  @Process('load-visa-free')
  async handleLoadVisaFree(_job: Job) {
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
          metadata: { citizenship, countries: visaFreeList, availableInSletat },
          expiresAt: new Date(Date.now() + 14 * ONE_DAY),
        });

        this.logger.log(`Saved visa-free list for ${citizenship}: ${visaFreeList.length} countries`);
      } catch (error) {
        this.logger.error(`Failed to load visa-free for ${citizenship}`, error);
      }
    }
  }

  @Process('enrich-countries')
  async handleEnrichCountries(_job: Job) {
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
            expiresAt: new Date(Date.now() + 30 * ONE_DAY),
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
  async handleCleanup(_job: Job) {
    this.logger.log('Cleaning up expired knowledge entries...');
    await this.knowledge.cleanupExpired();
  }

  @Process('load-seasonal-recommendations')
  async handleLoadSeasonalRecommendations(_job: Job) {
    this.logger.log('Loading seasonal recommendations...');

    try {
      const now = new Date();
      const monthNames = [
        'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
        'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
      ];
      const currentMonth = monthNames[now.getMonth()];
      const nextMonth = monthNames[(now.getMonth() + 1) % 12];

      const recommendations = await this.askSeasonalRecommendations(currentMonth, nextMonth);
      if (!recommendations) return;

      await this.knowledge.saveKnowledgeExtended({
        text: recommendations,
        category: 'seasonal',
        subcategory: currentMonth,
        source: 'openai',
        metadata: { month: currentMonth, nextMonth, generatedAt: now.toISOString() },
        expiresAt: new Date(Date.now() + 14 * ONE_DAY),
      });

      this.logger.log(`Saved seasonal recommendations for ${currentMonth}`);
    } catch (error) {
      this.logger.error('Failed to load seasonal recommendations', error);
    }
  }

  private parsePrice(raw: string): number {
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? Number(digits) : 0;
  }

  private async askSeasonalRecommendations(currentMonth: string, nextMonth: string): Promise<string | null> {
    const completion = await this.openai.chat.completions.create({
      model: this.config.openAi.model,
      messages: [
        { role: 'system', content: 'Ты эксперт по туризму. Дай рекомендации для туристического бота.' },
        {
          role: 'user',
          content: `Какие направления для пляжного отдыха лучше всего подходят для россиян в ${currentMonth} и ${nextMonth}? ` +
            'Перечисли 10-15 стран с кратким пояснением (погода, температура воды, особенности). Формат: "Страна — описание".',
        },
      ],
      temperature: 0.3,
      max_tokens: 800,
    });
    return completion.choices[0]?.message?.content ?? null;
  }

  private async askVisaFreeCountries(citizenship: string): Promise<string[]> {
    const completion = await this.openai.chat.completions.create({
      model: this.config.openAi.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Ты эксперт по визовым требованиям. Верни JSON: {"countries": ["страна1", "страна2", ...]}' },
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
        { role: 'system', content: 'Ты эксперт по туризму. Дай краткую справку (2-3 предложения) для туристического бота.' },
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
