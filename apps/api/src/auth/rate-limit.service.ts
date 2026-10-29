import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { tokenHash } from './crypto';

@Injectable()
export class RateLimitService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async consume(scope: string, identity: string, limit: number, seconds: number): Promise<void> {
    const key = tokenHash(`${scope}:${identity}`);
    const result = await this.db.query<{ count: number }>(
      `INSERT INTO rate_limits (key, count, expires_at)
       VALUES ($1, 1, now() + $2 * interval '1 second')
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.expires_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
         expires_at = CASE WHEN rate_limits.expires_at <= now() THEN now() + $2 * interval '1 second' ELSE rate_limits.expires_at END
       RETURNING count`, [key, seconds],
    );
    if (result.rows[0].count > limit) {
      throw new HttpException('Too many attempts. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
