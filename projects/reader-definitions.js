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
const DOPPLER_DEPLOYMENTS = Object.freeze({
  8453: {
    address: '0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12',
    commit: '9b23399',
  },
  4663: {
    address: '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862',
    commit: 'bda077cf',
  },
});
const ANGSTROM_CONTROLLER = '0x1746484ea5e11c75e009252c102c8c33e0315fd4';
const ANGSTROM_CONTROLLER_SOURCE = `https://eth.blockscout.com/api/v2/smart-contracts/${ANGSTROM_CONTROLLER}`;
const ANGSTROM_CONTROLLER_VERSION = 'Verified ControllerV1 source SHA-256 ff1090f9c4b67a8ce7d0c3587de84b43c4fdaa6a14458448bda714c145ced9c2, Solidity 0.8.26, observed 2026-10-07';
const HOOKR_COMMIT = 'c947cedf90146915884b927c04e17862b020ecb1';
const HOOKR_MANIFEST = `https://raw.githubusercontent.com/Hookr-fun/hookr-contracts/${HOOKR_COMMIT}/hookr-1/deployments/robinhood-4663.json`;
const HOOKR_RELEASE_DOCS = `https://raw.githubusercontent.com/Hookr-fun/hookr-contracts/${HOOKR_COMMIT}/hookr-1/README.md`;
const HOOKR_LAUNCHER_SOURCE = `https://raw.githubusercontent.com/Hookr-fun/hookr-contracts/${HOOKR_COMMIT}/hookr-1/src/periphery/HookrLauncher.sol`;
const HOOKR_ROOT_SOURCE = `https://raw.githubusercontent.com/Hookr-fun/hookr-contracts/${HOOKR_COMMIT}/hookr-1/src/core/HookrRoot.sol`;
const HOOKR_LAUNCHER = '0x1cf2748a6670572425eabf9ab9e5bc4eb2eb8ef4';
const HOOKR_ROOT = '0x89c9fb50d1f03192230ffb1c279bb6e7d3fe6acc';
const HOOKR_LAUNCHER_VERSION = 'Hookr 1 manifest at c947ced, HookrLauncher source keccak256 0x9a81347a4ac1c5620c7aad977db6acabf3b53833e93dee43f1befac51a862dbc, checked at Robinhood block 82543400';
const HOOKR_ROOT_VERSION = 'Hookr 1 manifest at c947ced, HookrRoot source keccak256 0xa390d177a63f6d815ed3b8caed8d57fc5bbace1e730eba4c472b26d8090594a0, checked at Robinhood block 82543400';
const CLAUS_HOOK = '0x37bfb8ac7c960e558657871d41ca70e07e7dbfff';
const CLAUS_IMPLEMENTATION = '0x767ea7dce972abd91fa81fe90f105eafcc2959fc';
const CLAUS_TOKEN = '0x1b54e762aa34cf6e28e9c082f2848e28e45da6b8';
const CLAUS_NFT = '0x80396c7131159eb92e7e84839e51c9887a7a95d9';
const CLAUS_SOURCE = `https://eth.blockscout.com/api/v2/smart-contracts/${CLAUS_IMPLEMENTATION}`;
const CLAUS_NFT_SOURCE = `https://eth.blockscout.com/api/v2/smart-contracts/${CLAUS_NFT}`;
const CLAUS_VERSION = 'Verified FeePrivacyHook 0x767ea7dce972abd91fa81fe90f105eafcc2959fc, Solidity 0.8.26, observed 2026-10-07';

const clausHookDefinition = (definition) => ({
  chainId: 1, address: CLAUS_HOOK, implementationAddress: CLAUS_IMPLEMENTATION,
  sourceUrl: CLAUS_SOURCE, sourceVersion: CLAUS_VERSION, ...definition,
});
const clausAllocation = (definition) => clausHookDefinition({
  classification: 'configuration', returns: 'uint24', unit: 'ppm', denominator: 1_000_000,
  basis: 'gross ETH', ...definition,
});
const clausAccrued = (definition) => clausHookDefinition({
  classification: 'accrued', returns: 'uint256', unit: 'wei', asset: 'ETH', ...definition,
});
const clausNftEvent = (definition) => ({
  chainId: 1, address: CLAUS_NFT,
  sourceUrl: CLAUS_NFT_SOURCE,
  sourceVersion: 'Verified non-proxy ClausNFT / NftRewards, observed 2026-10-07',
  unit: 'wei', asset: 'ETH', amountField: 'amount', ...definition,
});
const ethWei = { unit: 'wei', asset: 'ETH' };
const clausUnits = { unit: 'raw-token-units', asset: CLAUS_TOKEN, decimals: 18 };

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

