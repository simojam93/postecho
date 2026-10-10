// Finding a port for the web app that no other program answers on, through either localhost address.
import { createServer } from "node:net";

function canListen(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (e) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT"));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * Free only when both 127.0.0.1 and ::1 are: "localhost" can resolve to either, and a program on one of them
 * would answer the agent's requests in PostEcho's place. A machine without IPv6 counts as free there.
 */
export async function portIsFree(port) {
  return (await canListen(port, "127.0.0.1")) && (await canListen(port, "::1"));
}

export async function firstFreePort(from, tries = 20) {
  for (let port = from; port < from + tries; port++) if (await portIsFree(port)) return port;
  throw new Error(`No free port between ${from} and ${from + tries - 1}.`);
}
