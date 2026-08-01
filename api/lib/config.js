import { getAddress } from "viem";

export const XLAYER = {
  id: 196,
  network: "eip155:196",
  name: "X Layer",
  rpcUrl: process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech",
};

export const PAYMENT = {
  asset: getAddress(process.env.FOREMAN_PAYMENT_ASSET || "0x779ded0c9e1022225f8e0630b35a9b54be713736"),
  amount: process.env.FOREMAN_PRICE_ATOMIC || "100000",
  decimals: 6,
  name: process.env.FOREMAN_PAYMENT_NAME || "USD₮0",
  version: process.env.FOREMAN_PAYMENT_VERSION || "1",
  payTo: getAddress(process.env.FOREMAN_PAY_TO || "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7"),
};
