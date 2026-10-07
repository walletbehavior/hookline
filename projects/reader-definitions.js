/**
 * Source-bound, read-only project adapters.
 *
 * These definitions are not a claim that a project's entire activity is covered.
 * The collector supplies a pinned block for calls and an explicit range for logs.
 * A missing/reverting read is unavailable, never zero. Configured charges are not
 * observed effective fees. Accrued balances are not payments. Decoded events are
 * reported as contract records with their transaction/log identifiers, not as an
 * independently reconciled account total.
 *
 * An adapter applies only to the explicit chain/address in each definition.
 * Do not apply an ABI to another deployment because its name or bytecode matches.
 */

const ENGRAM_ABI = 'https://engramv4.xyz/assets/baked.js';
const ENGRAM_HOOK = '0x0ee851f1fe2f4bdba79fee78969e329c136ca0cc';
const ZORA_REGISTRY_DOCS = 'https://docs.zora.co/coins/contracts/hook-registry';
const ZORA_REGISTRY = '0x777777c4c14b133858c3982d41dbf02509fc18d7';
const PONS_DOCS = 'https://docs.ponsfamily.com/v2';
const PONS_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const CLANKER_ABI = 'https://raw.githubusercontent.com/clanker-devco/v4-contracts/main/base_mainnet_abis/Clanker.sol/Clanker.json';
const CLANKER_FACTORY = '0xe85a59c628f7d27878aceb4bf3b35733630083a9';

const engramRead = (definition) => ({
  chainId: 1,
  address: ENGRAM_HOOK,
  classification: 'configuration',
  sourceUrl: ENGRAM_ABI,
  sourceVersion: 'published ABI build ff8860ba, 2026-10-07',
  ...definition,
});

const engramEvent = (definition) => ({
  chainId: 1,
  address: ENGRAM_HOOK,
  sourceUrl: ENGRAM_ABI,
  sourceVersion: 'published ABI build ff8860ba, 2026-10-07',
  ...definition,
});

const clankerDefinition = (definition) => ({
  chainId: 8453,
  address: CLANKER_FACTORY,
  sourceUrl: CLANKER_ABI,
  sourceVersion: 'Base v4.0 published factory ABI, observed 2026-10-07',
  ...definition,
});

