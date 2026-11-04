import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  AskSettlementSet,
  CovenantMinted,
  CovenantPromiseSet,
  Kudo,
  PromiseSettlementSet,
  Transfer,
} from "../generated/Kudo/Kudo";
import { IdentityRegistry } from "../generated/Kudo/IdentityRegistry";
import { Activity, Agent, Covenant, Ownership } from "../generated/schema";
import {
  ENTRY_POINTS,
  IDENTITY_REGISTRY,
  USER_OPERATION_EVENT,
  ZERO_ADDRESS,
  covenantKey,
  decodeStatus,
  initialStatus,
  isAskOpen,
  isHidden,
  isLegacy,
  presentedStatus,
} from "./contracts";
import { loadAgent, saveCovenant } from "./state";

// Room for a block's log indexes in the Activity sort key.
const ORDER_SCALE = BigInt.fromI32(1_000_000);

/**
 * The account behind one log (kudo-client `actorOfLog`).
 *
 * Agents' gas is sponsored, so their writes arrive as ERC-4337 bundles whose
 * signer is the bundler. The account is the `sender` of the first
 * `UserOperationEvent` the EntryPoint emits after this log. A log after the
 * last such event belongs to no operation and is left unattributed (null).
 */
function actorOf(event: ethereum.Event): Address | null {
  const receipt = event.receipt;
  if (receipt === null) return event.transaction.from;

  let sawOperation = false;
  let best: Address | null = null;
  let bestIndex: BigInt | null = null;
  const logs = receipt.logs;
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if (!ENTRY_POINTS.includes(log.address.toHexString())) continue;
    if (log.topics.length < 3 || log.topics[0].toHexString() != USER_OPERATION_EVENT) continue;
    sawOperation = true;
    if (!log.logIndex.gt(event.logIndex)) continue;
    if (bestIndex === null || log.logIndex.lt(bestIndex as BigInt)) {
      bestIndex = log.logIndex;
      best = Address.fromBytes(Bytes.fromUint8Array(log.topics[2].subarray(12, 32)));
    }
  }
  return sawOperation ? best : event.transaction.from;
}

/** Bytes as text where every byte is printable ASCII, else null. */
function printable(value: Bytes): string | null {
  if (value.length == 0) return null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c < 0x20 || c > 0x7e) return null;
  }
  const text = value.toString().trim();
  return text.length > 0 ? text : null;
}

/**
 * The teeId as the agent recorded it (kudo-client `decodeTeeId`): the text
 * it wrote, or the raw hex where the bytes are not text.
 */
function decodeTeeId(value: Bytes): string | null {
  if (value.length == 0) return null;
  const text = printable(value);
  return text !== null ? text : value.toHexString();
}

/** Status and askOpen, recomputed from what the covenant now records. */
function rederive(covenant: Covenant): void {
  covenant.status = presentedStatus(
    covenant.recordedStatus,
    covenant.askSettlement,
    covenant.promiseSettlement,
  );
  covenant.askOpen = isAskOpen(covenant.status, covenant.askSettlement);
}

/** Append one row to the activity feed, with everything the row shows. */
function record(
  event: ethereum.Event,
  covenant: Covenant,
  action: string,
  actor: Bytes | null,
  status: string | null,
  detail: string | null,
  proof: string | null,
  counterparty: Bytes | null,
): void {
  const row = new Activity(event.transaction.hash.concatI32(event.logIndex.toI32()));
  row.order = event.block.number.times(ORDER_SCALE).plus(event.logIndex);
  row.action = action;
  row.covenant = covenant.id;
  row.nftId = covenant.nftId;
  row.contractAddress = covenant.contractAddress;
  row.isLegacy = covenant.isLegacy;
  row.hidden = covenant.hidden;

  row.actor = actor;
  if (actor !== null) {
    const actorAgent = Agent.load((actor as Bytes).toHexString());
    if (actorAgent !== null) row.actorName = actorAgent.name;
  }

  row.agentWallet = covenant.agentWallet;
  row.agentName = covenant.agentName;
  row.agentId = covenant.agentId;
  row.nftType = covenant.nftType;
  row.status = status;
  row.detail = detail;
  row.proof = proof;
  row.counterparty = counterparty;

  row.txHash = event.transaction.hash;
  row.txFrom = event.transaction.from;
  row.blockNumber = event.block.number;
  row.logIndex = event.logIndex;
  row.timestamp = event.block.timestamp;
  row.save();
}

/** A copy of what the rollups compare, taken before a covenant changes. */
function snapshot(covenant: Covenant): Covenant {
  const copy = new Covenant(covenant.id);
  copy.hidden = covenant.hidden;
  copy.status = covenant.status;
  copy.askOpen = covenant.askOpen;
  return copy;
}

/** Save a changed covenant through the rollups. */
function commit(event: ethereum.Event, before: Covenant, after: Covenant): void {
  after.updatedAt = event.block.timestamp;
  rederive(after);
  const agent = loadAgent(after.agentWallet, event.block.timestamp);
  saveCovenant(before, after, agent);
}

