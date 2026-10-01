/** Compatibility namespace. New callers use observability/aiTraces. */
export {
  getSettings,
  setSettings,
  listTraces,
  getTrace,
  getSummary,
  deleteTrace,
  getSettingsForUser,
  getSettingsForWorkspace,
  startTrace,
  finishTrace,
} from "./observability/aiTraces";
