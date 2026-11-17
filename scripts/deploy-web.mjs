#!/usr/bin/env node
// Manual Amplify Hosting deploy (no GitHub connection needed).
//
//   node scripts/deploy-web.mjs <ApiUrl> <WebSocketUrl>
//   NEXT_PUBLIC_API_URL=... NEXT_PUBLIC_WS_URL=... node scripts/deploy-web.mjs
//
// Builds the static site with the two backend URLs, then uploads apps/web/out to an
// Amplify app (created on first run, reused afterwards) and prints the site URL.
// Credentials and region come from the standard AWS environment — nothing is stored here.
// Options (env): AMPLIFY_APP_NAME (default from-this-to-that), AMPLIFY_BRANCH (default main),
// SKIP_BUILD=1 to upload an existing apps/web/out.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AmplifyClient, CreateAppCommand, CreateBranchCommand, CreateDeploymentCommand,
  GetBranchCommand, GetJobCommand, ListAppsCommand, StartDeploymentCommand,
} from '@aws-sdk/client-amplify';
import { zipSync } from 'fflate';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'apps', 'web', 'out');
const apiUrl = process.argv[2] ?? process.env.NEXT_PUBLIC_API_URL;
const wsUrl = process.argv[3] ?? process.env.NEXT_PUBLIC_WS_URL;
const appName = process.env.AMPLIFY_APP_NAME ?? 'from-this-to-that';
const branchName = process.env.AMPLIFY_BRANCH ?? 'main';

if (!apiUrl?.startsWith('https://') || !wsUrl?.startsWith('wss://')) {
  console.error('Usage: node scripts/deploy-web.mjs <ApiUrl https://...> <WebSocketUrl wss://...>');
  process.exit(1);
}

if (!process.env.SKIP_BUILD) {
  console.log('Building the site…');
  execFileSync('npm', ['run', 'build'], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, NEXT_PUBLIC_API_URL: apiUrl, NEXT_PUBLIC_WS_URL: wsUrl },
  });
}

// Zip the *contents* of out/ (index.html at the archive root).
const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files[path.relative(outDir, full).split(path.sep).join('/')] = readFileSync(full);
  }
};
walk(outDir);
if (!files['index.html']) throw new Error(`${outDir} has no index.html — did the build run?`);
const zip = zipSync(files, { level: 6 });
console.log(`Zipped ${Object.keys(files).length} files (${(zip.length / 1024).toFixed(0)} KiB).`);

const amplify = new AmplifyClient({});

let app;
for (let nextToken; ;) {
  const page = await amplify.send(new ListAppsCommand({ nextToken, maxResults: 50 }));
  app = page.apps?.find((a) => a.name === appName);
  nextToken = page.nextToken;
  if (app || !nextToken) break;
}
if (!app) {
  ({ app } = await amplify.send(new CreateAppCommand({
    name: appName,
    platform: 'WEB', // static export: no SSR compute
    // Single-page fallback: unknown paths serve the app shell.
    customRules: [{ source: '/<*>', target: '/index.html', status: '404-200' }],
  })));
  console.log(`Created Amplify app ${app.appId}.`);
} else {
  console.log(`Reusing Amplify app ${app.appId}.`);
}
const appId = app.appId;

try {
  await amplify.send(new GetBranchCommand({ appId, branchName }));
} catch (err) {
  if (err.name !== 'NotFoundException') throw err;
  await amplify.send(new CreateBranchCommand({ appId, branchName, stage: 'PRODUCTION', enableAutoBuild: false }));
  console.log(`Created branch ${branchName}.`);
}

const { jobId, zipUploadUrl } = await amplify.send(new CreateDeploymentCommand({ appId, branchName }));
const put = await fetch(zipUploadUrl, { method: 'PUT', body: zip, headers: { 'content-type': 'application/zip' } });
if (!put.ok) throw new Error(`Upload failed: HTTP ${put.status} ${await put.text()}`);
await amplify.send(new StartDeploymentCommand({ appId, branchName, jobId }));

for (let waited = 0; ; waited += 5) {
  const { job } = await amplify.send(new GetJobCommand({ appId, branchName, jobId }));
  const status = job.summary.status;
  if (status === 'SUCCEED') break;
  if (['FAILED', 'CANCELLED'].includes(status) || waited > 600) {
    throw new Error(`Amplify job ${jobId} ended as ${status}: ${JSON.stringify(job.steps?.map((s) => [s.stepName, s.status, s.statusReason]))}`);
  }
  await new Promise((r) => setTimeout(r, 5000));
}

console.log(`Deployed: https://${branchName}.${app.defaultDomain ?? `${appId}.amplifyapp.com`}`);
