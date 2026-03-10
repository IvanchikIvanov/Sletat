import { Module } from '@nestjs/common';
import { DialogContextService } from './dialog-context.service';

@Module({
  providers: [DialogContextService],
  exports: [DialogContextService],
})
export class DialogModule {}
