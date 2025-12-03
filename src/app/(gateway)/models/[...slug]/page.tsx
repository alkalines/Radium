"use client";

import {
  ChatIcon,
  CheckIcon,
  CopyIcon,
  ServerIcon,
} from "@/components/ui/Icons";
import { MultiplyFunction } from "@/utils/math";
import { useQuery } from "convex/react";
import Providers from "@/utils/providers";
import Link from "next/link";
import { use, useRef, useState, useEffect } from "react";
import { api } from "../../../../../convex/_generated/api";
import { Doc } from "../../../../../convex/_generated/dataModel";

// Tab types
type TabType = "overview" | "providers" | "performance";

function formatContextLength(length: number): string {
  if (length >= 1000000) {
    return `${(length / 1000000).toFixed(1)}M`;
  }
  return `${Math.floor(length / 1000)}K`;
}

function formatPrice(price: number): string {
  if (price === 0) return "Free";
  if (price < 0.01) return `${price.toFixed(3)}`;
  if (price < 1) return `${price.toFixed(2)}`;
  return `${price.toFixed(2)}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded-md hover:bg-bg-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <CheckIcon className="w-4 h-4 text-green-500" />
      ) : (
        <CopyIcon className="w-4 h-4 text-text-500" />
      )}
    </button>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
        active
          ? "text-accent-main-100 border-accent-main-100"
          : "text-text-300 border-transparent hover:text-text-100 hover:border-border-300"
      }`}
    >
      {children}
    </button>
  );
}

