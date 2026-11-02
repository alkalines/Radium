import { createContext } from "react";

/** The ACP Session's working directory, so tool steps can show paths relative to it. */
export const AcpSessionFolder = createContext<string | undefined>(undefined);