export function handleCovenantMinted(event: CovenantMinted): void {
  const contract = event.address;
  const nftId = event.params.nftId;
  const wallet = event.params.agent;
  const id = covenantKey(contract, nftId);

  // CovenantMinted leaves out the agent's ERC-8004 id. Most mints arrive
  // through an ERC-4337 smart account, so it cannot be read reliably from the
  // transaction input either; the contract is asked instead, at this block.
  let agentId: BigInt | null = null;
  let agentName: string | null = null;
  let teeId: string | null = null;
  const covenantCall = Kudo.bind(contract).try_getCovenant(nftId);
  if (!covenantCall.reverted) {
    agentId = covenantCall.value.agentId;
    const registry = IdentityRegistry.bind(Address.fromString(IDENTITY_REGISTRY));
    const nameCall = registry.try_getMetadata(covenantCall.value.agentId, "name");
    if (!nameCall.reverted) agentName = printable(nameCall.value);
    const teeCall = registry.try_getMetadata(covenantCall.value.agentId, "teeId");
    if (!teeCall.reverted) teeId = decodeTeeId(teeCall.value);
  }

  const existing = Covenant.load(id);
  const before: Covenant | null = existing === null ? null : snapshot(existing);
  const ownership = Ownership.load(id);

  const covenant = new Covenant(id);
  covenant.nftId = nftId;
  covenant.contractAddress = contract;
  covenant.isLegacy = isLegacy(contract);
  covenant.hidden = isHidden(contract, nftId);
  covenant.agent = wallet.toHexString();
  covenant.agentWallet = wallet;
  covenant.agentId = agentId;
  covenant.agentName = agentName;
  covenant.teeId = teeId;
  covenant.owner = ownership === null ? wallet : ownership.owner;
  covenant.nftType = event.params.nftType;
  covenant.ask = event.params.ask;
  covenant.promise = event.params.covenantPromise;
  covenant.promiseDetail = "";
  covenant.askSettlement = "";
  covenant.promiseSettlement = "";
  covenant.recordedStatus = initialStatus(contract);
  covenant.burned = false;
  covenant.mintedAt = event.block.timestamp;
  covenant.mintedBlock = event.block.number;
  covenant.mintedTx = event.transaction.hash;
  covenant.updatedAt = event.block.timestamp;
  rederive(covenant);

  const agent = loadAgent(wallet, event.block.timestamp);
  // Events arrive in order, so this covenant is the agent's newest: its
  // identity wins wherever it has one.
  if (agentId !== null) agent.agentId = agentId;
  if (agentName !== null) agent.name = agentName;
  if (teeId !== null) agent.teeId = teeId;
  agent.lastCovenantAt = event.block.timestamp;
  saveCovenant(before, covenant, agent);

  record(event, covenant, "minted", wallet, null, event.params.covenantPromise, null, null);
}

export function handleAskSettlementSet(event: AskSettlementSet): void {
  const covenant = Covenant.load(covenantKey(event.address, event.params.nftId));
  if (covenant === null) return;
  const before = snapshot(covenant);
  const actor = actorOf(event);

  covenant.askSettlement = event.params.askSettlement;
  covenant.promiseDetail = event.params.promiseDetails;
  covenant.askSettledAt = event.block.timestamp;
  covenant.askSettledBy = actor;
  covenant.askSettledTx = event.transaction.hash;
  commit(event, before, covenant);

  const detail = event.params.promiseDetails.length > 0 ? event.params.promiseDetails : null;
  record(event, covenant, "askSettled", actor, null, detail, event.params.askSettlement, null);
}

export function handlePromiseSettlementSet(event: PromiseSettlementSet): void {
  const covenant = Covenant.load(covenantKey(event.address, event.params.nftId));
  if (covenant === null) return;
  const before = snapshot(covenant);
  // Only the agent can settle its own promise, so an unattributable bundle
  // still names the agent (as kudo-client does).
  const resolved = actorOf(event);
  const actor: Bytes = resolved !== null ? (resolved as Bytes) : covenant.agentWallet;

  covenant.promiseSettlement = event.params.promiseSettlement;
  covenant.promiseSettledAt = event.block.timestamp;
  covenant.promiseSettledBy = actor;
  covenant.promiseSettledTx = event.transaction.hash;
  commit(event, before, covenant);

  record(event, covenant, "promiseSettled", actor, null, null, event.params.promiseSettlement, null);
}

export function handleCovenantPromiseSet(event: CovenantPromiseSet): void {
  const covenant = Covenant.load(covenantKey(event.address, event.params.nftId));
  if (covenant === null) return;
  const before = snapshot(covenant);
  const resolved = actorOf(event);
  const actor: Bytes = resolved !== null ? (resolved as Bytes) : covenant.agentWallet;

  covenant.recordedStatus = decodeStatus(event.params.status, event.address);
  commit(event, before, covenant);

  record(event, covenant, "statusChanged", actor, covenant.recordedStatus, null, null, null);
}

export function handleTransfer(event: Transfer): void {
  const from = event.params.from;
  const to = event.params.to;
  const id = covenantKey(event.address, event.params.tokenId);

  const ownership = new Ownership(id);
  ownership.owner = to;
  ownership.save();

  // The mint's own Transfer comes before CovenantMinted, which picks the
  // owner up from Ownership.
  if (from.toHexString() == ZERO_ADDRESS) return;

  const covenant = Covenant.load(id);
  if (covenant === null) return;
  const before = snapshot(covenant);

  // A covenant is burned once it is settled. It keeps its last holder as
  // owner, so the card can still say who held it, and is marked burned.
  const burned = to.toHexString() == ZERO_ADDRESS;
  if (burned) {
    covenant.burned = true;
    covenant.burnedAt = event.block.timestamp;
  } else {
    covenant.owner = to;
  }
  commit(event, before, covenant);

  record(event, covenant, burned ? "burned" : "transferred", from, null, null, null, to);
}
