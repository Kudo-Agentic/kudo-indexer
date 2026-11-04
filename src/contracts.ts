/**
 * The Kudo contracts on Robinhood Chain, mirroring kudo-client's
 * `src/lib/chain-list-fallback.ts`. Keep the two in step: an address added
 * there needs adding here and to subgraph.yaml.
 */
import { BigInt, Bytes } from "@graphprotocol/graph-ts";

export const CURRENT = "0x1930d0feab14b024353bf22ade03db989ad640c7";
export const LEGACY = "0xc269c6176f3418a84fcda5911723b0d358971351";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// The ERC-8004 Identity Registry on Robinhood Chain (kudo-client
// src/lib/constants/contracts.ts).
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

/**
 * The status enums Kudo contracts have used, each in its own order.
 *
 * The current contract restored MINTED, which the legacy one dropped, so the
 * same raw uint8 means different things on each.
 */
const WITH_MINTED: string[] = ["Minted", "Ongoing", "Completed", "Failed"];
const WITHOUT_MINTED: string[] = ["Ongoing", "Completed", "Failed"];

const schemeFor = (contract: Bytes): string[] =>
  contract.toHexString() == LEGACY ? WITHOUT_MINTED : WITH_MINTED;

export const isLegacy = (contract: Bytes): boolean => contract.toHexString() == LEGACY;

/** Covenant ids the client hides outright. */
export function isHidden(contract: Bytes, nftId: BigInt): boolean {
  if (contract.toHexString() != LEGACY) return false;
  const id = nftId.toI32();
  return id == 0 || id == 7 || id == 8;
}

/** The same key kudo-client's `covenantKey` builds. */
export const covenantKey = (contract: Bytes, nftId: BigInt): string =>
  contract.toHexString() + ":" + nftId.toString();

/**
 * A raw status as its contract numbers it. Unknown values fall back to the
 * scheme's first member rather than halting the subgraph; the raw value is
 * kept on the event row.
 */
export function decodeStatus(raw: i32, contract: Bytes): string {
  const scheme = schemeFor(contract);
  return raw >= 0 && raw < scheme.length ? scheme[raw] : scheme[0];
}

/** The status a covenant starts in on its contract. */
export const initialStatus = (contract: Bytes): string => schemeFor(contract)[0];

/**
 * The status a covenant presents (kudo-client `presentedStatus`): a covenant
 * whose ask and promise are both settled reads Completed, unless the contract
 * has explicitly said Completed or Failed.
 */
export function presentedStatus(
  recorded: string,
  askSettlement: string,
  promiseSettlement: string,
): string {
  if (recorded == "Completed" || recorded == "Failed") return recorded;
  return askSettlement.length > 0 && promiseSettlement.length > 0 ? "Completed" : recorded;
}

/** The ask is still waiting to be met. */
export const isAskOpen = (status: string, askSettlement: string): boolean =>
  askSettlement.length == 0 && status != "Completed" && status != "Failed";
