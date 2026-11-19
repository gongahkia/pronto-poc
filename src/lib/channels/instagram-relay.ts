export function instagramRelayRewrites(env: Record<string, string | undefined> = process.env) {
  if (!env.PRONTO_INSTAGRAM_RELAY_TARGET) return [];
  const target = new URL(env.PRONTO_INSTAGRAM_RELAY_TARGET);
  if (env.PRONTO_HOSTED_INSTAGRAM !== "1" || env.PRONTO_DEPLOYMENT_PROFILE !== "standard" ||
      env.PRONTO_HOSTED_INSTAGRAM_WORKER !== "0" || target.origin !== "https://pronto-ai-poc.onrender.com" ||
      target.username || target.password || target.search || target.hash ||
      !/^\/api\/webhooks\/instagram\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target.pathname))
    throw new Error("Instagram callback relay requires the fixed public demo target and an inactive isolated worker.");
  return [{ source: target.pathname, destination: target.toString() }];
}