const dopplerAirlockDefinition = (chainId, definition) => {
  const deployment = DOPPLER_DEPLOYMENTS[chainId];
  return {
    chainId,
    address: deployment.address,
    sourceUrl: `https://raw.githubusercontent.com/whetstoneresearch/doppler/${deployment.commit}/src/Airlock.sol`,
    sourceVersion: `Canonical Airlock deployment commit ${deployment.commit}, observed 2026-10-07`,
    ...definition,
  };
};

const dopplerAirlockEvents = (chainId) => [
  dopplerAirlockDefinition(chainId, {
    key: 'assetCreated', label: 'Asset launch created', classification: 'executed',
    signature: 'event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)',
    deploymentField: 'asset', assetField: 'numeraire',
    fieldLabels: { initializer: 'Pool initializer', poolOrHook: 'Pool or hook' },
    description: 'Airlock created an asset and recorded its numeraire, initializer, and initial pool address. For a v4 initializer, poolOrHook is a hook; for v3 it is a pool. This event does not establish token quality or current liquidity.',
  }),
  dopplerAirlockDefinition(chainId, {
    key: 'assetMigrated', label: 'Asset liquidity migrated', classification: 'executed',
    signature: 'event Migrate(address indexed asset, address indexed pool)',
    deploymentField: 'asset', poolField: 'pool',
    description: 'Airlock recorded an asset migration and the pool address emitted by this deployment. The transaction is the evidence; the event alone does not measure post-migration liquidity.',
  }),
  dopplerAirlockDefinition(chainId, {
    key: 'moduleStateChanged', label: 'Airlock module state changed', classification: 'configured',
    signature: 'event SetModuleState(address indexed module, uint8 indexed state)',
    deploymentField: 'module', fieldLabels: { state: 'Module state' },
    fieldValueLabels: { state: { 0: 'Not whitelisted', 1: 'Token factory', 2: 'Governance factory', 3: 'Pool initializer', 4: 'Liquidity migrator' } },
    description: 'The Airlock owner changed a module allowlist role. The numeric enum is decoded against the source-bound Airlock commit for this chain.',
  }),
  dopplerAirlockDefinition(chainId, {
    key: 'feesCollected', label: 'Airlock fee collection recorded', classification: 'transferred',
    signature: 'event Collect(address indexed to, address indexed token, uint256 amount)',
    recipientField: 'to', assetField: 'token', amountField: 'amount', unit: 'raw-token-units',
    description: 'Airlock recorded a protocol or integrator fee collection to the named recipient. Amount is raw units of token; the zero address denotes native currency. This is contract-reported transfer evidence, not USD value.',
  }),
];

const angstromControllerDefinition = (definition) => ({
  chainId: 1,
  address: ANGSTROM_CONTROLLER,
  sourceUrl: ANGSTROM_CONTROLLER_SOURCE,
  sourceVersion: ANGSTROM_CONTROLLER_VERSION,
  ...definition,
});

const angstromFeeUnit = { unit: 'ppm', denominator: 1_000_000 };

const hookrLauncherDefinition = (definition) => ({
  chainId: 4663,
  address: HOOKR_LAUNCHER,
  sourceUrl: HOOKR_MANIFEST,
  sourceVersion: HOOKR_LAUNCHER_VERSION,
  ...definition,
});

const hookrRootDefinition = (definition) => ({
  chainId: 4663,
  address: HOOKR_ROOT,
  sourceUrl: HOOKR_MANIFEST,
  sourceVersion: HOOKR_ROOT_VERSION,
  ...definition,
});

const hookrRawCurrency = { unit: 'raw-token-units', assetField: 'quote' };

