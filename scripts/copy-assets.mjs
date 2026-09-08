// tsc emits only JavaScript. The SQL migrations sit beside the code and are
// read at runtime by src/db/migrate.ts, so they have to be copied into dist or
// the server crashes on first boot with ENOENT.
import { cpSync, existsSync } from 'node:fs';

const pairs = [['src/db/migrations', 'dist/db/migrations']];

for (const [from, to] of pairs) {
  if (!existsSync(from)) throw new Error(`missing build asset: ${from}`);
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
