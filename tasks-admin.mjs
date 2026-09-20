/**
 * Build the custom admin component (src-admin) and copy the bundle into admin/custom, where the admin
 * loads it as a module-federation remote. Mirrors what other adapters do with @iobroker/build-tools,
 * but without extra dependencies.
 *
 *   node tasks-admin.mjs           build with vite, then copy
 *   node tasks-admin.mjs --copy    only copy an existing src-admin/build
 */
import { execSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const srcAdmin = join(root, 'src-admin');
const build = join(srcAdmin, 'build');
const target = join(root, 'admin', 'custom');

if (!process.argv.includes('--copy')) {
    console.log('Building custom admin component (vite)...');
    execSync('npm run build', { cwd: srcAdmin, stdio: 'inherit' });
}

if (!existsSync(build)) {
    throw new Error(`No build found at ${build} - run the vite build first`);
}

// Fresh target, then copy everything except the dev-only entry files.
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, 'i18n'), { recursive: true });

const skip = new Set(['index.html', 'mf-manifest.json', 'mf-stats.json', '.vite']);
for (const entry of readdirSync(build)) {
    if (!skip.has(entry)) {
        cpSync(join(build, entry), join(target, entry), { recursive: true });
    }
}
cpSync(join(srcAdmin, 'src', 'i18n'), join(target, 'i18n'), { recursive: true });

console.log(`Custom admin component copied to ${target}`);