export const READERS = {
  clanker: {
    version: 1,
    label: 'Clanker Base token factory',
    sources: [{ label: 'Official Base factory ABI', url: CLANKER_ABI }],
    reads: [
      clankerDefinition({
        key: 'factoryDeprecated', label: 'Factory deprecated', signature: 'deprecated()', returns: 'bool',
        classification: 'configuration',
        description: 'Factory deployment status. This does not assert that existing tokens or pools stop trading.',
      }),
      clankerDefinition({
        key: 'teamFeeRecipient', label: 'Team fee recipient', signature: 'teamFeeRecipient()', returns: 'address',
        classification: 'configuration',
        description: 'Configured factory team-fee recipient, not the creator-fee recipient for every token.',
      }),
    ],
    events: [
      clankerDefinition({
        key: 'tokenCreated', label: 'Token deployed', classification: 'executed',
        signature: 'event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)',
        deploymentField: 'tokenAddress', hookField: 'poolHook', poolField: 'poolId',
        description: 'Factory-recorded deployment and hook relationship. Names, metadata, image URLs, and context are creator-supplied untrusted text, not verified project identity.',
      }),
      clankerDefinition({
        key: 'hookAllowanceChanged', label: 'Hook allowance changed', classification: 'configured',
        signature: 'event SetHook(address hook, bool enabled)', deploymentField: 'hook',
        description: 'A hook was enabled or disabled for this factory. Enabling does not mean the hook was newly deployed.',
      }),
      clankerDefinition({
        key: 'feeRecipientChanged', label: 'Team fee recipient changed', classification: 'configured',
        signature: 'event SetTeamFeeRecipient(address oldTeamFeeRecipient, address newTeamFeeRecipient)',
        description: 'Records both old and new team-fee recipients for the factory.',
      }),
      clankerDefinition({
        key: 'factoryDeprecationChanged', label: 'Factory status changed', classification: 'configured',
        signature: 'event SetDeprecated(bool deprecated)',
        description: 'Factory creation status changed. Existing markets require their own observation.',
      }),
      clankerDefinition({
        key: 'teamFeeClaimed', label: 'Team fee claim recorded', classification: 'transferred',
        signature: 'event ClaimTeamFees(address indexed token, address indexed recipient, uint256 amount)',
        amountField: 'amount', recipientField: 'recipient', assetField: 'token', unit: 'raw-token-units',
        description: 'The contract-recorded claim amount in the event token, not ETH or USD. A recipient balance reconciliation is a separate measurement.',
      }),
    ],
  },
  pons: {
    version: 1,
    label: 'Pons v2 Robinhood launch factory',
    sources: [{ label: 'Official deployment, view functions, and event ABI', url: PONS_DOCS }],
    reads: [
      {
        key: 'launchFee', label: 'Configured launch fee', chainId: 4663, address: PONS_FACTORY,
        signature: 'launchFee()', returns: 'uint256', classification: 'configuration', unit: 'wei', asset: 'ETH',
        sourceUrl: PONS_DOCS, sourceVersion: 'v2 documentation observed 2026-10-07',
        description: 'Fee for creating a new launch. This is not a swap fee or a claim about fees paid by existing tokens.',
      },
      {
        key: 'launchConfigCount', label: 'Launch configurations', chainId: 4663, address: PONS_FACTORY,
        signature: 'launchConfigCount()', returns: 'uint256', classification: 'configuration', unit: 'count',
        sourceUrl: PONS_DOCS, sourceVersion: 'v2 documentation observed 2026-10-07',
        description: 'Append-only configuration count, including configurations that may be disabled. Not a token-launch count.',
      },
    ],
    events: [
      {
        key: 'tokenLaunched', label: 'Token launched', chainId: 4663, address: PONS_FACTORY,
        signature: 'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
        classification: 'executed', sourceUrl: PONS_DOCS, sourceVersion: 'v2 documentation observed 2026-10-07',
        deploymentField: 'token', curveField: 'curve', assetField: 'pairToken',
        description: 'New token and bonding curve created by the documented factory. This is not proof of v4 graduation or a new hook deployment.',
      },
    ],
  },
  engram: {
    version: 1,
    label: 'ENGRAM published Hippocampus interface',
    sources: [{ label: 'Published contract ABI, build ff8860ba', url: ENGRAM_ABI }],
    reads: [
      engramRead({
        key: 'model', label: 'Current model', signature: 'champion()', returns: 'address',
        zeroLabel: 'Default model',
        description: 'The zero address is the documented default model, not a failed or missing read.',
      }),
      engramRead({
        key: 'feeRecipient', label: 'Owner fee recipient', signature: 'OWNER()', returns: 'address',
        description: 'Fee beneficiary. This does not assert administrative ownership or upgrade power.',
      }),
      engramRead({
        key: 'configuredHookFee', label: 'Configured hook charge', signature: 'HOOK_BPS()', returns: 'uint256',
        unit: 'bps', denominator: 10000, basis: 'ETH leg',
        description: 'Nominal hook charge on the ETH leg. Not an observed effective trade fee or LP fee.',
      }),
      engramRead({
        key: 'configuredOwnerShare', label: 'Configured owner charge', signature: 'OWNER_BPS()', returns: 'uint256',
        unit: 'bps', denominator: 10000, basis: 'ETH leg',
        description: 'Component of the configured hook charge, not an additional charge.',
      }),
      engramRead({
        key: 'configuredTrainerShare', label: 'Configured trainer charge', signature: 'POT_BPS()', returns: 'uint256',
        unit: 'bps', denominator: 10000, basis: 'ETH leg',
        description: 'Component allocated to the trainer pot, not proof a trainer received a payment.',
      }),
      engramRead({
        key: 'ownerAccrued', label: 'Owner fees accrued', signature: 'ownerOwed()', returns: 'uint256',
        classification: 'accrued', unit: 'wei', asset: 'ETH',
        description: 'Outstanding owner amount at the observed block, not lifetime revenue or paid rewards.',
      }),
    ],
    events: [
      engramEvent({
        key: 'modelChanged', label: 'Model changed',
        signature: 'event Champion(address indexed mind)', classification: 'configured',
        zeroLabel: 'Default model',
        description: 'Records the chosen model. A zero address selects the default; the event alone does not establish model quality.',
      }),
      engramEvent({
        key: 'paymentRecorded', label: 'Payment recorded',
        signature: 'event Paid(address indexed to, uint256 eth)', classification: 'transferred',
        unit: 'wei', asset: 'ETH', amountField: 'eth', recipientField: 'to',
        description: 'Payment emitted by this contract. Preserve the recipient and transaction; do not label every payment a trainer reward.',
      }),
      engramEvent({
        key: 'poolBound', label: 'Pool attached',
        signature: 'event PoolBound(bytes32 indexed poolId, uint160 sqrtPriceX96)', classification: 'configured',
        poolField: 'poolId',
        description: 'Binds this hook to a pool. This does not identify a new independent project.',
      }),
    ],
  },
  zora: {
    version: 1,
    label: 'Zora canonical hook registry',
    sources: [{ label: 'Official registry interface and deployment', url: ZORA_REGISTRY_DOCS }],
    reads: [],
    events: [
      {
        key: 'hookRegistered', label: 'Hook registered', chainId: 8453, address: ZORA_REGISTRY,
        signature: 'event ZoraHookRegistered(address indexed hook, string tag, string version)',
        classification: 'configured', sourceUrl: ZORA_REGISTRY_DOCS,
        sourceVersion: 'documentation observed 2026-10-07', deploymentField: 'hook',
        description: 'Canonical registry affiliation, not proof that the deployment is newly created or safe.',
      },
      {
        key: 'hookRemoved', label: 'Hook registration removed', chainId: 8453, address: ZORA_REGISTRY,
        signature: 'event ZoraHookRemoved(address indexed hook, string tag, string version)',
        classification: 'configured', sourceUrl: ZORA_REGISTRY_DOCS,
        sourceVersion: 'documentation observed 2026-10-07', deploymentField: 'hook',
        description: 'Removal from this registry does not erase deployment history or prove a security incident.',
      },
    ],
  },
};

/** Explicit matching keeps project-wide adapters off unrelated contracts. */
export function readerDefinitionsForDeployment(projectId, deployment) {
  const reader = READERS[projectId];
  if (!reader || !deployment) return { reads: [], events: [] };
  const address = String(deployment.address || '').toLowerCase();
  const chainId = Number(deployment.chainId);
  const matches = (definition) => definition.chainId === chainId && definition.address === address;
  return {
    reads: reader.reads.filter(matches),
    events: reader.events.filter(matches),
  };
}
