import { createRelayHandler } from "./relay.ts";

const handler = createRelayHandler();

export default {
  fetch(request: Request): Promise<Response> {
    return handler(request);
  },
} satisfies ExportedHandler;
