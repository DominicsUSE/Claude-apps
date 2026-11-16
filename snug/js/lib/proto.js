// Protocol versions, shared by the server (GET /api/version, hello) and the
// client. The desktop app's pinned join mode runs its own bundled client
// against a host, so the two check each other: compatible when the client's
// PROTO >= the server's MIN_CLIENT and the server's PROTO >= the client's MIN_SERVER.
export const PROTO = 12;
export const MIN_CLIENT = 12; // the oldest client this server works with
export const MIN_SERVER = 12; // the oldest server this client works with

export const compatible = (client, server) => !!server && Number(client.proto) >= Number(server.minClient) && Number(server.proto) >= Number(client.minServer);
