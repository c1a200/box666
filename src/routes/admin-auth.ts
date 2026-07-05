import type { AppConfig } from '../core/types';

export function verifyAdmin(request: Request, config: AppConfig): boolean {
  const token = config.adminToken;
  if (!token) return true;
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${token}`;
}
