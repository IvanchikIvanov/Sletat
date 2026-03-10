import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';

/** Результат веб-поиска — список стран без визы для россиян */
const VISA_FREE_COUNTRIES_RU = [
  'Турция',
  'Египет',
  'Таиланд',
  'ОАЭ',
  'Тунис',
  'Марокко',
  'Индонезия',
  'Шри-Ланка',
  'Мальдивы',
  'Вьетнам',
  'Куба',
  'Доминикана',
  'Мексика',
  'Черногория',
  'Сербия',
  'Босния и Герцеговина',
  'Белоруссия',
  'Казахстан',
  'Армения',
  'Грузия',
  'Азербайджан',
  'Узбекистан',
  'Киргизия',
  'Таджикистан',
  'Абхазия',
  'Южная Осетия',
  'Израиль',
  'Малайзия',
  'Филиппины',
  'Сейшелы',
  'Маврикий',
  'Танзания',
  'Кения',
  'ЮАР',
  'Аргентина',
  'Бразилия',
  'Чили',
  'Колумбия',
  'Перу',
  'Эквадор',
  'Коста-Рика',
  'Панама',
  'Никарагуа',
  'Сальвадор',
  'Гватемала',
  'Гондурас',
  'Белиз',
  'Ямайка',
  'Багамы',
  'Барбадос',
  'Тринидад и Тобаго',
  'Сент-Люсия',
  'Антигуа и Барбуда',
  'Гренада',
  'Доминика',
  'Сент-Винсент и Гренадины',
  'Сент-Китс и Невис',
];

@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);
  private readonly serpApiKey?: string;

  constructor(private readonly config: AppConfigService) {
    this.serpApiKey = this.config.getOptional<string>('SERPAPI_KEY');
  }

  /**
   * Получить список стран без визы для вылета из РФ (или указанного города).
   * Использует SerpAPI при наличии ключа, иначе — статический список.
   */
  async getVisaFreeCountries(departureCity?: string): Promise<string[]> {
    if (this.serpApiKey) {
      try {
        const countries = await this.searchVisaFreeViaSerp(departureCity ?? 'Россия');
        if (countries.length > 0) return countries;
      } catch (err) {
        this.logger.warn('SerpAPI search failed, using static list', err);
      }
    }

    return [...VISA_FREE_COUNTRIES_RU];
  }

  private async searchVisaFreeViaSerp(departureFrom: string): Promise<string[]> {
    const query = `страны без визы для россиян из ${departureFrom} 2024`;
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${this.serpApiKey}&hl=ru&gl=ru`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`SerpAPI ${res.status}`);

    const data = (await res.json()) as {
      organic_results?: Array<{ title?: string; snippet?: string }>;
      answer_box?: { answer?: string };
    };

    const textParts: string[] = [];
    if (data.answer_box?.answer) textParts.push(data.answer_box.answer);
    for (const r of data.organic_results ?? []) {
      if (r.title) textParts.push(r.title);
      if (r.snippet) textParts.push(r.snippet);
    }

    const fullText = textParts.join(' ');
    const countries = this.extractCountryNames(fullText);
    return countries.length > 0 ? countries : [...VISA_FREE_COUNTRIES_RU];
  }

  private extractCountryNames(text: string): string[] {
    const found = new Set<string>();
    const lower = text.toLowerCase();

    for (const country of VISA_FREE_COUNTRIES_RU) {
      if (lower.includes(country.toLowerCase())) {
        found.add(country);
      }
    }

    return [...found];
  }
}
