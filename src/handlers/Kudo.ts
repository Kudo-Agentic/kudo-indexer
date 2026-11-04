import { indexer } from "envio";
import type { Covenant, CovenantEvent, EvmOnEventContext as HandlerContext } from "envio";
import {
  covenantKey,
  decodeStatus,
  initialStatus,
  isAskOpen,
  kudoContract,
  presentedStatus,
} from "../lib/contracts";
import { getCovenantAgent, postWebhook, webhookConfigured } from "../lib/effects";
import { loadAgent, saveCovenant } from "../lib/state";

type CovenantEventKind = CovenantEvent["kind"];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type EventMeta = {
  chainId: number;
  srcAddress: string;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: { hash: string; from: string | undefined };
};

const eventId = (event: EventMeta) => `${event.block.number}_${event.logIndex}`;

/** Status and askOpen, recomputed from what the covenant now records. */
const withDerived = (covenant: Covenant): Covenant => {
  const status = presentedStatus(
    covenant.recordedStatus,
    covenant.askSettlement,
    covenant.promiseSettlement,
  );
  return { ...covenant, status, askOpen: isAskOpen(status, covenant.askSettlement) };
};

/**
 * Append to the covenant's history and, once the indexer is live, tell the
 * webhook. Backfill never fires webhooks: those events are history, not news.
 */
const record = async (
  context: HandlerContext,
  event: EventMeta,
  covenant: Covenant,
  kind: CovenantEventKind,
  value: string,
) => {
  const id = eventId(event);
  const row = {
    id,
    covenant_id: covenant.id,
    kind,
    contract: covenant.contract,
    nftId: covenant.nftId,
    agentWallet: covenant.agentWallet,
    value,
    blockNumber: event.block.number,
    timestamp: BigInt(event.block.timestamp),
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
    txFrom: event.transaction.from?.toLowerCase() ?? "",
  };
  context.CovenantEvent.set(row);

  if (context.isPreload || !context.chain.isRealtime || !webhookConfigured()) return;
  if (covenant.hidden) return;

  const body = JSON.stringify({
    id: `${event.chainId}:${id}`,
    type: `covenant.${kind}`,
    chainId: event.chainId,
    covenantId: covenant.id,
    contract: covenant.contract,
    nftId: covenant.nftId.toString(),
    agentWallet: covenant.agentWallet,
    agentId: covenant.agentId?.toString() ?? null,
    status: covenant.status,
    askOpen: covenant.askOpen,
    value,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await context.effect(postWebhook, { id: `${event.chainId}:${id}`, body });
};

/** Apply `change` to an existing covenant and save it through the rollups. */
const update = async (
  context: HandlerContext,
  event: EventMeta,
  nftId: bigint,
  change: (covenant: Covenant) => Partial<Covenant>,
): Promise<Covenant | undefined> => {
  const id = covenantKey(event.srcAddress, nftId);
  const before = await context.Covenant.get(id);
  if (!before) {
    context.log.warn(`Event for covenant ${id}, which was never minted`);
    return undefined;
  }

  const after = withDerived({
    ...before,
    ...change(before),
    updatedAt: BigInt(event.block.timestamp),
  });
  const agent = await loadAgent(context, before.agentWallet, after.updatedAt);
  await saveCovenant(context, before, after, agent);
  return after;
};

indexer.onEvent({ contract: "Kudo", event: "CovenantMinted" }, async ({ event, context }) => {
  const contract = kudoContract(event.srcAddress);
  const { nftId, agent: wallet, nftType, covenantPromise, ask } = event.params;
  const id = covenantKey(contract.address, nftId);
  const timestamp = BigInt(event.block.timestamp);

  const [identity, ownership, existing] = await Promise.all([
    context.effect(getCovenantAgent, { contract: contract.address, nftId }),
    context.Ownership.get(id),
    context.Covenant.get(id),
  ]);

  const covenant = withDerived({
    id,
    contract: contract.address,
    nftId,
    isLegacy: contract.isLegacy,
    hidden: contract.blacklist.includes(Number(nftId)),
    agent_id: wallet,
    agentWallet: wallet,
    agentId: identity.agentId ?? undefined,
    agentName: identity.name ?? undefined,
    owner: ownership?.owner ?? wallet,
    nftType,
    ask,
    promise: covenantPromise,
    promiseDetail: "",
    askSettlement: "",
    askSettledAt: undefined,
    askSettledBy: undefined,
    askSettledTx: undefined,
    promiseSettlement: "",
    promiseSettledAt: undefined,
    promiseSettledBy: undefined,
    promiseSettledTx: undefined,
    recordedStatus: initialStatus(contract.statusScheme),
    status: "Minted",
    askOpen: true,
    mintedAt: timestamp,
    mintedBlock: event.block.number,
    mintedTx: event.transaction.hash,
    updatedAt: timestamp,
  });

  const agent = await loadAgent(context, wallet, timestamp);
  await saveCovenant(context, existing, covenant, {
    ...agent,
    // Events arrive in order, so this covenant is the agent's newest: its
    // identity wins wherever it has one.
    agentId: identity.agentId ?? agent.agentId,
    name: identity.name ?? agent.name,
    lastCovenantAt: timestamp,
  });

  await record(context, event, covenant, "Minted", ask);
});

indexer.onEvent({ contract: "Kudo", event: "AskSettlementSet" }, async ({ event, context }) => {
  const { nftId, askSettlement, promiseDetails } = event.params;
  const covenant = await update(context, event, nftId, () => ({
    askSettlement,
    promiseDetail: promiseDetails,
    askSettledAt: BigInt(event.block.timestamp),
    askSettledBy: event.transaction.from?.toLowerCase(),
    askSettledTx: event.transaction.hash,
  }));
  if (covenant) await record(context, event, covenant, "AskSettled", askSettlement);
});

indexer.onEvent({ contract: "Kudo", event: "PromiseSettlementSet" }, async ({ event, context }) => {
  const { nftId, promiseSettlement } = event.params;
  const covenant = await update(context, event, nftId, () => ({
    promiseSettlement,
    promiseSettledAt: BigInt(event.block.timestamp),
    promiseSettledBy: event.transaction.from?.toLowerCase(),
    promiseSettledTx: event.transaction.hash,
  }));
  if (covenant) await record(context, event, covenant, "PromiseSettled", promiseSettlement);
});

indexer.onEvent({ contract: "Kudo", event: "CovenantPromiseSet" }, async ({ event, context }) => {
  const { statusScheme } = kudoContract(event.srcAddress);
  const recordedStatus = decodeStatus(Number(event.params.status), statusScheme);
  const covenant = await update(context, event, event.params.nftId, () => ({ recordedStatus }));
  if (covenant) {
    await record(context, event, covenant, "StatusSet", `${recordedStatus} (${event.params.status})`);
  }
});

indexer.onEvent({ contract: "Kudo", event: "Transfer" }, async ({ event, context }) => {
  const { from, to, tokenId } = event.params;
  const id = covenantKey(event.srcAddress, tokenId);
  context.Ownership.set({ id, owner: to });

  // The mint's own Transfer comes before CovenantMinted, which picks the
  // owner up from Ownership.
  if (from === ZERO_ADDRESS) return;

  const covenant = await update(context, event, tokenId, () => ({ owner: to }));
  if (covenant) await record(context, event, covenant, "Transferred", to);
});
