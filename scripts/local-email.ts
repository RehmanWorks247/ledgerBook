import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export type LocalEmailConfig = {mode:'file'} | {mode:'resend';from:string;apiKey:string};

/** A sanitized startup error: never include configuration lines or secret values. */
export class LocalEmailConfigError extends Error {
  constructor() {
    super('Local email configuration is invalid. Check .local/email.env: use only EMAIL_MODE, EMAIL_FROM and RESEND_API_KEY; Resend requires all three.');
    this.name='LocalEmailConfigError';
  }
}

function invalid():never { throw new LocalEmailConfigError(); }

/** Strict, single-line dotenv syntax for a dedicated email-only opt-in file. */
export function parseLocalEmailConfig(source:string):LocalEmailConfig {
  if(Buffer.byteLength(source,'utf8')>8192 || source.includes('\0')) invalid();
  const values:Record<string,string>={};
  const allowed=new Set(['EMAIL_MODE','EMAIL_FROM','RESEND_API_KEY']);
  for(const line of source.replace(/^\uFEFF/,'').split(/\r?\n/)) {
    if(!line.trim() || line.trimStart().startsWith('#')) continue;
    const match=/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if(!match || !allowed.has(match[1]) || Object.hasOwn(values,match[1])) invalid();
    const value=match[2].trim();
    if(value.startsWith('"') || value.startsWith("'")) {
      const end=value.indexOf(value[0],1);
      if(end<1 || (value.slice(end+1).trim() && !value.slice(end+1).trimStart().startsWith('#'))) invalid();
    } else if(value.includes('"') || value.includes("'") || value.includes('`')) invalid();
    const parsed=parseEnv(line);
    const parsedValue=parsed[match[1]];
    if(Object.keys(parsed).length!==1 || typeof parsedValue!=='string') invalid();
    values[match[1]]=parsedValue.trim();
  }
  if(values.EMAIL_MODE==='file' && Object.keys(values).length===1) return {mode:'file'};
  if(values.EMAIL_MODE!=='resend' || Object.keys(values).length!==3) invalid();
  const from=values.EMAIL_FROM;
  const apiKey=values.RESEND_API_KEY;
  if(!from || from.length>320 || Array.from(from).some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127)
    || !/^re_[A-Za-z0-9_-]{12,200}$/.test(apiKey)) invalid();
  const display=/^([^<>]+)\s*<([^<>]+)>$/.exec(from);
  const address=display?display[2]:from;
  if((/[<>]/.test(from) && !display) || address.length>254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(address)) invalid();
  const localPart=address.split('@')[0];
  if(localPart.length>64 || localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) invalid();
  return {mode:'resend',from,apiKey};
}

export async function loadLocalEmailConfig(localDirectory:string):Promise<LocalEmailConfig> {
  let source:string;
  try { source=await readFile(resolve(localDirectory,'email.env'),'utf8'); }
  catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT') return {mode:'file'};
    throw new LocalEmailConfigError();
  }
  return parseLocalEmailConfig(source);
}

/** Overwrite inherited email settings; loading this file can never enable a production database. */
export function applyLocalEmailConfig(config:LocalEmailConfig,environment:NodeJS.ProcessEnv=process.env):void {
  environment.EMAIL_MODE=config.mode;
  if(config.mode==='resend') {
    environment.EMAIL_FROM=config.from;
    environment.RESEND_API_KEY=config.apiKey;
  } else {
    delete environment.EMAIL_FROM;
    delete environment.RESEND_API_KEY;
  }
}
