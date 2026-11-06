import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { defer, finalize, type Observable } from 'rxjs';

/** Keep a slot until the response drains, including for slow download clients. */
@Injectable()
export class DocumentDownloadInterceptor implements NestInterceptor {
  private active=0;
  intercept(context:ExecutionContext,next:CallHandler):Observable<unknown> {
    const response=context.switchToHttp().getResponse<Response>();
    if(this.active>=8) {
      response.setHeader('Retry-After','5');
      throw new ServiceUnavailableException('The document service is busy. Please retry in a few seconds.');
    }
    this.active++;
    let released=false,handled=false,drained=false;
    const release=()=>{
      if(released || !handled || !drained) return;
      released=true;
      this.active--;
      clearTimeout(timer);
      response.off('finish',drain);
      response.off('close',drain);
    };
    const drain=()=>{drained=true;release();};
    const timer=setTimeout(()=>response.destroy(),120000);
    timer.unref();
    response.once('finish',drain);
    response.once('close',drain);
    return defer(()=>next.handle()).pipe(finalize(()=>{handled=true;release();}));
  }
}
