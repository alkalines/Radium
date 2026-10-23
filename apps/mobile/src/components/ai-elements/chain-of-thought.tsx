import { CircleCheck } from "lucide-react-native";
import { Activity, type ActivityProps } from "./activity";

/** Summary disclosure containing nested Trace steps, as in the current shadcn pattern. */
export function ChainOfThought(props: ActivityProps) {
  return <Activity icon={CircleCheck} keepMounted {...props} />;
}
