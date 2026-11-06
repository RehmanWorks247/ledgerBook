import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config';

export type EmailMessage = { to: string; subject: string; text: string };

/** The sole email-provider boundary. Credentials and message bodies never enter logs. */
@Injectable()
export class NotificationsService {
  constructor(@Optional() @Inject('EMAIL_API_URL') private readonly apiUrl = 'https://api.resend.com/emails') {
    // Test-only endpoint injection cannot redirect production mail or secrets.
    if (apiUrl !== 'https://api.resend.com/emails' && (config.production || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(apiUrl))) {
      throw new Error('Email API overrides are restricted to local testing.');
    }
  }

  async send(message: EmailMessage, options: {idempotencyKey?:string} = {}): Promise<void> {
    const mode = config.emailMode;
    if (mode === 'file') {
      if (config.production) throw new Error('File email is disabled in production.');
      const directory = config.mailDirectory;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = options.idempotencyKey
        ? `payment-${createHash('sha256').update(options.idempotencyKey).digest('hex')}`
        : `${Date.now()}-${randomUUID()}`;
      const temporary = resolve(directory,`.pending-${randomUUID()}`);
      try {
        await writeFile(temporary,
          `To: ${message.to.replace(/[\r\n]/g,' ')}\nSubject: ${message.subject.replace(/[\r\n]/g,' ')}\nContent-Type: text/plain; charset=utf-8\n\n${message.text}`, { mode: 0o600, flag: 'wx' });
        // Publish complete bytes atomically. A crash while writing the temporary
        // file cannot leave a partial idempotency marker that suppresses a retry.
        await link(temporary,resolve(directory, `${filename}.eml`))
          .catch(error => { if (!options.idempotencyKey || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      } finally { await unlink(temporary).catch(() => undefined); }
      return;
    }
    if (mode !== 'resend' || !config.resendApiKey) throw new Error('Email configuration is invalid.');
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json',
        ...(options.idempotencyKey ? {'Idempotency-Key':options.idempotencyKey} : {}) },
      body: JSON.stringify({ from: config.emailFrom, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    // Provider error bodies can echo sensitive message content; never log them.
    await response.body?.cancel();
    if (!response.ok) throw new Error('Email delivery was not accepted.');
  }
}
