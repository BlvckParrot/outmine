// What every page needs from the one live connection.
//
// The socket, the miner and the board live in App and must survive navigation - a
// page that owned them would stop mining the moment the visitor opened /about. Pages
// read them through this context instead.
import { createContext, useContext } from "react";
import type { BoardSnapshot } from "@outmine/protocol";

export type Session = {
  board: BoardSnapshot;
  consented: boolean;
  accept: () => void;
  mineFor: string | null;
  startMining: (listingId: string) => void;
};

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside the provider");
  return session;
}
