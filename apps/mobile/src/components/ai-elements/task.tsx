import { Activity, type ActivityProps } from "./activity";

/** Completed or live work, with nested steps supplied as Trace children. */
export function Task(props: ActivityProps) {
  return <Activity keepMounted {...props} />;
}
