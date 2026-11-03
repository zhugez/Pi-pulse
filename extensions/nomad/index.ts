import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function nomad(pi: ExtensionAPI): void {
  pi.registerCommand('opencode', {
    description: 'OpenCode connection help (status); quota limits are not reset locally',
    handler: async (args, ctx) => {
      const action = args.trim() || 'status';
      ctx.ui.notify(
        action === 'status'
          ? "Nomad uses Pi's built-in OpenCode provider. Select a model with /model and configure credentials with /login. Upstream quota errors (429) are preserved; no gateway or identity rotation is used."
          : 'Usage: /opencode status. Local IP/session rotation cannot renew an upstream quota; use /login or select another authorized provider with /model.',
        'info',
      );
    },
  });
}
