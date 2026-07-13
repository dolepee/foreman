import { getAddress } from "viem";

export const XLAYER = {
  id: 196,
  network: "eip155:196",
  name: "X Layer",
  rpcUrl: process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech",
};

export const PAYMENT = {
  asset: getAddress(process.env.FOREMAN_PAYMENT_ASSET || "0x779ded0c9e1022225f8e0630b35a9b54be713736"),
  amount: process.env.FOREMAN_PRICE_ATOMIC || "500000",
  decimals: 6,
  symbol: "USDT",
  name: process.env.FOREMAN_PAYMENT_NAME || "USD₮0",
  version: process.env.FOREMAN_PAYMENT_VERSION || "1",
  payTo: getAddress(process.env.FOREMAN_PAY_TO || "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7"),
};

export function paymentRequirements() {
  return {
    scheme: "exact",
    network: XLAYER.network,
    asset: PAYMENT.asset,
    amount: PAYMENT.amount,
    maxAmountRequired: PAYMENT.amount,
    decimals: PAYMENT.decimals,
    symbol: PAYMENT.symbol,
    payTo: PAYMENT.payTo,
    maxTimeoutSeconds: 600,
    extra: {
      name: PAYMENT.name,
      version: PAYMENT.version,
      decimals: PAYMENT.decimals,
      symbol: PAYMENT.symbol,
      service: "Foreman Launch Readiness Pack",
    },
  };
}
