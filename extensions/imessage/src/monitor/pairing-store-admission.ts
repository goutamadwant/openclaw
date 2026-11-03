import type {
  ChannelIngressContextBinding,
  ChannelIngressResolverMessageParams,
  CreateChannelIngressResolverParams,
  ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { getIMessageRuntime } from "../runtime.js";

type ResolveChannelIngress = (
  contextBinding?: ChannelIngressContextBinding,
) => Promise<ResolvedChannelMessageIngress>;

export async function resolveIMessagePairingStoreAdmission(params: {
  isGroup: boolean;
  resolver: Omit<CreateChannelIngressResolverParams, "readStoreAllowFrom">;
  message: Omit<ChannelIngressResolverMessageParams, "contextBinding">;
  readStoreAllowFrom: () => Promise<string[]>;
}): Promise<{
  accessDecision: ResolvedChannelMessageIngress;
  resolveChannelIngress: ResolveChannelIngress;
}> {
  const resolveWithStore = (
    contextBinding?: ChannelIngressContextBinding,
    storeAllowFrom?: string[],
  ) =>
    getIMessageRuntime()
      .channel.inbound.ingress.createResolver({
        ...params.resolver,
        readStoreAllowFrom: storeAllowFrom === undefined ? undefined : async () => storeAllowFrom,
      })
      .message({ ...params.message, contextBinding });

  let storeAllowFrom: string[] | undefined;
  let accessDecision = await resolveWithStore();
  if (!params.isGroup && accessDecision.senderAccess.decision === "pairing") {
    storeAllowFrom = await params.readStoreAllowFrom();
    accessDecision = await resolveWithStore(undefined, storeAllowFrom);
  }
  return {
    accessDecision,
    resolveChannelIngress: (contextBinding) => resolveWithStore(contextBinding, storeAllowFrom),
  };
}
