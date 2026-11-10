import 'reflect-metadata';
import { DatabaseService } from '../apps/api/src/database/database.service';
import { cleanupDocumentObjects, DocumentStorage } from '../apps/api/src/bookings/document-storage';

async function main() {
  const storage=new DocumentStorage();
  if(!storage.cloud) throw new Error('Configure R2 or S3 document storage before running cleanup.');
  const db=new DatabaseService();
  try {
    const result=await cleanupDocumentObjects(db,storage);
    console.log(`Document storage cleanup: ${result.removed} removed, ${result.failed} pending retry.`);
    if(result.failed) process.exitCode=1;
  } finally { await db.close(); storage.onApplicationShutdown(); }
}
void main().catch(()=>{console.error('Document storage cleanup failed. Verify database and storage configuration.');process.exitCode=1;});
