// What every page needs from the one live connection.
//
// The socket, the miner and the board live in App and must survive navigation - a
// page that owned them would stop mining the moment the visitor opened /about. Pages
// read them through this context instead.
import { createContext, useContext } from "react";
import type { BoardSnapshot } from "@outmine/protocol";
import type { Owned } from "./storage";

export type Session = {
  board: BoardSnapshot;
  /** Whether the socket is up. The board keeps its last snapshot when the connection
   *  drops, so without this a dead server is indistinguishable from a quiet one - and
   *  the header cheerfully animates "0 online" at a visitor who is looking at nothing. */
  online: boolean;
  consented: boolean;
  accept: () => void;
  mineFor: string | null;
  startMining: (listingId: string) => void;
  /** A listing this browser just created. The form is deep inside the page and the
   *  panel that shows it is above the router, so the claim travels through here. */
  claim: (owned: Owned) => void;
};

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside the provider");
  return session;
}
