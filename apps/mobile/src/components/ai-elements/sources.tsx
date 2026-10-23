import { ArrowUpRight, Globe } from "lucide-react-native";
import { Icon } from "@/components/ui/icon";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { Activity, type ActivityProps } from "./activity";
import { SourceLink } from "./links";

/** Public source metadata supplied by the caller. */
export type Source = { url: string; title?: string };
/** A disclosure of deduplicated source links, opened in the system browser. */
export function Sources({
  sources,
  running = false,
  onError,
  ...props
}: Omit<ActivityProps, "title"> & {
  sources: Source[];
  running?: boolean;
  onError?: (error: unknown) => void;
}) {
  const unique = sources.filter(
    (source, index) => sources.findIndex((other) => other.url === source.url) === index,
  );
  return (
    <Activity
      title={`${running ? "Using" : "Used"} ${unique.length} sources`}
      icon={Globe}
      status={running ? "running" : undefined}
      {...props}
    >
      <Trace>
        {unique.map((source) => (
          <SourceLink
            key={source.url}
            href={source.url}
            onError={onError}
            accessibilityHint="Opens in your browser"
          >
            <TraceLine>
              <TraceIcon>
                <Icon as={Globe} className="size-4" />
              </TraceIcon>
              <TraceTitle>{source.title || source.url}</TraceTitle>
              <TraceIcon>
                <Icon as={ArrowUpRight} className="size-4" />
              </TraceIcon>
            </TraceLine>
          </SourceLink>
        ))}
      </Trace>
    </Activity>
  );
}
