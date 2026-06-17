const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const wranglerPath = path.join(__dirname, '..', 'wrangler.toml');

const pkg = require(pkgPath);
const version = pkg.version;

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {}

const originalWrangler = fs.readFileSync(wranglerPath, 'utf-8');

try {
  // Remove existing [define] block if present to prevent duplicates
  let newWrangler = originalWrangler.replace(/\[define\][\s\S]*?(?=\n\s*\[|\n\s*\[\[|$)/g, '').trim();
  
  newWrangler += `\n\n[define]\n__APP_VERSION__ = '"${version}"'\n__APP_COMMIT__ = '"${commit}"'\n`;
  
  fs.writeFileSync(wranglerPath, newWrangler, 'utf-8');
  console.log(`[deploy] Injected version=${version} commit=${commit} into wrangler.toml`);
  
  // Run wrangler deploy, forward all stdio
  execSync('npx wrangler deploy', { stdio: 'inherit' });
} finally {
  // Restore original wrangler.toml
  fs.writeFileSync(wranglerPath, originalWrangler, 'utf-8');
  console.log('[deploy] Restored wrangler.toml');
}
