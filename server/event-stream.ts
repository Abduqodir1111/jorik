import type { ServerResponse } from "node:http";
// A stalled browser must reconnect and fetch a fresh snapshot, rather than
// accumulating an unbounded queue of events in the NAS process.
export function sendEvent(
  clients: Set<ServerResponse>,
  client: ServerResponse,
  payload: string,
) {
  if (client.destroyed || client.writableEnded) {
    clients.delete(client);
    return;
  }
  try {
    if (client.write(payload)) return;
  } catch {
    // The socket can close between the state check and write.
  }
  clients.delete(client);
  client.destroy();
}
