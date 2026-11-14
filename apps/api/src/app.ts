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
import { UsersController } from './users/users.controller';
import { AccountDeletionService } from './users/account-deletion.service';
import { UsersService } from './users/users.service';
import { config } from './config';
import { CurrencyController } from './currency/currency.controller';
import { CurrencyService } from './currency/currency.service';
import { RatesService } from './currency/rates.service';
import { BookingManagementService } from './bookings/booking-management.service';
import { BookingManagementController } from './bookings/booking-management.controller';
import { DocumentVersionsService } from './bookings/document-versions.service';
import { DocumentVersionsController } from './bookings/document-versions.controller';
import { ReminderService } from './notifications/reminder.service';
import { NotificationSettingsController, ReminderPreferencesController } from './notifications/notification-settings.controller';
import { EmailDeliveryService, ResendWebhookController, resendWebhookVerifier, type VerifiedWebhookRequest } from './notifications/email-delivery.service';
import { BookingsController } from './bookings/bookings.controller';
import { BookingsService } from './bookings/bookings.service';
import { DocumentStorage } from './bookings/document-storage';
import { DocumentCleanupWorker } from './bookings/document-cleanup.worker';
import { DocumentUploadInterceptor } from './bookings/document-upload.interceptor';
import { DocumentDownloadInterceptor } from './bookings/document-download.interceptor';
import { DocumentPreviewService } from './bookings/document-preview';
import { DocumentPreviewController } from './bookings/document-preview.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { PaymentsService } from './payments/payments.service';
import { PaymentsController, PaymentReviewController, PaymentUploadGuard } from './payments/payments.controller';
import { PaymentEmailOutbox } from './payments/email-outbox.service';
import { PaymentEmailStatusController } from './payments/email-status.controller';
import { OrganizationsController } from './organizations/organizations.controller';
import { OrganizationsService } from './organizations/organizations.service';
import { InvoicesService } from './invoices/invoices.service';
import { CustomerInvoicesController, InvoicesController } from './invoices/invoices.controller';
import { CompaniesController } from './companies/companies.controller';
import { CompaniesService } from './companies/companies.service';

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

export async function createApp(options:{database?:DatabaseService;documentStorage?:DocumentStorage;logger?:false;paymentEmails?:boolean;reminderEmails?:boolean}={}) {
  @Module({imports:[DatabaseModule.forRoot(options.database),AuthModule,InvitationsModule],
    controllers:[HealthController,OrganizationsController,CompaniesController,CustomersController,UsersController,CurrencyController,BookingsController,BookingManagementController,InvoicesController,CustomerInvoicesController,DocumentVersionsController,DocumentPreviewController,ResendWebhookController,NotificationSettingsController,ReminderPreferencesController,PaymentsController,PaymentReviewController,PaymentEmailStatusController],
    providers:[AccessService,OrganizationsService,CompaniesService,LedgerService,CustomersService,UsersService,AccountDeletionService,CurrencyService,RatesService,BookingsService,BookingManagementService,DocumentVersionsService,EmailDeliveryService,ReminderService,
      options.documentStorage ? {provide:DocumentStorage,useValue:options.documentStorage} : DocumentStorage,DocumentCleanupWorker,DocumentUploadInterceptor,DocumentDownloadInterceptor,DocumentPreviewService,DashboardService,
      InvoicesService,PaymentsService,PaymentUploadGuard,PaymentEmailOutbox,{provide:'PAYMENT_EMAIL_WORKER_ENABLED',useValue:options.paymentEmails ?? true},{provide:'REMINDER_WORKER_ENABLED',useValue:options.reminderEmails ?? options.paymentEmails ?? true}]})
  class ApplicationModule {}
  const app=await NestFactory.create<NestExpressApplication>(ApplicationModule,{
    logger:options.logger===false?false:['error','warn','log'],bodyParser:false,abortOnError:false,
  });
  app.setGlobalPrefix('api');
  app.set('trust proxy',config.trustProxyHops || false);
  app.disable('x-powered-by');
  const clerkOrigins = config.authProvider === 'clerk'
    ? [...(config.clerkFrontendOrigin ? [config.clerkFrontendOrigin] : []), 'https://*.clerk.accounts.dev', 'https://*.clerk.com']
    : [];
  const challengeOrigins = config.authProvider === 'clerk' ? ['https://challenges.cloudflare.com'] : [];
  app.use(helmet({
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: config.production ? { maxAge: 31536000, includeSubDomains: true } : false,
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...clerkOrigins, ...challengeOrigins],
      connectSrc: ["'self'", ...clerkOrigins, ...challengeOrigins,
        ...(app.get(DocumentStorage).uploadOrigin ? [app.get(DocumentStorage).uploadOrigin!] : []),
        ...(config.authProvider === 'clerk' ? ['https://clerk-telemetry.com','https://*.clerk-telemetry.com'] : [])],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://img.clerk.com'],
      mediaSrc: ["'self'", 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      frameSrc: config.authProvider === 'clerk' ? [...clerkOrigins, ...challengeOrigins] : ["'none'"],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"], baseUri: ["'self'"],
      upgradeInsecureRequests: config.production ? [] : null,
    } },
  }));
  app.use('/api/webhooks/resend',express.raw({type:'application/json',limit:'64kb',inflate:false}),resendWebhookVerifier());
  app.use((req:Request,res:Response,next:NextFunction)=>{
    if(req.path.startsWith('/api')) {
      res.setHeader('Cache-Control','no-store');
      if(!['GET','HEAD','OPTIONS'].includes(req.method) && !(req as VerifiedWebhookRequest).verifiedResendWebhook) {
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
