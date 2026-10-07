import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const identityPath = resolve('data/verified-hook-identities.json');
const hookPath = resolve('dist/hooks.json');

if (!existsSync(identityPath)) throw new Error(`missing ${identityPath}`);
if (!existsSync(hookPath)) throw new Error(`missing ${hookPath}`);

const identitySnapshot = JSON.parse(readFileSync(identityPath, 'utf8'));
const hookSnapshot = JSON.parse(readFileSync(hookPath, 'utf8'));
const identities = identitySnapshot && typeof identitySnapshot.identities === 'object'
  ? identitySnapshot.identities
  : {};

let matched = 0;
hookSnapshot.hooks = hookSnapshot.hooks.map((hook) => {
  const verifiedContract = identities[hook.id] || null;
  if (verifiedContract?.name) matched += 1;
  return { ...hook, verifiedContract };
});
hookSnapshot.coverage = { ...hookSnapshot.coverage, verifiedIdentityCount: matched };
hookSnapshot.sources = Array.isArray(hookSnapshot.sources) ? hookSnapshot.sources : [];
if (!hookSnapshot.sources.some((source) => source?.label === 'Sourcify verified contract dataset')) {
  hookSnapshot.sources.push({
    label: 'Sourcify verified contract dataset',
    role: 'verified deployed contract titles',
    url: 'https://export.sourcify.dev/v2/',
  });
}

writeFileSync(hookPath, `${JSON.stringify(hookSnapshot)}\n`, 'utf8');
console.log(`applied ${matched} verified contract identities to ${hookPath}`);
