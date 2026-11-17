/**
 * Maintenance of the sources subsystem (run on the server, same environment as the application):
 *   node dist/server/sources/maintenance-cli.js backup  --data <dataDir> --target <emptyDir>
 *   node dist/server/sources/maintenance-cli.js resume  --data <dataDir>
 *   node dist/server/sources/maintenance-cli.js verify  --data <dataDir> [--deep] [--reindex]
 * Storage settings come from BRIDGE_SOURCES_* environment variables; secrets are never printed.
 */
import { sourceStorageFromEnv } from './blob-store.js';
import { backupSources, resumeCollector, verifyRestore } from './backup.js';

const [command, ...rest] = process.argv.slice(2);
const option = (name: string) => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };
const flag = (name: string) => rest.includes('--' + name);
async function main() {
  const dataRoot = option('data');
  if (!dataRoot || !['backup', 'resume', 'verify'].includes(command ?? '')) {
    console.error('Usage: maintenance-cli.js backup|resume|verify --data <dir> [--target <dir>] [--deep] [--reindex]');
    process.exitCode = 2; return;
  }
  const storage = sourceStorageFromEnv(process.env);
  if (command === 'resume') { resumeCollector(dataRoot); console.log(JSON.stringify({ resumed: true })); return; }
  if (!storage.store) { console.error(storage.problem ?? 'Source storage is not configured'); process.exitCode = 3; return; }
  if (command === 'backup') {
    const target = option('target');
    if (!target) { console.error('--target is required'); process.exitCode = 2; return; }
    console.log(JSON.stringify(await backupSources({ dataRoot, target, store: storage.store }), null, 2));
    console.log('Collector paused. Copy the bucket now (for example: mc mirror), then run: maintenance-cli.js resume --data ' + dataRoot);
  } else {
    const result = await verifyRestore({ dataRoot, store: storage.store, deep: flag('deep'), reindex: flag('reindex') });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
  storage.store.close();
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
