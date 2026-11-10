import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config';

export type EmailAttachment = { filename:string; content:Buffer; contentType?:string };
export type EmailMessage = { to: string; subject: string; text: string; attachments?:EmailAttachment[] };

function attachmentFilename(filename:string) {
  return Array.from(filename).slice(0,60).map(character=>character.charCodeAt(0)<32 || character.charCodeAt(0)===127 || /[/\\";]/.test(character)
    ? '_' : character).join('') || 'attachment';
}

function attachmentContentType(contentType?:string) {
  return contentType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(contentType)
    ? contentType : 'application/octet-stream';
}

function fileMessage(message:EmailMessage) {
  const to=message.to.replace(/[\r\n]/g,' '),subject=message.subject.replace(/[\r\n]/g,' ');
  if(!message.attachments?.length) return `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${message.text}`;
  // The boundary cannot occur in an encoded attachment; each send publishes a
  // complete MIME message atomically, including on idempotent local retries.
  const boundary=`ledger-${randomUUID()}`;
  const encode=(content:Buffer)=>content.toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
  const subjectHeader=/[^\x20-\x7e]/.test(subject)
    ? Array.from(subject).reduce<string[]>((chunks,character)=>{
      if(!chunks.length || Buffer.byteLength(chunks[chunks.length-1]+character)>42)chunks.push(character);
      else chunks[chunks.length-1]+=character;
      return chunks;
    },[]).map(chunk=>`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join('\r\n ')
    : subject;
  const parts=[`To: ${to}`,`Subject: ${subjectHeader}`,`From: ${config.emailFrom.replace(/[\r\n]/g,' ')}`,
    `Date: ${new Date().toUTCString()}`,'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,'',`--${boundary}`,
    'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: 8bit','',message.text.replace(/\r?\n/g,'\r\n')];
  for(const attachment of message.attachments) {
    const filename=attachmentFilename(attachment.filename);
    const fallback=filename.replace(/[^\x20-\x7e]/g,'_');
    const encoded=encodeURIComponent(filename).replace(/['()*]/g,character=>`%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    parts.push(`--${boundary}`,`Content-Type: ${attachmentContentType(attachment.contentType)}`,
      `Content-Disposition: attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      'Content-Transfer-Encoding: base64','',encode(attachment.content));
  }
  parts.push(`--${boundary}--`,'');
  return parts.join('\r\n');
}

/** The sole email-provider boundary. Credentials and message bodies never enter logs. */
@Injectable()
export class NotificationsService {
  constructor(@Optional() @Inject('EMAIL_API_URL') private readonly apiUrl = 'https://api.resend.com/emails') {
    // Test-only endpoint injection cannot redirect production mail or secrets.
    if (apiUrl !== 'https://api.resend.com/emails' && (config.production || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(apiUrl))) {
      throw new Error('Email API overrides are restricted to local testing.');
    }
  }

  async send(message: EmailMessage, options: {idempotencyKey?:string} = {}): Promise<{providerMessageId:string}|void> {
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
        await writeFile(temporary,fileMessage(message), { mode: 0o600, flag: 'wx' });
        // Publish complete bytes atomically. A crash while writing the temporary
        // file cannot leave a partial idempotency marker that suppresses a retry.
        await link(temporary,resolve(directory, `${filename}.eml`))
          .catch(error => { if (!options.idempotencyKey || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      } finally { await unlink(temporary).catch(() => undefined); }
      return {providerMessageId:`local-${filename}`};
    }
    if (mode !== 'resend' || !config.resendApiKey) throw new Error('Email configuration is invalid.');
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json',
        ...(options.idempotencyKey ? {'Idempotency-Key':options.idempotencyKey} : {}) },
      body: JSON.stringify({ from: config.emailFrom, to: [message.to], subject: message.subject, text: message.text,
        ...(message.attachments?.length ? {attachments:message.attachments.map(attachment=>({
          filename:attachmentFilename(attachment.filename),content:attachment.content.toString('base64'),
        }))} : {}),
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    // Provider error bodies can echo sensitive message content; never log them.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Email delivery was not accepted.');
    }
    const receipt:unknown = await response.json();
    const id = receipt && typeof receipt==='object' && 'id' in receipt ? receipt.id : undefined;
    if (typeof id!=='string' || !id || id.length>200) throw new Error('Email acceptance could not be confirmed.');
    return {providerMessageId:id};
  }
}
