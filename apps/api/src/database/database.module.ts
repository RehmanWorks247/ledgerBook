import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DatabaseService } from './database.service';
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(database?:DatabaseService):DynamicModule {
    return {module:DatabaseModule,global:true,providers:[database ? {provide:DatabaseService,useValue:database} : DatabaseService],exports:[DatabaseService]};
  }
}
