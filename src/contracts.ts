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
const WITH_MINTED: string[] = ["minted", "ongoing", "completed", "failed"];
const WITHOUT_MINTED: string[] = ["ongoing", "completed", "failed"];

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

/** The ask is still waiting to be met. */
export const isAskOpen = (status: string, askSettlement: string): boolean =>
  askSettlement.length == 0 && status != "completed" && status != "failed";

/** The ERC-4337 EntryPoints (v0.6, v0.7, v0.8), as in kudo-client's user-operations.ts. */
export const ENTRY_POINTS: string[] = [
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
  "0x0000000071727de22e5e9d8baf0edac6f37da032",
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
];

/** UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256); `sender` is topic 2. */
export const USER_OPERATION_EVENT =
  "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
