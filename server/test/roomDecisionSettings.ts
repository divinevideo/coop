/** Ordinary settings are disabled unless a room test specifically enables one. */
export function roomDecisionSettings() {
  return {
    getRequiresPolicyForDecisions: async () => false,
    getRequiresDecisionReason: async () => false,
    getRequiresDecisionReasonOnIgnore: async () => false,
  };
}
