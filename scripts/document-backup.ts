import 'reflect-metadata';
import { createHash,randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link,lstat,mkdir,open,rename,rm } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { z } from 'zod';
import { DocumentStorage,documentStorageOptions,type StoredDocument } from '../apps/api/src/bookings/document-storage';

const MAX_MANIFEST_BYTES=128*1024*1024;
const objectSchema=z.object({id:z.uuid(),bucket:z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  object_key:z.string().min(1).max(1024).refine(value=>value.startsWith('documents/') && value.split('/').every(part=>part && part!=='.' && part!=='..') && !Array.from(value).some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127)),
  checksum:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(1).max(10*1024*1024)}).strict();
const snapshotSchema=z.object({format:z.literal(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive(),
  referenced_objects:z.array(objectSchema).max(1_000_000)}).passthrough();
const backupSchema=z.object({format:z.literal('ledger-document-backup-v1'),database_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  snapshot_manifest_sha256:z.string().regex(/^[a-f0-9]{64}$/),objects:z.number().int().nonnegative(),bytes:z.number().int().nonnegative(),
  created_at:z.string().datetime(),completed_at:z.string().datetime().nullable()}).strict();
type BackupStatus=z.infer<typeof backupSchema>;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function privatePath(path:string,kind:'file'|'directory') {
  const info=await lstat(path);
  if(info.isSymbolicLink() || (kind==='file'?!info.isFile():!info.isDirectory()) || (info.mode&0o077)!==0) throw new Error(`Use a private ${kind} without group/world permissions or symbolic links.`);
  return info;
}
async function privateBytes(path:string,maximum:number) {
  const info=await privatePath(path,'file');
  if(info.size>maximum)throw new Error('Backup file exceeds its expected size limit.');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{return await file.readFile();}finally{await file.close();}
}
async function checksum(path:string) {
  await privatePath(path,'file');const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW),digest=createHash('sha256');
  try{for await(const chunk of file.createReadStream({autoClose:false}))digest.update(chunk);return digest.digest('hex');}finally{await file.close();}
}
async function snapshot(archive:string) {
  const path=resolve(archive),bytes=await privateBytes(`${path}.json`,MAX_MANIFEST_BYTES);
  const parsed=snapshotSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  if(!parsed.success)throw new Error('The database snapshot manifest must include valid referenced_objects. Create a new database backup first.');
  const manifest=parsed.data,seenIds=new Set<string>(),seenKeys=new Set<string>();
  for(const object of manifest.referenced_objects){
    const key=`${object.bucket}/${object.object_key}`;
    if(seenIds.has(object.id) || seenKeys.has(key))throw new Error('The snapshot contains duplicate object identities or keys.');
    seenIds.add(object.id);seenKeys.add(key);
  }
  if((await privatePath(path,'file')).size!==manifest.bytes || await checksum(path)!==manifest.sha256)throw new Error('The database archive does not match its snapshot manifest.');
  return {manifest,raw:bytes,manifestHash:hash(bytes),path};
}
function validBucket(objects:StoredDocument[],storage:DocumentStorage) {
  if(objects.length && (!storage.cloud || !storage.options.bucket || objects.some(object=>object.bucket!==storage.options.bucket)))throw new Error('Configure the same private cloud bucket recorded in this database snapshot.');
}
async function saveNew(path:string,bytes:Buffer) {
  const temporary=`${path}.partial-${randomUUID()}`,file=await open(temporary,'wx',0o600);
  try{
    await file.writeFile(bytes);await file.sync();await file.close();await link(temporary,path);
  }finally{await file.close().catch(()=>undefined);await rm(temporary,{force:true});}
}
async function saveStatus(path:string,status:BackupStatus) {
  const temporary=`${path}.partial-${randomUUID()}`,file=await open(temporary,'wx',0o600);
  try{await file.writeFile(`${JSON.stringify(status,null,2)}\n`);await file.sync();await file.close();await rename(temporary,path);}
  finally{await file.close().catch(()=>undefined);await rm(temporary,{force:true});}
}
async function syncDirectory(path:string) {
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{await handle.sync();}finally{await handle.close();}
}
function sameSnapshot(status:BackupStatus,databaseHash:string,manifestHash:string,count:number,total:number) {
  if(status.database_sha256!==databaseHash || status.snapshot_manifest_sha256!==manifestHash || status.objects!==count || status.bytes!==total)throw new Error('This document directory belongs to a different database snapshot. Choose a new directory.');
}
async function objectBytes(directory:string,object:StoredDocument) {
  const bytes=await privateBytes(join(directory,'objects',`${object.id}.bin`),object.size);
  if(bytes.length!==object.size || hash(bytes)!==object.checksum)throw new Error('A backed-up object has the wrong size or checksum. No restore should use this backup.');
  return bytes;
}

