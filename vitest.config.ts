import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Simulated covenants do not exist on chain, so the mint-time contract
    // reads are switched off rather than left to fail against the RPC.
    env: { ENVIO_CONTRACT_READS: "off" },
  },
});
