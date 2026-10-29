import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config';

export type EmailMessage = { to: string; subject: string; text: string };

/** The sole email-provider boundary. Credentials and message bodies never enter logs. */
@Injectable()
export class NotificationsService {
  async send(message: EmailMessage): Promise<void> {
    const mode = config.emailMode;
    if (mode === 'file') {
      if (config.production) throw new Error('File email is disabled in production.');
      const directory = config.mailDirectory;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(resolve(directory, `${Date.now()}-${randomUUID()}.eml`),
        `To: ${message.to}\nSubject: ${message.subject}\nContent-Type: text/plain; charset=utf-8\n\n${message.text}`, { mode: 0o600, flag: 'wx' });
      return;
    }
    if (mode !== 'resend' || !config.resendApiKey) throw new Error('Email configuration is invalid.');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.emailFrom, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    // Provider error bodies can echo sensitive message content; never log them.
    await response.body?.cancel();
    if (!response.ok) throw new Error('Email delivery was not accepted.');
  }
}
