import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { UserPreferencesService } from './user-preferences.service';

@Module({
  imports: [ConfigModule],
  providers: [UserPreferencesService],
  exports: [UserPreferencesService],
})
export class PreferencesModule {}
