import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  AskSettlementSet,
  CovenantMinted,
  CovenantPromiseSet,
  Kudo,
  PromiseSettlementSet,
  Transfer,
} from "../generated/Kudo/Kudo";
import { IdentityRegistry } from "../generated/Kudo/IdentityRegistry";
import { Covenant, CovenantEvent, Ownership } from "../generated/schema";
import {
  IDENTITY_REGISTRY,
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

/** Status and askOpen, recomputed from what the covenant now records. */
function rederive(covenant: Covenant): void {
  covenant.status = presentedStatus(
    covenant.recordedStatus,
    covenant.askSettlement,
    covenant.promiseSettlement,
  );
  covenant.askOpen = isAskOpen(covenant.status, covenant.askSettlement);
}

/** Append one row to the covenant's history. */
function record(event: ethereum.Event, covenant: Covenant, kind: string, value: string): void {
  const row = new CovenantEvent(event.transaction.hash.concatI32(event.logIndex.toI32()));
  row.covenant = covenant.id;
  row.kind = kind;
  row.contract = covenant.contract;
  row.nftId = covenant.nftId;
  row.agentWallet = covenant.agentWallet;
  row.value = value;
  row.blockNumber = event.block.number;
  row.timestamp = event.block.timestamp;
  row.logIndex = event.logIndex;
  row.txHash = event.transaction.hash;
  row.txFrom = event.transaction.from;
  row.save();
}

/**
 * The covenant an event is about, loaded and ready to change, or null for
 * one that was never minted. Callers change it, then call `commit`.
 */
function loadCovenant(event: ethereum.Event, nftId: BigInt): Covenant | null {
  return Covenant.load(covenantKey(event.address, nftId));
}

/** Save a changed covenant through the rollups. `before` is its row as loaded. */
function commit(event: ethereum.Event, before: Covenant, after: Covenant): void {
  after.updatedAt = event.block.timestamp;
  rederive(after);
  const agent = loadAgent(after.agentWallet, event.block.timestamp);
  saveCovenant(before, after, agent);
}

/** A copy of a covenant row, so the rollups can compare old against new. */
function snapshot(covenant: Covenant): Covenant {
  const copy = new Covenant(covenant.id);
  copy.hidden = covenant.hidden;
  copy.status = covenant.status;
  copy.askOpen = covenant.askOpen;
  return copy;
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
  const covenantCall = Kudo.bind(contract).try_getCovenant(nftId);
  if (!covenantCall.reverted) {
    agentId = covenantCall.value.agentId;
    const nameCall = IdentityRegistry.bind(Address.fromString(IDENTITY_REGISTRY)).try_getMetadata(
      covenantCall.value.agentId,
      "name",
    );
    if (!nameCall.reverted && nameCall.value.length > 0) {
      const name = nameCall.value.toString().trim();
      if (name.length > 0) agentName = name;
    }
  }

  const existing = Covenant.load(id);
  const before: Covenant | null = existing == null ? null : snapshot(existing);
  const ownership = Ownership.load(id);

  const covenant = new Covenant(id);
  covenant.contract = contract;
  covenant.nftId = nftId;
  covenant.isLegacy = isLegacy(contract);
  covenant.hidden = isHidden(contract, nftId);
  covenant.agent = wallet.toHexString();
  covenant.agentWallet = wallet;
  covenant.agentId = agentId;
  covenant.agentName = agentName;
  covenant.owner = ownership == null ? wallet : ownership.owner;
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
  agent.lastCovenantAt = event.block.timestamp;
  saveCovenant(before, covenant, agent);

  record(event, covenant, "Minted", event.params.ask);
}

export function handleAskSettlementSet(event: AskSettlementSet): void {
  const covenant = loadCovenant(event, event.params.nftId);
  if (covenant == null) return;
  const before = snapshot(covenant);

  covenant.askSettlement = event.params.askSettlement;
  covenant.promiseDetail = event.params.promiseDetails;
  covenant.askSettledAt = event.block.timestamp;
  covenant.askSettledBy = event.transaction.from;
  covenant.askSettledTx = event.transaction.hash;
  commit(event, before, covenant);

  record(event, covenant, "AskSettled", event.params.askSettlement);
}

export function handlePromiseSettlementSet(event: PromiseSettlementSet): void {
  const covenant = loadCovenant(event, event.params.nftId);
  if (covenant == null) return;
  const before = snapshot(covenant);

  covenant.promiseSettlement = event.params.promiseSettlement;
  covenant.promiseSettledAt = event.block.timestamp;
  covenant.promiseSettledBy = event.transaction.from;
  covenant.promiseSettledTx = event.transaction.hash;
  commit(event, before, covenant);

  record(event, covenant, "PromiseSettled", event.params.promiseSettlement);
}

export function handleCovenantPromiseSet(event: CovenantPromiseSet): void {
  const covenant = loadCovenant(event, event.params.nftId);
  if (covenant == null) return;
  const before = snapshot(covenant);

  const raw = event.params.status;
  covenant.recordedStatus = decodeStatus(raw, event.address);
  commit(event, before, covenant);

  record(event, covenant, "StatusSet", covenant.recordedStatus + " (" + raw.toString() + ")");
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

  const covenant = loadCovenant(event, event.params.tokenId);
  if (covenant == null) return;
  const before = snapshot(covenant);

  // A covenant is burned once it is settled. It keeps its last holder as
  // owner, so the card can still say who held it, and is marked burned.
  if (to.toHexString() == ZERO_ADDRESS) {
    covenant.burned = true;
    covenant.burnedAt = event.block.timestamp;
    commit(event, before, covenant);
    record(event, covenant, "Burned", from.toHexString());
    return;
  }

  covenant.owner = to;
  commit(event, before, covenant);
  record(event, covenant, "Transferred", to.toHexString());
}

