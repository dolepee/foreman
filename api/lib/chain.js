import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbiItem,
} from "viem";
import { PAYMENT, XLAYER } from "./config.js";

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export function createChainService({ client, rpcUrl = XLAYER.rpcUrl } = {}) {
  const chain = defineChain({
    id: XLAYER.id,
    name: XLAYER.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = client || createPublicClient({ chain, transport: http(rpcUrl) });

  async function verifySettlement({ txHash, payer, amountAtomic }) {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: 15_000,
    });
    if (receipt.status !== "success") throw new Error("settlement_transaction_reverted");
    const transfer = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== PAYMENT.asset.toLowerCase()) return false;
      try {
        const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
        return decoded.eventName === "Transfer"
          && decoded.args.from.toLowerCase() === payer.toLowerCase()
          && decoded.args.to.toLowerCase() === PAYMENT.payTo.toLowerCase()
          && decoded.args.value === BigInt(amountAtomic);
      } catch {
        return false;
      }
    });
    if (!transfer) throw new Error("settlement_transfer_missing");
    return {
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      asset: PAYMENT.asset,
      from: getAddress(payer),
      to: PAYMENT.payTo,
      amountAtomic: String(amountAtomic),
    };
  }

  return { verifySettlement };
}