/** Copy only objects referenced by the exported database snapshot, never live DB state. */
export async function backupDocuments(archive:string,destination:string,storage:DocumentStorage) {
  const source=await snapshot(archive),directory=resolve(destination),objects=source.manifest.referenced_objects;
  validBucket(objects,storage);
  const total=objects.reduce((sum,object)=>sum+object.size,0),statusPath=join(directory,'backup.json'),snapshotPath=join(directory,'database-manifest.json');
  let status:BackupStatus;
  try{
    await mkdir(directory,{mode:0o700});
    status={format:'ledger-document-backup-v1',database_sha256:source.manifest.sha256,snapshot_manifest_sha256:source.manifestHash,
      objects:objects.length,bytes:total,created_at:new Date().toISOString(),completed_at:null};
    await mkdir(join(directory,'objects'),{mode:0o700});
    await saveNew(snapshotPath,source.raw);await saveNew(statusPath,Buffer.from(`${JSON.stringify(status,null,2)}\n`));
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    await privatePath(directory,'directory');await privatePath(join(directory,'objects'),'directory');
    status=backupSchema.parse(JSON.parse((await privateBytes(statusPath,4096)).toString('utf8')));
    sameSnapshot(status,source.manifest.sha256,source.manifestHash,objects.length,total);
    if(hash(await privateBytes(snapshotPath,MAX_MANIFEST_BYTES))!==source.manifestHash)throw new Error('The copied snapshot manifest is invalid.',{cause:error});
  }
  // Three bounded transfers cap memory at 30 MiB. All active work settles before
  // failure is returned, and no completion marker appears for a partial backup.
  let cursor=0,downloaded=0,reused=0;
  const outcomes=await Promise.allSettled(Array.from({length:Math.min(3,objects.length)},async()=>{
    while(cursor<objects.length){
      const object=objects[cursor++],path=join(directory,'objects',`${object.id}.bin`);
      try{await objectBytes(directory,object);reused++;continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const bytes=await storage.get(object);
      try{await saveNew(path,bytes);downloaded++;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await objectBytes(directory,object);reused++;}
    }
  }));
  const failed=outcomes.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  // Persist object directory entries before publishing the completion marker.
  // File fsync alone does not guarantee newly linked filenames survive a crash.
  await syncDirectory(join(directory,'objects'));
  status.completed_at=new Date().toISOString();await saveStatus(statusPath,status);
  await syncDirectory(directory);
  await syncDirectory(dirname(directory));
  return {status:'verified',objects:objects.length,bytes:total,downloaded,reused,directory};
}

/** Restore immutable object keys without changing database rows or overwriting cloud bytes. */
export async function restoreDocuments(archive:string,sourceDirectory:string,confirmation:string,storage:DocumentStorage) {
  const source=await snapshot(archive),directory=resolve(sourceDirectory),objects=source.manifest.referenced_objects;
  validBucket(objects,storage);
  if(confirmation!==storage.options.bucket || !confirmation)throw new Error('Confirm the exact configured destination bucket with --confirm-bucket.');
  await privatePath(directory,'directory');await privatePath(join(directory,'objects'),'directory');
  const status=backupSchema.parse(JSON.parse((await privateBytes(join(directory,'backup.json'),4096)).toString('utf8')));
  sameSnapshot(status,source.manifest.sha256,source.manifestHash,objects.length,objects.reduce((sum,object)=>sum+object.size,0));
  if(!status.completed_at)throw new Error('The document backup is incomplete. Resume and verify its backup before restoring.');
  if(hash(await privateBytes(join(directory,'database-manifest.json'),MAX_MANIFEST_BYTES))!==source.manifestHash)throw new Error('The copied snapshot manifest is invalid.');
  // Verify the whole local backup before the first cloud write, including files
  // near the end. Re-read each bounded object immediately before its own PUT.
  for(const object of objects)await objectBytes(directory,object);
  let created=0,existing=0;
  for(const object of objects){
    const result=await storage.restoreIfAbsent(object,await objectBytes(directory,object));
    if(result==='created')created++;else existing++;
  }
  return {status:'verified',objects:objects.length,created,existing};
}

if(require.main===module){
  const [action,archive,directory,flag,confirmation,...extra]=process.argv.slice(2);
  let storage:DocumentStorage|undefined;
  void(async()=>{
    if(!archive || !directory || extra.length || (action==='backup'?Boolean(flag):action!=='restore' || flag!=='--confirm-bucket' || !confirmation))throw new Error('Usage: document-backup backup DATABASE.dump DIRECTORY | restore DATABASE.dump DIRECTORY --confirm-bucket BUCKET');
    storage=new DocumentStorage(documentStorageOptions());
    return action==='backup'?backupDocuments(archive,directory,storage):restoreDocuments(archive,directory,confirmation!,storage);
  })().then(result=>console.log(JSON.stringify(result))).catch(()=>{
    console.error('Document backup/restore failed. Check the private snapshot archive/manifest, backup directory integrity, exact bucket confirmation, and storage credentials. Partial copies remain safe to retry; existing cloud objects are never overwritten.');process.exitCode=1;
  }).finally(()=>storage?.onApplicationShutdown());
}
