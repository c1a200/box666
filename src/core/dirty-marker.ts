import type { Storage } from '../storage/interface';
import { KV_DIRTY_MARKER } from './config';
import { logger } from './logger';

function dirtyMarkerWrite(storage: Storage): (key: string, value: string) => Promise<void> {
  return storage.putForced ? storage.putForced.bind(storage) : storage.put.bind(storage);
}

export async function setDirtyMarker(storage: Storage): Promise<void> {
  await dirtyMarkerWrite(storage)(KV_DIRTY_MARKER, '1');
}

export async function getDirtyMarker(storage: Storage): Promise<boolean> {
  return (await storage.get(KV_DIRTY_MARKER)) === '1';
}

export async function clearDirtyMarker(storage: Storage): Promise<void> {
  await dirtyMarkerWrite(storage)(KV_DIRTY_MARKER, '');
  logger.debug('dirty-marker', 'cleared');
}
