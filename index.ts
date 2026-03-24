import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerVinstaCli } from "./src/cli.js";
import { createVinstaInboundBridge } from "./src/inbound-bridge.js";
import { createVinstaKeepalive } from "./src/keepalive.js";
import { createVinstaTool } from "./src/vinsta-tool.js";

const vinstaPlugin = {
  id: "vinsta",
  name: "Vinsta",
  description: "Vinsta identity, discovery, and A2A messaging for OpenClaw.",
  register(api: OpenClawPluginApi) {
    const bridge = createVinstaInboundBridge(api);
    api.registerTool(createVinstaTool(api));
    api.registerService(bridge.service);
    api.registerService(createVinstaKeepalive(api));
    api.registerCli(({ program }) => registerVinstaCli({ api, program, bridge }), {
      commands: ["vinsta"],
    });
  },
};

export default vinstaPlugin;
