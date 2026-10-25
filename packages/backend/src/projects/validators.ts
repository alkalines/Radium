import { v, type Infer } from "convex/values";

/** Maximum Worker folders per Project; one per Worker. */
export const MAX_PROJECT_FOLDERS = 20;

/** One Worker's absolute working directory for chats in a Project; owner-set. */
export const projectFolderValidator = v.object({
  workerId: v.string(),
  directory: v.string(),
});

/** A Project's working directory on one Worker. */
export type ProjectFolder = Infer<typeof projectFolderValidator>;
