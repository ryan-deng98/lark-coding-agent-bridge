import { createContext, useContext } from "react";
import type { Me } from "./types";

/** Who is using the console. Admins see every bot and deployment-wide settings. */
export const MeContext = createContext<Me>({ kind: "token", admin: true });

export function useMe(): Me {
  return useContext(MeContext);
}
