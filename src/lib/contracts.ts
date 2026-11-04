/**
 * The Kudo contracts on Robinhood Chain, mirroring kudo-client's
 * `src/lib/chain-list-fallback.ts`. Keep the two in step: an address added
 * there needs adding here and to config.yaml.
 */

export type CovenantStatus = "Minted" | "Ongoing" | "Completed" | "Failed";

/**
 * The status enums Kudo contracts have used, each in its own order.
 *
 * The current contract shares abi v5's signatures with the one before it but
 * restored MINTED, so the same raw uint8 means different things on each.
 * Reading one with the other's table shifts every value by one.
 */
export const STATUS_SCHEMES = {
  withMinted: ["Minted", "Ongoing", "Completed", "Failed"],
  withoutMinted: ["Ongoing", "Completed", "Failed"],
} as const satisfies Record<string, readonly CovenantStatus[]>;

export type StatusScheme = keyof typeof STATUS_SCHEMES;

export type KudoContract = {
  address: string;
  statusScheme: StatusScheme;
  isLegacy: boolean;
  /** Covenant ids the client hides outright. */
  blacklist: readonly number[];
};

const CONTRACTS: readonly KudoContract[] = [
  {
    address: "0x1930d0feab14b024353bf22ade03db989ad640c7",
    statusScheme: "withMinted",
    isLegacy: false,
    blacklist: [],
  },
  {
    address: "0xc269c6176f3418a84fcda5911723b0d358971351",
    statusScheme: "withoutMinted",
    isLegacy: true,
    blacklist: [0, 7, 8],
  },
];

const BY_ADDRESS = new Map(CONTRACTS.map((c) => [c.address, c]));

/** The contract an event came from. Throws for one config.yaml added but this file did not. */
export const kudoContract = (address: string): KudoContract => {
  const contract = BY_ADDRESS.get(address.toLowerCase());
  if (!contract) {
    throw new Error(
      `Kudo contract ${address} is in config.yaml but not in src/lib/contracts.ts`,
    );
  }
  return contract;
};

/** The same key kudo-client's `covenantKey` builds. */
export const covenantKey = (contract: string, nftId: bigint) =>
  `${contract.toLowerCase()}:${nftId.toString()}`;

/**
 * A raw status as its contract numbers it. Unknown values fall back to the
 * scheme's first member rather than halting the indexer; the raw value is
 * kept on the covenant's event row.
 */
export const decodeStatus = (raw: number, scheme: StatusScheme): CovenantStatus =>
  STATUS_SCHEMES[scheme][raw] ?? STATUS_SCHEMES[scheme][0];

/** The status a covenant starts in on its contract. */
export const initialStatus = (scheme: StatusScheme): CovenantStatus =>
  STATUS_SCHEMES[scheme][0];

/**
 * The status a covenant presents (kudo-client `presentedStatus`): a covenant
 * whose ask and promise are both settled reads Completed, unless the contract
 * has explicitly said Completed or Failed.
 */
export const presentedStatus = (
  recorded: CovenantStatus,
  askSettlement: string,
  promiseSettlement: string,
): CovenantStatus => {
  if (recorded === "Completed" || recorded === "Failed") return recorded;
  return askSettlement && promiseSettlement ? "Completed" : recorded;
};

/** The ask is still waiting to be met. */
export const isAskOpen = (status: CovenantStatus, askSettlement: string) =>
  !askSettlement && status !== "Completed" && status !== "Failed";
