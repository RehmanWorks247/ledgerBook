import 'reflect-metadata';
import { ArgumentsHost, Catch, Controller, Get, HttpException, Inject, Module, type ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AuthModule } from './auth/auth.module';
import { InvitationsModule } from './invitations/invitations.module';
import { AccessService } from './access/access.service';
import { LedgerService } from './ledger/ledger.service';
import { CustomersService } from './customers/customers.service';
import { CustomersController } from './customers/customers.controller';
import { DatabaseModule } from './database/database.module';
import { DatabaseService } from './database/database.service';
import { config } from './config';
import { CurrencyController } from './currency/currency.controller';
import { CurrencyService } from './currency/currency.service';
import { RatesService } from './currency/rates.service';
import { BookingsController } from './bookings/bookings.controller';
import { BookingsService } from './bookings/bookings.service';
import { DocumentStorage } from './bookings/document-storage';
import { DocumentUploadInterceptor } from './bookings/document-upload.interceptor';
import { DocumentDownloadInterceptor } from './bookings/document-download.interceptor';
import { DashboardService } from './dashboard/dashboard.service';
import { PaymentsService } from './payments/payments.service';
import { PaymentsController, PaymentReviewController, PaymentUploadGuard } from './payments/payments.controller';
import { PaymentEmailOutbox } from './payments/email-outbox.service';
import { PaymentEmailStatusController } from './payments/email-status.controller';

@Controller()
class HealthController {
  constructor(@Inject(DatabaseService) private readonly db:DatabaseService) {}
  @Get('health') health() { return {status:'ok'}; }
  @Get('ready') async ready() { await this.db.query('SELECT 1'); return {status:'ready'}; }
}
@Catch()
class SafeExceptionFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost) {
    const response=host.switchToHttp().getResponse<Response>();
    if(error instanceof HttpException) {
      const status=error.getStatus();
      if(status===429) response.setHeader('Retry-After','60');
      const payload=error.getResponse();
      response.status(status).json(typeof payload==='string'?{statusCode:status,message:payload}:payload);
      return;
    }
    const code=(error as {code?:string})?.code;
    if(code==='23505') { response.status(409).json({statusCode:409,message:'This record conflicts with an existing record. Refresh and try again.'}); return; }
    if(code==='23514'||code==='23503'||code==='22P02') {
      response.status(400).json({statusCode:400,message:'This operation violates an account or ledger constraint.'});return;
    }
    const requestId=randomUUID();
    // Deliberately exclude request data, SQL parameters, provider responses and error text.
    console.error(JSON.stringify({event:'request_failed',requestId}));
    response.status(500).json({statusCode:500,message:'The request could not be completed. Please try again.',requestId});
  }
}

export async function createApp(options:{database?:DatabaseService;logger?:false;paymentEmails?:boolean}={}) {
  @Module({imports:[DatabaseModule.forRoot(options.database),AuthModule,InvitationsModule],
    controllers:[HealthController,CustomersController,CurrencyController,BookingsController,PaymentsController,PaymentReviewController,PaymentEmailStatusController],
    providers:[AccessService,LedgerService,CustomersService,CurrencyService,RatesService,BookingsService,DocumentStorage,DocumentUploadInterceptor,DocumentDownloadInterceptor,DashboardService,
      PaymentsService,PaymentUploadGuard,PaymentEmailOutbox,{provide:'PAYMENT_EMAIL_WORKER_ENABLED',useValue:options.paymentEmails ?? true}]})
  class ApplicationModule {}
  const app=await NestFactory.create<NestExpressApplication>(ApplicationModule,{
    logger:options.logger===false?false:['error','warn','log'],bodyParser:false,abortOnError:false,
  });
  app.setGlobalPrefix('api');
  app.set('trust proxy',config.trustProxyHops || false);
  app.disable('x-powered-by');
  app.use(helmet({
    referrerPolicy:{policy:'no-referrer'},
    strictTransportSecurity:config.production?{maxAge:31536000,includeSubDomains:true}:false,
    contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],imgSrc:["'self'",'data:','blob:'],objectSrc:["'none'"],frameAncestors:["'none'"],formAction:["'self'"],baseUri:["'self'"],upgradeInsecureRequests:config.production?[]:null}},
  }));
  app.use((req:Request,res:Response,next:NextFunction)=>{
    if(req.path.startsWith('/api')) {
      res.setHeader('Cache-Control','no-store');
      if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
        if(req.headers.origin!==config.appUrl || req.headers['x-csrf-protection']!=='1') {
          res.status(403).json({statusCode:403,message:'Request origin verification failed. Refresh the application and try again.'});return;
        }
      }
    }
    next();
  });
  app.use(express.json({limit:'16kb'}));
  app.use((err:unknown,_req:Request,res:Response,next:NextFunction)=>{
    if(err) {
      const pdf = _req.is('application/pdf');
      res.status((err as {type?:string}).type==='entity.too.large'?413:400).json({message:pdf ? 'PDF uploads must be at most 10 MB.' : 'Request body must be valid JSON and at most 16 KB.'});return;
    }
    next();
  });
  app.useGlobalFilters(new SafeExceptionFilter());
  const web=resolve('apps/web/dist');
  if(existsSync(resolve(web,'index.html'))) {
    app.use(express.static(web,{index:false,maxAge:config.production?'1h':0}));
    app.use((req:Request,res:Response,next:NextFunction)=>{
      if(req.method==='GET' && req.path!=='/api' && !req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control','no-cache');res.sendFile(resolve(web,'index.html'));
      } else next();
    });
  }
  await app.init();
  return app;
}