function ExpandableDescription({ description }: { description: string | undefined }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [needsExpansion, setNeedsExpansion] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (textRef.current) {
      const lineHeight = parseFloat(getComputedStyle(textRef.current).lineHeight);
      const maxHeight = lineHeight * 2;
      setNeedsExpansion(textRef.current.scrollHeight > maxHeight + 4);
    }
  }, [description]);

  return (
    <div className="mb-4">
      <div className="flex items-start gap-2 max-w-4xl">
        <div className="relative flex-1">
          <p
            ref={textRef}
            className={`text-sm leading-relaxed transition-colors ${
              isExpanded ? "text-text-400" : "text-text-300 line-clamp-2"
            }`}
          >
            {description}
          </p>
          {/* Fade effect when collapsed */}
          {needsExpansion && !isExpanded && (
            <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-bg-000 to-transparent pointer-events-none" />
          )}
        </div>
        {needsExpansion && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex-shrink-0 p-1 text-text-500 hover:text-text-300 transition-colors rounded hover:bg-bg-200"
            aria-label={isExpanded ? "Show less" : "Show more"}
          >
            <svg
              className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// Provider type extracted from the models document
type ModelProvider = Doc<"models">["providers"][number];

// Skeleton Components for Loading State
function HeaderSkeleton() {
  return (
    <div className="mb-8 animate-pulse">
      {/* Title Row */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-3">
        <div className="h-8 md:h-10 w-80 bg-bg-300 rounded" />
        <div className="flex items-center gap-2">
          <div className="h-10 w-24 bg-bg-300 rounded-lg" />
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm mb-4">
        <div className="h-4 w-24 bg-bg-300 rounded" />
        <span className="text-text-500">/</span>
        <div className="h-4 w-32 bg-bg-300 rounded" />
      </div>

      {/* Meta Info Row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
        <div className="h-4 w-28 bg-bg-300 rounded" />
        <div className="h-4 w-24 bg-bg-300 rounded" />
        <div className="h-4 w-32 bg-bg-300 rounded" />
        <div className="h-4 w-32 bg-bg-300 rounded" />
      </div>

      {/* Description */}
      <div className="mb-4 max-w-4xl">
        <div className="h-4 w-full bg-bg-300 rounded mb-2" />
        <div className="h-4 w-3/4 bg-bg-300 rounded" />
      </div>

      {/* Tabs */}
      <div className="border-b border-border-200 mb-8">
        <div className="flex gap-1">
          <div className="h-10 w-24 bg-bg-300 rounded" />
          <div className="h-10 w-24 bg-bg-300 rounded" />
        </div>
      </div>
    </div>
  );
}

function ProviderCardSkeleton() {
  return (
    <div className="bg-bg-200 rounded-xl border border-border-200 overflow-visible relative animate-pulse">
      {/* Provider Header */}
      <div className="p-4 pr-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-bg-300" />
            <div className="h-5 w-32 bg-bg-300 rounded" />
          </div>
        </div>
      </div>

      {/* Pricing Details */}
      <div className="border-t border-border-200 p-4 bg-bg-100">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 text-sm">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i}>
              <div className="h-3 w-20 bg-bg-300 rounded mb-2" />
              <div className="h-5 w-16 bg-bg-300 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProvidersSectionSkeleton() {
  return (
    <section className="mb-12 animate-pulse">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-6 w-48 bg-bg-300 rounded" />
      </div>

      <div className="mb-6">
        <div className="h-4 w-full max-w-xl bg-bg-300 rounded" />
      </div>

      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <ProviderCardSkeleton key={i} />
        ))}
      </div>
    </section>
  );
}

function ModelDetailSkeleton() {
  return (
    <div className="min-h-screen">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <HeaderSkeleton />
        <ProvidersSectionSkeleton />
      </div>
    </div>
  );
}

// Provider Card Component
function ProviderCard({
  provider,
  expanded,
  onToggle,
}: {
  provider: ModelProvider;
  expanded: boolean;
  onToggle: () => void;
  }) {
  const [infoExpanded, setInfoExpanded] = useState(false);

  // Example data - will be integrated with database later
  const isFreeTier = parseFloat(provider.pricing.output) === 0
  const trainingData = isFreeTier
    ? Providers[provider.id].policies.trainingOnFree
    : Providers[provider.id].policies.trainingOnPaid;

  return (
    <div className="bg-bg-200 rounded-xl border border-border-200 overflow-visible relative">
      {/* Arrow button aligned to right border of card */}
      <button
        onClick={() => setInfoExpanded(!infoExpanded)}
        className="absolute -right-3 top-1/2 -translate-y-1/2 z-10 w-6 h-14 bg-bg-300 hover:bg-bg-400 border border-border-200 rounded-md flex items-center justify-center transition-colors group shadow-md"
        aria-label={
          infoExpanded ? "Collapse provider info" : "Expand provider info"
        }
      >
        <svg
          className={`w-4 h-4 text-text-400 group-hover:text-text-100 transition-all ${infoExpanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
      </button>

      {/* Provider Header */}
      <div className="p-4 pr-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-bg-300 flex items-center justify-center">
              <ServerIcon className="w-5 h-5 text-text-300" />
            </div>
            <div>
              <Link
                href={`/providers/${provider.id}`}
                className="text-text-100 font-medium hover:text-accent-main-100 transition-colors"
              >
                {Providers[provider.id]?.name}
              </Link>
            </div>
          </div>
        </div>

        {/* Stats Row */}
        {/* {<div className="flex flex-wrap items-center gap-6 text-sm">
          {/* <div className="flex items-center gap-2">
            <span className="text-text-500">Latency</span>
            <span className="text-text-100 font-medium">
              {provider.latency}s
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-500">Throughput</span>
            <span className="text-text-100 font-medium">
              {provider.throughput} tps
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-500">Uptime</span>
            <div className="flex items-center gap-1.5">
              <div className="flex gap-0.5">
                {Array(7)
                  .fill(0)
                  .map((_, i) => (
                    <div
                      key={i}
                      className="w-1.5 h-3 rounded-sm bg-green-500"
                    />
                  ))}
              </div>
              <span className="text-text-100 font-medium">
                {provider.uptime}%
              </span>
            </div>
          </div> * /}
          <button
            onClick={onToggle}
            className="ml-auto text-text-400 hover:text-text-100 transition-colors"
          >
            <svg
              className={`w-5 h-5 transition-transform ${expanded ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </div>} */}
      </div>

      {/* Pricing Details */}
      {
        <div className="border-t border-border-200 p-4 bg-bg-100">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 text-sm">
            <div>
              <div className="text-text-500 mb-1">Total Context</div>
              <div className="text-text-100 font-medium">
                {formatContextLength(provider.context)}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-1">Max Output</div>
              <div className="text-text-100 font-medium">
                {formatContextLength(provider.max_output)}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-1">Input Price</div>
              <div className="text-text-100 font-medium">
                $
                {formatPrice(
                  MultiplyFunction([
                    parseFloat(provider.pricing.input),
                    1000000,
                  ])
                )}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-1">Output Price</div>
              <div className="text-text-100 font-medium">
                $
                {formatPrice(
                  MultiplyFunction([
                    parseFloat(provider.pricing.output),
                    1000000,
                  ])
                )}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-1">Cache Read</div>
              <div className="text-text-100 font-medium">
                $
                {provider.pricing.cache_read
                  ? formatPrice(
                      MultiplyFunction([
                        parseFloat(provider.pricing.cache_read),
                        1000000,
                      ])
                    )
                  : "--"}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-1">Cache Write</div>
              <div className="text-text-100 font-medium">
                {provider.pricing.cache_write
                  ? formatPrice(
                      MultiplyFunction([
                        parseFloat(provider.pricing.cache_write),
                        1000000,
                      ])
                    )
                  : "--"}
              </div>
            </div>
          </div>
        </div>
      }

      {/* Expanded Provider Info Panel */}
      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          infoExpanded ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="border-t border-border-200 p-4 bg-bg-100/50">
          <h4 className="text-sm font-medium text-text-100 mb-3">
            Provider Information
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div className="md:col-span-2">
              <div className="text-text-500 mb-1.5">Supported Parameters</div>
              <div className="flex flex-wrap gap-1.5">
                {/* Example data - will be integrated with database later */}
                {provider.supported_parameters.map((param) => (
                  <span
                    key={param}
                    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-bg-300 text-text-200 border border-border-200"
                  >
                    {param}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-0.5">Headquarters Location</div>
              <div className="text-text-100">
                {Providers[provider.id]?.headquarters || "Not available"}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-0.5">Base URL</div>
              <div className="text-text-100 font-mono text-xs break-all">
                {Providers[provider.id]?.defaultBaseURL || "Not available"}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-0.5">Moderation Policy</div>
              <div className="text-text-100">
                {provider.moderated
                  ? "Not moderated"
                  : "Moderated by the provider"}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-0.5">Prompt Training</div>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    trainingData
                      ? "bg-red-500/20 text-red-400"
                      : "bg-green-500/20 text-green-400"
                  }`}
                >
                  {trainingData ? "Yes" : "No"}
                </span>
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-0.5">Privacy Policy</div>
              {Providers[provider.id]?.policies.privacy_policy ? (
                <a
                  href={Providers[provider.id]?.policies.privacy_policy}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-main-100 hover:underline inline-flex items-center gap-1"
                >
                  View Policy
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </a>
              ) : (
                <span className="text-text-100">Not available</span>
              )}
            </div>
            <div>
              <div className="text-text-500 mb-0.5">Terms of Service</div>
              {Providers[provider.id]?.policies.tos ? (
                <a
                  href={Providers[provider.id]?.policies.tos}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-main-100 hover:underline inline-flex items-center gap-1"
                >
                  View Terms
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </a>
              ) : (
                <span className="text-text-100">Not available</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Performance Chart Placeholder
/* function PerformanceChart({
  title,
  data,
  unit,
}: {
  title: string;
  data: { [key: string]: number };
  unit: string;
}) {
  const entries = Object.entries(data);
  const maxValue = Math.max(...entries.map(([, v]) => v));

  return (
    <div className="bg-bg-200 rounded-xl border border-border-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-text-100 font-medium">{title}</h4>
        <button className="p-1 hover:bg-bg-300 rounded transition-colors">
          <svg className="w-4 h-4 text-text-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </button>
      </div>

      {/* Simple bar chart * /}
      <div className="h-24 flex items-end gap-2 mb-4">
        {entries.map(([key, value]) => (
          <div key={key} className="flex-1 flex flex-col items-center">
            <div
              className="w-full bg-accent-main-100/60 rounded-t"
              style={{ height: `${(value / maxValue) * 100}%` }}
            />
          </div>
        ))}
      </div>

      {/* Legend * /}
      <div className="flex flex-wrap gap-4">
        {entries.map(([key, value]) => (
          <button
            key={key}
            className="flex items-center gap-2 text-sm hover:bg-bg-300 px-2 py-1 rounded transition-colors"
          >
            <div className="w-3 h-3 rounded bg-accent-main-100" />
            <span className="text-text-200 capitalize">{key}</span>
            <span className="text-text-400">
              Avg {value} {unit}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
} */

// Providers Section
function ProvidersSection({ modelInfo }: { modelInfo: Doc<"models"> }) {
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  return (
    <section className="mb-12">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold text-text-100">
          Providers for this model
        </h2>
        <Link
          href={`/models/${modelInfo?.slug}/providers`}
          className="p-1 hover:bg-bg-300 rounded transition-colors"
        >
          <svg
            className="w-4 h-4 text-text-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
            />
          </svg>
        </Link>
      </div>

      <p className="text-text-300 text-sm mb-6">
        Radium{" "}
        <Link
          href="/docs/provider-routing"
          className="text-accent-main-100 hover:underline"
        >
          routes requests
        </Link>{" "}
        to the best providers that are able to handle your prompt size and
        parameters, with fallbacks to maximize{" "}
        <Link
          href={`/models/${modelInfo?.slug}/uptime`}
          className="text-accent-main-100 hover:underline"
        >
          uptime
        </Link>
        .
      </p>

      <div className="space-y-3">
        {modelInfo?.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            expanded={expandedProvider === provider.id}
            onToggle={() =>
              setExpandedProvider(
                expandedProvider === provider.id ? null : provider.id
              )
            }
          />
        ))}
      </div>
    </section>
  );
}

// Performance Section
/* function PerformanceSection() {
  return (
    <section className="mb-12">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold text-text-100">
          Performance for {STATIC_MODEL.name}
        </h2>
        <Link
          href={`/models/${STATIC_MODEL.author.id}/${STATIC_MODEL.slug}/performance`}
          className="p-1 hover:bg-bg-300 rounded transition-colors"
        >
          <svg className="w-4 h-4 text-text-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </Link>
      </div>

      <p className="text-text-300 text-sm mb-6">
        Compare different providers across Radium
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <PerformanceChart
          title="Throughput"
          data={STATIC_MODEL.performance.throughput}
          unit="tok/s"
        />
        <PerformanceChart
          title="Latency"
          data={STATIC_MODEL.performance.latency}
          unit="s"
        />
        <PerformanceChart
          title="E2E Latency"
          data={STATIC_MODEL.performance.e2e_latency}
          unit="s"
        />
      </div>
    </section>
  );
} */

// Activity Section
/* function ActivitySection() {
  return (
    <section className="mb-12">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold text-text-100">
          Recent activity on {STATIC_MODEL.name}
        </h2>
        <Link
          href={`/models/${STATIC_MODEL.author.id}/${STATIC_MODEL.slug}/activity`}
          className="p-1 hover:bg-bg-300 rounded transition-colors"
        >
          <svg className="w-4 h-4 text-text-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </Link>
      </div>

      <p className="text-text-300 text-sm mb-6">Total usage per day on Radium</p>

      {/* Activity Chart Placeholder * /}
      <div className="bg-bg-200 rounded-xl border border-border-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <select className="bg-bg-300 border border-border-200 rounded-lg px-3 py-1.5 text-sm text-text-200">
            <option>Tokens</option>
            <option>Requests</option>
          </select>
        </div>
        <div className="h-48 flex items-end justify-between gap-1">
          {/* Static heights to avoid hydration mismatch * /}
          {[45, 62, 38, 75, 52, 88, 41, 67, 55, 72, 48, 83, 36, 91, 58, 69, 44, 77, 63, 85, 50, 73, 39, 81, 56, 68, 42, 79, 60, 87].map((height, i) => (
              <div
                key={i}
                className="flex-1 bg-accent-main-100/40 rounded-t"
                style={{ height: `${height}%` }}
              />
            ))}
        </div>
        <div className="flex justify-between mt-2 text-xs text-text-500">
          <span>Sep 4</span>
          <span>Oct 4</span>
          <span>Nov 4</span>
          <span>Dec 1</span>
        </div>
      </div>
    </section>
  );
} */

// Quickstart/API Section
/* function QuickstartSection() {
  const modelId = `${STATIC_MODEL.author.id}/${STATIC_MODEL.slug}`;

  const codeExamples = {
    "openai-typescript": `import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "https://radium.example.com/api/openai/v1",
  apiKey: process.env.RADIUM_API_KEY,
});

async function main() {
  const completion = await openai.chat.completions.create({
    model: "${modelId}",
    messages: [
      { role: "user", content: "Hello!" }
    ],
  });

  console.log(completion.choices[0].message);
}

main();`,
    typescript: `const response = await fetch("https://radium.example.com/api/openai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${process.env.RADIUM_API_KEY}\`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "${modelId}",
    messages: [
      { role: "user", content: "Hello!" }
    ]
  })
});