export const READERS = {
  claus: {
    version: 1,
    maxReads: 12,
    label: 'CLAUS verified fee, buyback and NFT-reward records',
    sources: [
      { label: 'Verified FeePrivacyHook ABI and inherited source', url: CLAUS_SOURCE },
      { label: 'Verified ClausNFT reward ABI and source', url: CLAUS_NFT_SOURCE },
      { label: 'Official NFT deployment and reward documentation', url: 'https://claus.si/read/Hooks/NFTs' },
    ],
    reads: [
      clausAllocation({
        key: 'configuredBurnAllocation', label: 'Configured burn allocation', signature: 'BURN_FEE_PIPS()',
        description: 'Current weather-dependent allocation on gross ETH. A configured allocation is not a completed buyback or burn.',
      }),
      clausAllocation({
        key: 'configuredLiquidityAllocation', label: 'Configured liquidity allocation', signature: 'LIQUIDITY_FEE_PIPS()',
        description: 'Current allocation earmarked for liquidity, not ETH already added to the pool. Read at the same block as the burn allocation.',
      }),
      clausAllocation({
        key: 'configuredWalletAllocation', label: 'Configured project-wallet allocation', signature: 'WALLET_FEE_PIPS()',
        description: 'Configured project-wallet component. It absorbs the NFT share while NFT supply is zero; do not replace this call with a fixed percentage.',
      }),
      clausAllocation({
        key: 'configuredNftAllocation', label: 'Configured NFT-reward allocation', signature: 'NFT_FEE_PIPS()',
        description: 'Configured gross-ETH share for the NFT reward pot. Zero is a valid response when NFT supply is zero. Accrual is not a holder payout.',
      }),
      clausAllocation({
        key: 'configuredFomoAllocation', label: 'Configured FOMO-buyback allocation', signature: 'FOMO_FEE_PIPS()',
        description: 'Allocation for token purchases sent to the configured FOMO recipient, not burns. These five allocation getters cover the project share, not the platform share or full hook charge.',
      }),
      clausHookDefinition({
        key: 'feeRecipient', label: 'Configured project fee recipient', signature: 'feeRecipient()', returns: 'address',
        classification: 'configuration',
        description: 'Recipient recorded in launch storage. It is not the proxy administrator and is not evidence of a completed payment.',
      }),
      clausHookDefinition({
        key: 'fomoRecipient', label: 'Configured FOMO token recipient', signature: 'fomoRecipient()', returns: 'address',
        classification: 'configuration',
        description: 'Recipient of purchased FOMO tokens. It is not the recipient of every hook fee or of burned tokens.',
      }),
      clausHookDefinition({
        key: 'nftRewardsContract', label: 'NFT reward contract', signature: 'nft()', returns: 'address',
        classification: 'configuration',
        description: 'Reward-accounting contract. Individual holder payments are emitted there, not by this hook proxy.',
      }),
      clausAccrued({
        key: 'projectFeesAccrued', label: 'Project fees awaiting claim', signature: 'projectFeeBalance()',
        description: 'Outstanding native-ETH claims in the project revenue vault at this block. Not lifetime revenue or money already paid to the wallet.',
      }),
      clausAccrued({
        key: 'burnFundsAccrued', label: 'Burn funds awaiting processing', signature: 'pendingBurnEth()',
        description: 'Native-ETH claims awaiting the buyback processor. A zero balance does not prove a buyback happened; inspect its event and receipt.',
      }),
      clausAccrued({
        key: 'liquidityFundsAccrued', label: 'Liquidity ETH awaiting processing', signature: 'pendingLiquidityEth()',
        description: 'Earmarked native-ETH claims, excluding any token-side reserve. Not deployed liquidity or USD value.',
      }),
      clausAccrued({
        key: 'fomoFundsAccrued', label: 'FOMO funds awaiting processing', signature: 'pendingFomoEth()',
        description: 'Native-ETH claims awaiting purchases for the FOMO recipient. Not tokens already received or burned.',
      }),
    ],
    events: [
      clausHookDefinition({
        key: 'feesAccrued', label: 'Hook fee accrual recorded', classification: 'accrued',
        signature: 'event ProjectFeeAccrued(bytes32 indexed poolId, address indexed sender, bool exactInput, uint256 grossEth, uint256 feeEth)',
        amountField: 'feeEth', poolField: 'poolId', unit: 'wei', asset: 'ETH',
        fieldUnits: { grossEth: ethWei, feeEth: ethWei },
        description: 'Despite the event name, feeEth is the total hook charge including platform allocation, on grossEth. It is not the LP fee or a completed recipient payout; sender is the caller.',
      }),
      clausHookDefinition({
        key: 'feeAllocationRecorded', label: 'Project and platform allocation recorded', classification: 'accrued',
        signature: 'event FeeAllocation(uint256 grossEth, uint256 projectEth, uint256 platformEth)',
        fieldUnits: { grossEth: ethWei, projectEth: ethWei, platformEth: ethWei },
        description: 'Native-ETH claims allocated between project and platform. Do not add these amounts again to ProjectFeeAccrued.feeEth or call them paid revenue.',
      }),
      clausHookDefinition({
        key: 'buybackBurnRecorded', label: 'Buyback and burn recorded', classification: 'executed',
        signature: 'event BuybackBurn(bytes32 indexed poolId, address indexed sender, uint256 spentEth, uint256 burnedTokens, uint256 pendingEth)',
        amountField: 'burnedTokens', poolField: 'poolId', unit: 'raw-token-units', asset: CLAUS_TOKEN,
        receiptProof: { kind: 'erc20_transfer', token: CLAUS_TOKEN, from: CLAUS_HOOK,
          to: '0x0000000000000000000000000000000000000000', amountField: 'burnedTokens' },
        fieldUnits: { spentEth: ethWei, burnedTokens: clausUnits, pendingEth: ethWei },
        description: 'Hook-emitted processor record. burnedTokens is raw CLAUS units; spentEth and pendingEth are wei. sender is the executor, not a payee. Confirm the same-transaction CLAUS Transfer from this hook to zero before labeling the burn receipt-reconciled.',
      }),
      clausHookDefinition({
        key: 'fomoBuybackRecorded', label: 'FOMO token purchase recorded', classification: 'transferred',
        signature: 'event FomoBuyback(bytes32 indexed poolId, address indexed recipient, uint256 spentEth, uint256 sentTokens, uint256 pendingEth)',
        amountField: 'sentTokens', recipientField: 'recipient', poolField: 'poolId', unit: 'raw-token-units', asset: CLAUS_TOKEN,
        fieldUnits: { spentEth: ethWei, sentTokens: clausUnits, pendingEth: ethWei },
        description: 'Purchased tokens recorded as sent to the named recipient, not burned. Reconcile the token Transfer in this transaction separately; never merge sentTokens into burn totals.',
      }),
      clausHookDefinition({
        key: 'nftFeesAccrued', label: 'NFT fee allocation recorded', classification: 'accrued',
        signature: 'event NftFeeAccrued(uint256 grossEth, uint256 nftEth, uint256 epoch)',
        amountField: 'nftEth', unit: 'wei', asset: 'ETH',
        fieldUnits: { grossEth: ethWei, nftEth: ethWei, epoch: { unit: 'count' } },
        description: 'Fee credited to the NFT reward pot. This is not a holder payment. The collection also emits an accrual record for the same funds; do not count both as new revenue.',
      }),
      clausHookDefinition({
        key: 'liquidityAddedRecorded', label: 'Liquidity addition recorded', classification: 'executed',
        signature: 'event LiquidityAdded(uint256 indexed tokenId, uint128 liquidity, uint256 ethAdded, uint256 tokensAdded, uint256 buyEth)',
        amountField: 'ethAdded', unit: 'wei', asset: 'ETH',
        fieldUnits: { ethAdded: ethWei, tokensAdded: clausUnits, buyEth: ethWei, liquidity: { unit: 'raw-liquidity-units' } },
        description: 'Processor-recorded position addition. ethAdded excludes buyEth spent acquiring tokens; tokensAdded is raw CLAUS, while liquidity is a liquidity unit, not a token amount or USD.',
      }),
      clausNftEvent({
        key: 'nftRewardsAccrued', label: 'NFT reward pot credited', classification: 'accrued',
        signature: 'event NftRewardAccrued(uint256 indexed epoch, uint256 amount)',
        fieldUnits: { amount: ethWei, epoch: { unit: 'count' } },
        description: 'Reward-accounting record of the same NFT allocation recorded at the hook. Not a second charge and not a completed holder payment.',
      }),
      clausNftEvent({
        key: 'nftRewardPaymentRecorded', label: 'NFT holder payment recorded', classification: 'transferred',
        signature: 'event NftRewardPaid(uint256 indexed epoch, address indexed account, uint256 amount)',
        recipientField: 'account', fieldUnits: { amount: ethWei, epoch: { unit: 'count' } },
        description: 'The verified NFT reward contract emits this only after its native-ETH call succeeds. It is a contract-reported payment to account, not an independently reconciled recipient balance total.',
      }),
      clausNftEvent({
        key: 'nftRewardPaymentDeferred', label: 'NFT holder payment deferred', classification: 'deferred',
        signature: 'event NftRewardDeferred(uint256 indexed epoch, address indexed account, uint256 amount)',
        recipientField: 'account', fieldUnits: { amount: ethWei, epoch: { unit: 'count' } },
        description: 'Native-ETH payment failed and the paid counters were restored. This amount remains owed; exclude it from all paid-reward or reconciled-payment totals.',
      }),
    ],
  },
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
  hookr: {
    version: 1,
    label: 'Hookr 1 source-bound launch and hook records',
    sources: [
      { label: 'Hookr 1 exact deployment manifest', url: HOOKR_MANIFEST },
      { label: 'Hookr 1 release documentation', url: HOOKR_RELEASE_DOCS },
      { label: 'HookrLauncher source at release commit', url: HOOKR_LAUNCHER_SOURCE },
      { label: 'HookrRoot source at release commit', url: HOOKR_ROOT_SOURCE },
    ],
    reads: [
      hookrLauncherDefinition({
        key: 'launcherPoolManager', label: 'Launcher PoolManager', signature: 'poolManager()', returns: 'address',
        classification: 'configuration',
        description: 'PoolManager every family pool uses. This is immutable wiring, not an activity count or safety endorsement.',
      }),
      hookrLauncherDefinition({
        key: 'launcherRegistry', label: 'Launcher registry', signature: 'registry()', returns: 'address',
        classification: 'configuration',
        description: 'Registry that admits roots, quotes, and modules for this launcher. Admission is not a Hookline verification.',
      }),
      hookrRootDefinition({
        key: 'rootPoolManager', label: 'Root PoolManager', signature: 'poolManager()', returns: 'address',
        classification: 'configuration',
        description: 'PoolManager bound immutably to the shared Hookr root.',
      }),
      hookrRootDefinition({
        key: 'rootRegistry', label: 'Root registry', signature: 'registry()', returns: 'address',
        classification: 'configuration',
        description: 'Registry bound immutably to the shared root. It governs admissions for new Hookr pools, not existing pool terms.',
      }),
      hookrRootDefinition({
        key: 'rootRouter', label: 'Authenticated router', signature: 'router()', returns: 'address',
        classification: 'configuration',
        description: 'Router whose runtime code hash is pinned by the root. This address is configuration, not a promise that every route succeeds.',
      }),
      hookrRootDefinition({
        key: 'rootQuoter', label: 'Hookr quoter', signature: 'quoter()', returns: 'address',
        classification: 'configuration',
        description: 'Quoter wired into this root. Quotes remain point-in-time computations rather than execution receipts.',
      }),
      hookrRootDefinition({
        key: 'rootCuratedRouter', label: 'Curated router', signature: 'curatedRouter()', returns: 'address',
        classification: 'configuration',
        description: 'Curated router address pinned by the root. It is distinct from the general authenticated router.',
      }),
      hookrRootDefinition({
        key: 'burnAddress', label: 'Auto Burn destination', signature: 'DEAD()', returns: 'address',
        classification: 'configuration',
        description: 'Destination used by the source-defined Auto Burn path. A configured destination does not prove any amount was burned.',
      }),
    ],
    events: [
      hookrLauncherDefinition({
        key: 'familyLaunched', label: 'Market family launched', classification: 'executed',
        signature: 'event FamilyLaunched(bytes32 indexed familyId,address indexed owner,address indexed subject,address root)',
        deploymentField: 'subject', hookField: 'root', fieldLabels: { owner: 'First family owner' },
        description: 'The launcher recorded a subject market family and its first owner on the named root. The subject may be newly created or existing, so this is not always a token deployment.',
      }),
      hookrLauncherDefinition({
        key: 'memberLaunched', label: 'Family pool opened', classification: 'executed',
        signature: 'event MemberLaunched(bytes32 indexed familyId,uint8 member,bytes32 indexed poolId,address quote,uint128 liquidity)',
        poolField: 'poolId', assetField: 'quote',
        fieldLabels: { member: 'Family member', liquidity: 'Launch liquidity' },
        fieldUnits: { member: { unit: 'index' }, liquidity: { unit: 'raw-liquidity-units' } },
        description: 'A family member pool opened with its launch position. Liquidity is a v4 liquidity unit, not token quantity or USD value.',
      }),
      hookrLauncherDefinition({
        key: 'devBuyExecuted', label: 'Launch dev buy executed', classification: 'executed',
        signature: 'event DevBuyExecuted(bytes32 indexed familyId,bytes32 indexed poolId,address indexed buyer,uint8 member,uint256 quoteIn,uint256 subjectOut,uint160 sqrtPriceX96,uint160 sqrtPriceAfterX96,uint256 lockedUntil)',
        poolField: 'poolId',
        fieldLabels: { buyer: 'Family owner and buyer', member: 'Family member', quoteIn: 'Quote spent', subjectOut: 'Subject received', sqrtPriceX96: 'Opening sqrt price', sqrtPriceAfterX96: 'Post-buy sqrt price', lockedUntil: 'Principal unlock block' },
        fieldUnits: { quoteIn: { unit: 'raw-token-units' }, subjectOut: { unit: 'raw-token-units' }, sqrtPriceX96: { unit: 'sqrt-price-x96' }, sqrtPriceAfterX96: { unit: 'sqrt-price-x96' }, lockedUntil: { unit: 'block' } },
        description: 'The family owner completed the documented launch buy. Quote and subject amounts use different assets and remain raw units; prices require token ordering and decimals before comparison.',
      }),
      hookrLauncherDefinition({
        key: 'launchFeeSet', label: 'Launch fee configuration changed', classification: 'configured',
        signature: 'event LaunchFeeSet(uint256 fee,address treasury)',
        amountField: 'fee', unit: 'wei', asset: 'ETH', fieldLabels: { treasury: 'Treasury contract' },
        description: 'Fee and treasury configuration for future launches. The treasury contract may resolve a separate payment target, so this is not a transfer.',
      }),
      hookrLauncherDefinition({
        key: 'launchFeePaid', label: 'Launch fee payment recorded', classification: 'transferred',
        signature: 'event LaunchFeePaid(bytes32 indexed familyId,address indexed target,uint256 fee)',
        amountField: 'fee', recipientField: 'target', unit: 'wei', asset: 'ETH',
        description: 'Launcher-recorded native launch-fee payment to the resolved target. It is transaction-level contract evidence, not a lifetime total.',
      }),
      hookrLauncherDefinition({
        key: 'familyTransferred', label: 'Family ownership transferred', classification: 'configured',
        signature: 'event FamilyTransferred(bytes32 indexed familyId,address indexed owner)',
        fieldLabels: { owner: 'New family owner' },
        description: 'A pending family transfer completed. This changes control of that family, not ownership of Hookr as a project.',
      }),
      hookrRootDefinition({
        key: 'poolOpened', label: 'Hookr pool opened', classification: 'executed',
        signature: 'event PoolOpened(bytes32 indexed id,address indexed launcher,bytes32 indexed policyHash,address rules,address advisory)',
        poolField: 'id',
        fieldLabels: { launcher: 'Launcher', policyHash: 'Frozen policy hash', rules: 'Rules contract', advisory: 'Advisory contract' },
        description: 'The shared root recorded a new pool and the commitment to its pool key, configuration, and module data. Rules and advisory identify mechanisms, not an investment rating.',
      }),
      hookrRootDefinition({
        key: 'hookFee', label: 'Hook fee outcome recorded', classification: 'executed',
        signature: 'event HookFee(bytes32 indexed id,address indexed quote,uint256 earned,uint256 refund,uint256 burned)',
        poolField: 'id', assetField: 'quote',
        fieldLabels: { earned: 'Hook fee paid', refund: 'Quote refunded', burned: 'Subject burned' },
        fieldUnits: { earned: hookrRawCurrency, refund: hookrRawCurrency, burned: { unit: 'raw-token-units', basis: 'pool subject' } },
        description: 'Per-swap contract record separating quote fee earned, quote refunded, and subject burned. Earned and refund use the indexed quote currency; burned uses the other pool asset, so the fields must not be summed.',
      }),
      hookrRootDefinition({
        key: 'poolLane', label: 'Arb recapture lane fixed', classification: 'configured',
        signature: 'event PoolLane(bytes32 indexed id,address indexed executor,bytes32 codeHash,uint16 partnerBps,bytes32 family)',
        poolField: 'id',
        fieldLabels: { executor: 'Lane executor', codeHash: 'Frozen executor code hash', partnerBps: 'Partner share', family: 'Lane family' },
        fieldUnits: { partnerBps: { unit: 'bps', denominator: 10000 } },
        description: 'Pool initialization froze the executor, its runtime code hash, partner share, and optional lane family. This is configuration, not realized arbitrage profit.',
      }),
      hookrRootDefinition({
        key: 'recaptureSucceeded', label: 'Arb recapture push recorded', classification: 'executed',
        signature: 'event CorrectionSucceeded(bytes32 indexed id,uint8 indexed phase,address indexed trader,uint256 reportedProfit,uint256 pushed,address currency)',
        poolField: 'id', assetField: 'currency',
        fieldLabels: { phase: 'Recapture phase', trader: 'Authenticated trader', reportedProfit: 'Executor-reported profit', pushed: 'Amount pushed' },
        fieldValueLabels: { phase: { 1: 'Before quote', 2: 'After settlement' } },
        fieldUnits: { reportedProfit: { unit: 'raw-token-units', assetField: 'currency' }, pushed: { unit: 'raw-token-units', assetField: 'currency' } },
        description: 'The executor completed a recapture push. Reported profit follows the contract formula and is explicitly not proof of the executor\'s real arbitrage profit.',
      }),
      hookrRootDefinition({
        key: 'recaptureFailed', label: 'Arb recapture attempt failed', classification: 'executed',
        signature: 'event CorrectionFailed(bytes32 indexed id,uint8 indexed phase,address indexed trader,bytes4 reason)',
        poolField: 'id',
        fieldLabels: { phase: 'Recapture phase', trader: 'Authenticated trader', reason: 'Revert selector' },
        fieldValueLabels: { phase: { 1: 'Before quote', 2: 'After settlement' } },
        description: 'The optional recapture frame failed and was unwound while the swap continued. This is a recorded non-success outcome for the module, not a failed swap.',
      }),
      hookrRootDefinition({
        key: 'laneCodeChanged', label: 'Lane executor code mismatch detected', classification: 'configured',
        signature: 'event LaneCodeChanged(bytes32 indexed id,uint8 indexed phase)',
        poolField: 'id', fieldLabels: { phase: 'Recapture phase' }, fieldValueLabels: { phase: { 1: 'Before quote' } },
        description: 'The root skipped the recapture lane because the executor runtime no longer matched the code hash frozen at pool opening. The underlying swap may still continue.',
      }),
    ],
  },
  doppler: {
    version: 1,
    label: 'Doppler canonical Airlock launch records',
    sources: [
      { label: 'Canonical deployment directory', url: 'https://docs.doppler.lol/reference/contract-addresses' },
      { label: 'Base Airlock source at deployment commit', url: 'https://raw.githubusercontent.com/whetstoneresearch/doppler/9b23399/src/Airlock.sol' },
      { label: 'Robinhood Airlock source at deployment commit', url: 'https://raw.githubusercontent.com/whetstoneresearch/doppler/bda077cf/src/Airlock.sol' },
    ],
    reads: [],
    events: [...dopplerAirlockEvents(8453), ...dopplerAirlockEvents(4663)],
  },
  angstrom: {
    version: 1,
    label: 'Angstrom verified Ethereum controller',
    sources: [
      { label: 'Official Angstrom deployment directory', url: 'https://docs.angstrom.xyz/contracts/deployments' },
      { label: 'Verified ControllerV1 source', url: ANGSTROM_CONTROLLER_SOURCE },
    ],
    reads: [
      angstromControllerDefinition({
        key: 'angstromHook', label: 'Controlled Angstrom hook', signature: 'ANGSTROM()', returns: 'address',
        classification: 'configuration',
        description: 'Hook address bound immutably to this controller. The official deployment directory separately identifies the same Ethereum hook.',
      }),
      angstromControllerDefinition({
        key: 'controllerOwner', label: 'Controller owner', signature: 'owner()', returns: 'address',
        classification: 'configuration',
        description: 'Current owner of ControllerV1. This authority can configure pools, distribute fees, and propose a replacement controller; it is not a fee recipient by itself.',
      }),
      angstromControllerDefinition({
        key: 'fastOwner', label: 'Fast owner', signature: 'fastOwner()', returns: 'address',
        classification: 'configuration',
        description: 'Immutable operational authority used by the verified controller for bounded pool and node actions. This is not a project ownership claim.',
      }),
      angstromControllerDefinition({
        key: 'pendingController', label: 'Pending replacement controller', signature: 'setController()', returns: 'address',
        classification: 'configuration', zeroLabel: 'No pending controller',
        description: 'Address currently allowed to accept controller authority. The zero address means no replacement is pending at the observed block.',
      }),
      angstromControllerDefinition({
        key: 'configuredPools', label: 'Configured pools', signature: 'totalPools()', returns: 'uint256',
        classification: 'configuration', unit: 'count',
        description: 'Number of pool entries retained by ControllerV1 at the observed block. It is not volume, liquidity, or a count of all Angstrom deployments.',
      }),
      angstromControllerDefinition({
        key: 'authorizedNodes', label: 'Authorized nodes', signature: 'totalNodes()', returns: 'uint256',
        classification: 'configuration', unit: 'count',
        description: 'Number of active nodes in the controller set. It does not measure node performance or decentralization.',
      }),
    ],
    events: [
      angstromControllerDefinition({
        key: 'poolConfigured', label: 'Pool configuration recorded', classification: 'configured',
        signature: 'event PoolConfigured(address indexed asset0,address indexed asset1,uint16 tickSpacing,uint24 bundleFee,uint24 unlockedFee,uint24 protocolUnlockedFee)',
        fieldLabels: { bundleFee: 'Bundle fee', unlockedFee: 'Unlocked fee', protocolUnlockedFee: 'Protocol unlocked fee' },
        fieldUnits: { bundleFee: angstromFeeUnit, unlockedFee: angstromFeeUnit, protocolUnlockedFee: angstromFeeUnit },
        description: 'ControllerV1 recorded the pair, tick spacing, and three fee parameters. Fee values are millionths; configuration is not proof that a swap paid each component.',
      }),
      angstromControllerDefinition({
        key: 'poolBatchUpdated', label: 'Pool batch configuration changed', classification: 'configured',
        signature: 'event OpaqueBatchPoolUpdate()',
        description: 'One or more pool entries changed through the controller batch path. The event is intentionally opaque, so Hookline does not invent per-pool values from it.',
      }),
      angstromControllerDefinition({
        key: 'poolRemoved', label: 'Pool removed from controller', classification: 'configured',
        signature: 'event PoolRemoved(address indexed asset0,address indexed asset1,int24 tickSpacing,uint24 feeInE6)',
        fieldLabels: { feeInE6: 'Bundle fee at removal' }, fieldUnits: { feeInE6: angstromFeeUnit },
        description: 'ControllerV1 removed the pair and recorded its tick spacing and bundle fee at removal. This does not prove the underlying v4 pool ceased to exist.',
      }),
      angstromControllerDefinition({
        key: 'controllerAccepted', label: 'Replacement controller accepted', classification: 'configured',
        signature: 'event NewControllerAccepted(address indexed newController)', deploymentField: 'newController',
        description: 'A proposed replacement accepted authority and ControllerV1 instructed the Angstrom hook to use it. Follow the new address separately before applying any ABI.',
      }),
      angstromControllerDefinition({
        key: 'nodeAdded', label: 'Angstrom node added', classification: 'configured',
        signature: 'event NodeAdded(address indexed node)', deploymentField: 'node',
        description: 'ControllerV1 added the address to its authorized node set. This is permission evidence, not proof of subsequent order execution.',
      }),
      angstromControllerDefinition({
        key: 'nodeRemoved', label: 'Angstrom node removed', classification: 'configured',
        signature: 'event NodeRemoved(address indexed node)', deploymentField: 'node',
        description: 'ControllerV1 removed the address from its authorized node set. Historical activity remains part of the record.',
      }),
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
