import { subscribeLogSink } from './logger';
import type { LogEntry } from './logger';

const CAPACITY = 1000;
const buffer: LogEntry[] = new Array(CAPACITY);
let head = 0;
let size = 0;

type Subscriber = (entry: LogEntry) => void;
const subscribers = new Set<Subscriber>();

function push(entry: LogEntry): void {
  if (size < CAPACITY) {
    buffer[(head + size) % CAPACITY] = entry;
    size++;
  } else {
    buffer[head] = entry;
    head = (head + 1) % CAPACITY;
  }

  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // Keep log collection non-blocking and avoid logger recursion.
    }
  }
}

export function getHistory(): LogEntry[] {
  const out: LogEntry[] = [];
  for (let i = 0; i < size; i++) {
    out.push(buffer[(head + i) % CAPACITY]!);
  }
  return out;
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export function getBufferedCount(): number {
  return size;
}

subscribeLogSink(push);