const data = await response.json();
console.log(data.choices[0].message);`,
    "openai-python": `from openai import OpenAI

client = OpenAI(
    base_url="https://radium.example.com/api/openai/v1",
    api_key=os.environ.get("RADIUM_API_KEY"),
)

completion = client.chat.completions.create(
    model="${modelId}",
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
)

print(completion.choices[0].message)`,
    python: `import requests

response = requests.post(
    url="https://radium.example.com/api/openai/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {RADIUM_API_KEY}",
        "Content-Type": "application/json"
    },
    json={
        "model": "${modelId}",
        "messages": [
            {"role": "user", "content": "Hello!"}
        ]
    }
)

print(response.json())`,
    curl: `curl https://radium.example.com/api/openai/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $RADIUM_API_KEY" \\
  -d '{
    "model": "${modelId}",
    "messages": [
      {
        "role": "user",
        "content": "Hello!"
      }
    ]
  }'`,
  };

  const [selectedLang, setSelectedLang] = useState<keyof typeof codeExamples>("openai-typescript");

  return (
    <section className="mb-12">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold text-text-100">
          Sample code and API for {STATIC_MODEL.name}
        </h2>
        <Link
          href={`/models/${STATIC_MODEL.author.id}/${STATIC_MODEL.slug}/api`}
          className="p-1 hover:bg-bg-300 rounded transition-colors"
        >
          <svg className="w-4 h-4 text-text-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </Link>
      </div>

      <p className="text-text-300 text-sm mb-2">
        Radium normalizes requests and responses across providers for you.
      </p>

      <Link
        href="/settings/keys"
        className="inline-flex items-center gap-2 px-4 py-2 bg-accent-main-100 text-white rounded-lg hover:bg-accent-main-200 transition-colors text-sm font-medium mb-6"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
        </svg>
        Create API key
      </Link>

      <p className="text-text-300 text-sm mb-6">
        Radium provides an OpenAI-compatible completion API to 400+ models & providers that you can
        call directly, or using the OpenAI SDK. Additionally, some third-party SDKs are available.
      </p>

      {/* Language Tabs * /}
      <div className="flex flex-wrap gap-1 mb-4 border-b border-border-200">
        {(Object.keys(codeExamples) as Array<keyof typeof codeExamples>).map((lang) => (
          <button
            key={lang}
            onClick={() => setSelectedLang(lang)}
            className={`px-3 py-2 text-sm transition-colors border-b-2 -mb-px ${
              selectedLang === lang
                ? "text-accent-main-100 border-accent-main-100"
                : "text-text-400 border-transparent hover:text-text-200"
            }`}
          >
            {lang}
          </button>
        ))}
      </div>

      {/* Code Block * /}
      <div className="relative">
        <pre className="p-4 bg-bg-200 rounded-lg border border-border-200 overflow-x-auto">
          <code className="text-sm text-text-200 font-mono whitespace-pre">
            {codeExamples[selectedLang]}
          </code>
        </pre>
        <div className="absolute top-3 right-3">
          <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-bg-300 hover:bg-bg-400 rounded-md text-sm text-text-300 transition-colors">
            <CopyIcon className="w-4 h-4" />
            Copy
          </button>
        </div>
      </div>

      {/* Additional Info * /}
      <div className="mt-6">
        <h3 className="text-base font-medium text-text-100 mb-2">Using third-party SDKs</h3>
        <p className="text-text-300 text-sm">
          For information about using third-party SDKs and frameworks with Radium, please see our{" "}
          <Link href="/docs/frameworks" className="text-accent-main-100 hover:underline">
            frameworks documentation
          </Link>
          .
        </p>
        <p className="text-text-300 text-sm mt-2">
          See the{" "}
          <Link href="/docs/api-reference" className="text-accent-main-100 hover:underline">
            Request docs
          </Link>{" "}
          for all possible fields, and{" "}
          <Link href="/docs/parameters" className="text-accent-main-100 hover:underline">
            Parameters
          </Link>{" "}
          for explanations of specific sampling parameters.
        </p>
      </div>
    </section>
  );
} */

// Overview Tab Content (shows all sections like OpenRouter)
function OverviewTab({ modelInfo }: { modelInfo: Doc<"models"> }) {
  return (
    <div>
      <ProvidersSection modelInfo={modelInfo} />
      {/* <PerformanceSection /> */}
      {/* <ActivitySection /> */}
      {/* <QuickstartSection /> */}
    </div>
  );
}

// Standalone Providers Tab Content
function ProvidersTab({ modelInfo }: { modelInfo: Doc<"models"> }) {
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <p className="text-text-300">
        Radium routes requests to the best providers that are able to handle
        your prompt size and parameters, with fallbacks to maximize uptime.
      </p>

      <div className="space-y-3">
        {modelInfo?.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            expanded={expandedProvider === provider.id}
            onToggle={() =>
              setExpandedProvider(
                expandedProvider === provider.id ? null : provider.id
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

// Standalone Performance Tab Content
/* function PerformanceTab() {
  return (
    <div className="space-y-6">
      <p className="text-text-300">Compare different providers across Radium</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <PerformanceChart
          title="Throughput"
          data={STATIC_MODEL.performance.throughput}
          unit="tok/s"
        />
        <PerformanceChart
          title="Latency"
          data={STATIC_MODEL.performance.latency}
          unit="s"
        />
        <PerformanceChart
          title="E2E Latency"
          data={STATIC_MODEL.performance.e2e_latency}
          unit="s"
        />
      </div>

      {/* Detailed Stats * /}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 bg-bg-200 rounded-xl border border-border-200">
          <div className="flex items-center gap-2 mb-2">
            <ClockIcon className="w-4 h-4 text-text-500" />
            <span className="text-text-500 text-sm">Avg Latency</span>
          </div>
          <div className="text-text-100 text-2xl font-semibold">~3.3s</div>
          <div className="text-text-500 text-xs mt-1">Time to first token</div>
        </div>
        <div className="p-4 bg-bg-200 rounded-xl border border-border-200">
          <div className="flex items-center gap-2 mb-2">
            <ChartIcon className="w-4 h-4 text-text-500" />
            <span className="text-text-500 text-sm">Throughput</span>
          </div>
          <div className="text-text-100 text-2xl font-semibold">~78 tok/s</div>
          <div className="text-text-500 text-xs mt-1">Tokens per second</div>
        </div>
        <div className="p-4 bg-bg-200 rounded-xl border border-border-200">
          <div className="flex items-center gap-2 mb-2">
            <ServerIcon className="w-4 h-4 text-text-500" />
            <span className="text-text-500 text-sm">Uptime</span>
          </div>
          <div className="text-text-100 text-2xl font-semibold">100%</div>
          <div className="text-text-500 text-xs mt-1">Last 30 days</div>
        </div>
      </div>
    </div>
  );
} */

// Standalone API Tab Content
function ApiTab() {
  /* return <QuickstartSection />; */
}

export default function ModelDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [activeTab, setActiveTab] = useState<TabType>("overview");

  // Dynamic Data
  const { slug } = use(params);
  const [authorSlug, modelSlug] = slug;
  const modelInfo = useQuery(api.models.modelInfo, {
    slug: `${authorSlug}/${modelSlug}`,
  });
  const authorInfo = useQuery(api.authors.authorInfo, {
    slug: authorSlug,
  });

  // Check if data is loading (Convex useQuery returns undefined while loading)
  const isLoading = modelInfo === undefined || authorInfo === undefined;

  if (isLoading) {
    return <ModelDetailSkeleton />;
  }

  // Handle case where model or author is not found
  if (modelInfo === null || authorInfo === null) {
    return (
      <div className="min-h-screen">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="text-center py-16">
            <h1 className="text-2xl font-bold text-text-100 mb-4">Model Not Found</h1>
            <p className="text-text-300 mb-6">
              The model you&apos;re looking for doesn&apos;t exist or has been removed.
            </p>
            <Link
              href="/models"
              className="inline-flex items-center gap-2 px-4 py-2 bg-accent-main-100 text-white rounded-lg hover:bg-accent-main-200 transition-colors font-medium text-sm"
            >
              Browse Models
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          {/* Title Row */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-3">
            <h1 className="text-2xl md:text-3xl font-bold text-text-000">
              {authorInfo.name}: {modelInfo.name}
            </h1>

            {/* Action Buttons */}
            <div className="flex items-center gap-2">
              <Link
                href={`/chat?model=${modelInfo.slug}`}
                className="inline-flex items-center gap-2 px-4 py-2 bg-accent-main-100 text-white rounded-lg hover:bg-accent-main-200 transition-colors font-medium text-sm"
              >
                <ChatIcon className="w-4 h-4" />
                Chat
              </Link>
              {/* <Link
                href={`/compare/${modelInfo.slug}`}
                className="inline-flex items-center gap-2 px-4 py-2 bg-bg-200 text-text-100 rounded-lg hover:bg-bg-300 transition-colors border border-border-200 text-sm"
              >
                <ChartIcon className="w-4 h-4" />
                Compare
              </Link> */}
            </div>
          </div>

          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-sm mb-4">
            <div className="flex items-center gap-2">
              <Link
                href={`/author/${authorInfo.slug}`}
                className="text-accent-main-100 hover:underline"
              >
                {authorInfo.slug}
              </Link>
            </div>
            <span className="text-text-500">/</span>
            <span className="text-text-300">{modelInfo.slug.split("/")[1]}</span>
            <CopyButton text={modelInfo.slug} />
          </div>

          {/* Meta Info Row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-300 mb-4 text-xs text-text-400">
            <span>
              Created{" "}
              <span className="text-text-100">
                {formatDate(modelInfo.launch_date)}
              </span>
            </span>
            <span>
              <span className="text-text-100">
                {formatContextLength(modelInfo.providers[0].context)
                  .replace("K", ",000")
                  .replace("M", ",000,000")
                  .replace(/,000,000$/, "K")
                  .replace(/(\d+)K/, (_, n) => Number(n).toLocaleString())}
              </span>{" "}
              context
            </span>
            {/* Pricing Badges */}
            <span >
              <span className="text-text-300 font-medium">
                $
                {formatPrice(
                  MultiplyFunction([
                    parseFloat(modelInfo.providers[0].pricing.input),
                    1000000,
                  ])
                )}
              </span>
              /M input tokens
            </span>
            <span>
              <span className="text-text-300 font-medium">
                $
                {formatPrice(
                  MultiplyFunction([
                    parseFloat(modelInfo.providers[0].pricing.output),
                    1000000,
                  ])
                )}
              </span>
              /M output tokens
            </span>
          </div>

          {/* Description */}
          <ExpandableDescription description={modelInfo.description} />

          {/* Tabs */}
          <div className="border-b border-border-200 mb-8">
            <div className="flex gap-1">
              <Tab
                active={activeTab === "overview"}
                onClick={() => setActiveTab("overview")}
              >
                Overview
              </Tab>
              <Tab
                active={activeTab === "providers"}
                onClick={() => setActiveTab("providers")}
              >
                Providers
              </Tab>
              {/* <Tab
              active={activeTab === "performance"}
              onClick={() => setActiveTab("performance")}
            >
              Performance
            </Tab> */}
              {/* <Tab active={activeTab === "api"} onClick={() => setActiveTab("api")}>
              Quickstart
            </Tab> */}
            </div>
          </div>

          {/* Tab Content */}
          <div>
            {activeTab === "overview" && <OverviewTab modelInfo={modelInfo}/>}
            {activeTab === "providers" && (
              <ProvidersTab modelInfo={modelInfo} />
            )}
            {/* {activeTab === "performance" && <PerformanceTab />} */}
            {/* {activeTab === "api" && <ApiTab />} */}
          </div>

          {/* More models from author */}
          {/* <section className="mt-16 border-t border-border-200 pt-8">
          <div className="flex items-center gap-2 mb-6">
            <span className="text-text-300">More models from</span>
            <Link
              href={`/models?provider=${authorInfo?.slug}`}
              className="text-accent-main-100 hover:underline font-medium"
            >
              {authorInfo?.name}
            </Link>
          </div>

          {/* Model cards placeholder * /}
          {<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                name: "GPT-5",
                slug: "gpt-5",
                desc: "Most advanced model with improved reasoning",
              },
              {
                name: "GPT-5 Mini",
                slug: "gpt-5-mini",
                desc: "Compact version for lighter tasks",
              },
              {
                name: "GPT-5 Pro",
                slug: "gpt-5-pro",
                desc: "Optimized for complex reasoning tasks",
              },
            ].map((model) => (
              <Link
                key={model.slug}
                href={`/models/${STATIC_MODEL.author.id}/${model.slug}`}
                className="p-4 bg-bg-200 rounded-xl border border-border-200 hover:border-border-300 transition-colors"
              >
                <h3 className="text-text-100 font-medium mb-2">{model.name}</h3>
                <p className="text-text-400 text-sm line-clamp-2">
                  {model.desc}
                </p>
              </Link>
            ))}
          </div>}
        </section> */}
        </div>
      </div>
    </div>
  );
}
