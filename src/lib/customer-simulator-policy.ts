// The protected business workspace also powers live Instagram; retire chat
// simulation independently of that shared authentication/knowledge boundary.
export function customerSimulatorEnabled(): boolean {
  return process.env.PRONTO_CUSTOMER_SIMULATOR_ENABLED !== "0";
}
