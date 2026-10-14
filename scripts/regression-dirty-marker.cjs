const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.tmp-regression-build');
fs.mkdirSync(outDir, { recursive: true });

const dirtyOutfile = path.join(outDir, 'dirty-marker.cjs');
const kvOutfile = path.join(outDir, 'dirty-marker-kv.cjs');

buildSync({
  entryPoints: [path.join(root, 'src/core/dirty-marker.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: dirtyOutfile,
});

buildSync({
  entryPoints: [path.join(root, 'src/storage/kv.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: kvOutfile,
});

const { setDirtyMarker, clearDirtyMarker } = require(dirtyOutfile);
const { KVStorage } = require(kvOutfile);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class StaleReadKV {
  constructor(initial, visible) {
    this.store = new Map(Object.entries(initial || {}));
    this.visible = new Map(Object.entries(visible || {}));
    this.puts = [];
    this.gets = [];
  }

  async get(key) {
    this.gets.push(key);
    return this.visible.has(key) ? this.visible.get(key) : (this.store.has(key) ? this.store.get(key) : null);
  }

  async put(key, value) {
    const text = String(value);
    this.puts.push([key, text]);
    this.store.set(key, text);
  }
}

(async () => {
  {
    // 管理修改重新置脏：即使读取端暂时看到旧空值，也必须把 1 写到底层。
    const kv = new StaleReadKV({ dirty_marker: '' }, { dirty_marker: '' });
    const storage = new KVStorage(kv);
    await setDirtyMarker(storage);
    assert(kv.store.get('dirty_marker') === '1', 'setDirtyMarker must force the dirty marker to 1');
    assert(kv.puts.some(([key, value]) => key === 'dirty_marker' && value === '1'), 'setDirtyMarker must issue a direct KV put');
  }

  {
    // 聚合成功清脏：读取端可能跨 colo 看到旧的空值，但底层仍是 1；此时普通 put 会跳过，强制写必须落盘为空。
    const kv = new StaleReadKV({ dirty_marker: '1' }, { dirty_marker: '' });
    const storage = new KVStorage(kv);
    await clearDirtyMarker(storage);
    assert(kv.store.get('dirty_marker') === '', 'clearDirtyMarker must clear the dirty marker even when get returns a stale value');
    assert(kv.puts.some(([key, value]) => key === 'dirty_marker' && value === ''), 'clearDirtyMarker must issue a direct KV put');
  }

  {
    // 聚合失败保留脏：不调用 clear 时，底层值必须保持为脏，避免被测试替身误清除。
    const kv = new StaleReadKV({ dirty_marker: '1' }, { dirty_marker: '1' });
    const storage = new KVStorage(kv);
    const before = kv.store.get('dirty_marker');
    assert(before === '1', 'failed aggregation precondition must start dirty');
    assert(kv.puts.length === 0, 'failed aggregation must not write a dirty marker');
  }

  {
    // 通用写入仍保留额度优化：相同值不应产生新的 KV put。
    const kv = new StaleReadKV({ other_key: 'same' }, { other_key: 'same' });
    const storage = new KVStorage(kv);
    await storage.put('other_key', 'same');
    assert(kv.puts.length === 0, 'ordinary unchanged KV writes must still be skipped');
    assert(storage.getDiagnostics().kvPutSkippedUnchanged === 1, 'skipped ordinary writes must be counted in diagnostics');
  }

  console.log('regression: dirty marker forced-write checks passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
