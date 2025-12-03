"use client";

import {
  ChatIcon,
  ChartIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  ServerIcon,
} from "@/components/ui/Icons";
import Link from "next/link";
import NextImage from "next/image";
import { useState } from "react";

// Static data for demonstration
const STATIC_MODEL = {
  slug: "gpt-5-nano",
  name: "GPT-5 Nano",
  author: {
    id: "openai",
    name: "OpenAI",
    icon: "https://openrouter.ai/images/icons/OpenAI.svg",
  },
  description:
    "GPT-5-Nano is the smallest and fastest variant in the GPT-5 system, optimized for developer tools, rapid interactions, and ultra-low latency environments. While limited in reasoning depth compared to its larger counterparts, it retains key instruction-following and safety features. It is the successor to GPT-4.1-nano and offers a lightweight option for cost-sensitive or real-time applications.",
  context_length: 400000,
  max_output: 128000,
  pricing: {
    input: "0.00000005", // $0.05/M
    output: "0.0000004", // $0.40/M
    cache_read: "0.000000005", // $0.005/M
  },
  launch_date: new Date("2025-08-07").getTime(),
  architecture: {
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    tokenizer: "o200k_base",
  },
  parameters: {
    total: "Unknown",
    active: "Unknown",
  },
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      region: "US",
      context: 400000,
      max_output: 128000,
      latency: 3.34,
      throughput: 71.72,
      uptime: 100.0,
      pricing: {
        input: "0.00000005",
        output: "0.0000004",
        cache_read: "0.000000005",
      },
      supported_parameters: [
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
        "max_tokens",
        "stop",
        "tools",
        "tool_choice",
        "response_format",
        "structured_outputs",
        "seed",
        "logprobs",
        "top_logprobs",
      ],
    },
    {
      id: "azure",
      name: "Azure",
      region: "US",
      context: 400000,
      max_output: 400000,
      latency: 3.42,
      throughput: 114.5,
      uptime: 100.0,
      pricing: {
        input: "0.00000005",
        output: "0.0000004",
        cache_read: "0.00000001",
      },
      supported_parameters: [
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
        "max_tokens",
        "stop",
        "tools",
        "tool_choice",
        "response_format",
      ],
    },
  ],
  capabilities: [
    "Instruction Following",
    "Code Generation",
    "Function Calling",
    "Structured Outputs",
    "Vision",
  ],
  performance: {
    throughput: {
      azure: 91,
      openai: 64,
    },
    latency: {
      azure: 2.95,
      openai: 3.69,
    },
    e2e_latency: {
      azure: 11.49,
      openai: 16.66,
    },
  },
};

// Tab types
type TabType = "overview" | "providers" | "performance" | "api";

function formatContextLength(length: number): string {
  if (length >= 1000000) {
    return `${(length / 1000000).toFixed(1)}M`;
  }
  return `${Math.floor(length / 1000)}K`;
}

function formatPrice(price: string, multiplier: number = 1000000): string {
  const numPrice = parseFloat(price) * multiplier;
  if (numPrice === 0) return "Free";
  if (numPrice < 0.01) return `$${numPrice.toFixed(3)}`;
  if (numPrice < 1) return `$${numPrice.toFixed(2)}`;
  return `$${numPrice.toFixed(2)}`;
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

// Provider Card Component
function ProviderCard({
  provider,
  expanded,
  onToggle,
}: {
  provider: (typeof STATIC_MODEL.providers)[0];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="bg-bg-200 rounded-xl border border-border-200 overflow-hidden">
      {/* Provider Header */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-bg-300 flex items-center justify-center">
              <ServerIcon className="w-5 h-5 text-text-300" />
            </div>
            <div>
              <Link
                href={`/providers/${provider.id}`}
                className="text-text-100 font-medium hover:text-accent-main-100 transition-colors"
              >
                {provider.name}
              </Link>
            </div>
            <span className="px-2 py-0.5 text-xs bg-bg-300 text-text-300 rounded">
              {provider.region}
            </span>
          </div>
        </div>

        {/* Stats Row */}
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-text-500">Latency</span>
            <span className="text-text-100 font-medium">{provider.latency}s</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-500">Throughput</span>
            <span className="text-text-100 font-medium">{provider.throughput} tps</span>
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
              <span className="text-text-100 font-medium">{provider.uptime}%</span>
            </div>
          </div>
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
        </div>
      </div>

      {/* Expanded Pricing Details */}
      {expanded && (
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
                {formatPrice(provider.pricing.input)}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-1">Output Price</div>
              <div className="text-text-100 font-medium">
                {formatPrice(provider.pricing.output)}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-1">Cache Read</div>
              <div className="text-text-100 font-medium">
                {provider.pricing.cache_read
                  ? formatPrice(provider.pricing.cache_read)
                  : "--"}
              </div>
            </div>
            <div>
              <div className="text-text-500 mb-1">Cache Write</div>
              <div className="text-text-100 font-medium">--</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Performance Chart Placeholder
function PerformanceChart({
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

      {/* Simple bar chart */}
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

      {/* Legend */}
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
}

// Providers Section
function ProvidersSection() {
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  return (
    <section className="mb-12">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold text-text-100">
          Providers for {STATIC_MODEL.name}
        </h2>
        <Link
          href={`/models/${STATIC_MODEL.author.id}/${STATIC_MODEL.slug}/providers`}
          className="p-1 hover:bg-bg-300 rounded transition-colors"
        >
          <svg className="w-4 h-4 text-text-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </Link>
      </div>

      <p className="text-text-300 text-sm mb-6">
        Radium{" "}
        <Link href="/docs/provider-routing" className="text-accent-main-100 hover:underline">
          routes requests
        </Link>{" "}
        to the best providers that are able to handle your prompt size and parameters, with
        fallbacks to maximize{" "}
        <Link
          href={`/models/${STATIC_MODEL.author.id}/${STATIC_MODEL.slug}/uptime`}
          className="text-accent-main-100 hover:underline"
        >
          uptime
        </Link>
        .
      </p>

      <div className="space-y-3">
        {STATIC_MODEL.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            expanded={expandedProvider === provider.id}
            onToggle={() =>
              setExpandedProvider(expandedProvider === provider.id ? null : provider.id)
            }
          />
        ))}
      </div>
    </section>
  );
}

// Performance Section
function PerformanceSection() {
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
}

// Activity Section
function ActivitySection() {
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

      {/* Activity Chart Placeholder */}
      <div className="bg-bg-200 rounded-xl border border-border-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <select className="bg-bg-300 border border-border-200 rounded-lg px-3 py-1.5 text-sm text-text-200">
            <option>Tokens</option>
            <option>Requests</option>
          </select>
        </div>
        <div className="h-48 flex items-end justify-between gap-1">
          {/* Static heights to avoid hydration mismatch */}
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
}

// Quickstart/API Section
function QuickstartSection() {
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

      {/* Language Tabs */}
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

      {/* Code Block */}
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

      {/* Additional Info */}
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
}

// Overview Tab Content (shows all sections like OpenRouter)
function OverviewTab() {
  return (
    <div>
      <ProvidersSection />
      <PerformanceSection />
      <ActivitySection />
      <QuickstartSection />
    </div>
  );
}

// Standalone Providers Tab Content
function ProvidersTab() {
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <p className="text-text-300">
        Radium routes requests to the best providers that are able to handle your prompt size and
        parameters, with fallbacks to maximize uptime.
      </p>

      <div className="space-y-3">
        {STATIC_MODEL.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            expanded={expandedProvider === provider.id}
            onToggle={() =>
              setExpandedProvider(expandedProvider === provider.id ? null : provider.id)
            }
          />
        ))}
      </div>

      {/* Supported Parameters */}
      <div className="mt-8">
        <h3 className="text-lg font-semibold text-text-100 mb-4">Supported Parameters</h3>
        <div className="flex flex-wrap gap-2">
          {STATIC_MODEL.providers[0].supported_parameters.map((param) => (
            <span
              key={param}
              className="px-2.5 py-1 bg-bg-200 text-text-300 rounded-md text-sm border border-border-200"
            >
              {param}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// Standalone Performance Tab Content
function PerformanceTab() {
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

      {/* Detailed Stats */}
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
}

// Standalone API Tab Content
function ApiTab() {
  return <QuickstartSection />;
}

export default function ModelDetailPage() {
  const [activeTab, setActiveTab] = useState<TabType>("overview");

  return (
    <div className="min-h-screen">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          {/* Title Row */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-3">
            <h1 className="text-2xl md:text-3xl font-bold text-text-000">
              {STATIC_MODEL.author.name}: {STATIC_MODEL.name}
            </h1>

            {/* Action Buttons */}
            <div className="flex items-center gap-2">
              <Link
                href={`/chat?model=${STATIC_MODEL.author.id}/${STATIC_MODEL.slug}`}
                className="inline-flex items-center gap-2 px-4 py-2 bg-accent-main-100 text-white rounded-lg hover:bg-accent-main-200 transition-colors font-medium text-sm"
              >
                <ChatIcon className="w-4 h-4" />
                Chat
              </Link>
              <Link
                href={`/compare/${STATIC_MODEL.author.id}/${STATIC_MODEL.slug}`}
                className="inline-flex items-center gap-2 px-4 py-2 bg-bg-200 text-text-100 rounded-lg hover:bg-bg-300 transition-colors border border-border-200 text-sm"
              >
                <ChartIcon className="w-4 h-4" />
                Compare
              </Link>
            </div>
          </div>

          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-sm mb-4">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded bg-bg-300 overflow-hidden flex items-center justify-center">
                {STATIC_MODEL.author.icon ? (
                  <NextImage
                    src={STATIC_MODEL.author.icon}
                    alt={`${STATIC_MODEL.author.name} icon`}
                    width={20}
                    height={20}
                    className="w-full h-full object-cover"
                    unoptimized
                  />
                ) : (
                  <span className="text-xs font-bold text-text-200">
                    {STATIC_MODEL.author.name.charAt(0)}
                  </span>
                )}
              </div>
              <Link
                href={`/models?provider=${STATIC_MODEL.author.id}`}
                className="text-accent-main-100 hover:underline"
              >
                {STATIC_MODEL.author.id}
              </Link>
            </div>
            <span className="text-text-500">/</span>
            <span className="text-text-300">{STATIC_MODEL.slug}</span>
            <CopyButton text={`${STATIC_MODEL.author.id}/${STATIC_MODEL.slug}`} />
          </div>

          {/* Meta Info Row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-300 mb-4">
            <span>
              Created <span className="text-text-100">{formatDate(STATIC_MODEL.launch_date)}</span>
            </span>
            <span>
              <span className="text-text-100">
                {formatContextLength(STATIC_MODEL.context_length).replace("K", ",000").replace("M", ",000,000").replace(/,000,000$/, "K").replace(/(\d+)K/, (_, n) => Number(n).toLocaleString())}
              </span>{" "}
              context
            </span>
          </div>

          {/* Pricing Badges */}
          <div className="flex flex-wrap gap-3 mb-6">
            <span className="text-sm text-text-200">
              <span className="text-text-100 font-medium">
                {formatPrice(STATIC_MODEL.pricing.input)}
              </span>
              /M input tokens
            </span>
            <span className="text-sm text-text-200">
              <span className="text-text-100 font-medium">
                {formatPrice(STATIC_MODEL.pricing.output)}
              </span>
              /M output tokens
            </span>
          </div>

          {/* Description */}
          <p className="text-text-300 leading-relaxed max-w-4xl">{STATIC_MODEL.description}</p>
        </div>

        {/* Tabs */}
        <div className="border-b border-border-200 mb-8">
          <div className="flex gap-1 overflow-x-auto">
            <Tab active={activeTab === "overview"} onClick={() => setActiveTab("overview")}>
              Overview
            </Tab>
            <Tab active={activeTab === "providers"} onClick={() => setActiveTab("providers")}>
              Providers
            </Tab>
            <Tab active={activeTab === "performance"} onClick={() => setActiveTab("performance")}>
              Performance
            </Tab>
            <Tab active={activeTab === "api"} onClick={() => setActiveTab("api")}>
              Quickstart
            </Tab>
          </div>
        </div>

        {/* Tab Content */}
        <div>
          {activeTab === "overview" && <OverviewTab />}
          {activeTab === "providers" && <ProvidersTab />}
          {activeTab === "performance" && <PerformanceTab />}
          {activeTab === "api" && <ApiTab />}
        </div>

        {/* More models from author */}
        <section className="mt-16 border-t border-border-200 pt-8">
          <div className="flex items-center gap-2 mb-6">
            <span className="text-text-300">More models from</span>
            <Link
              href={`/models?provider=${STATIC_MODEL.author.id}`}
              className="text-accent-main-100 hover:underline font-medium"
            >
              {STATIC_MODEL.author.name}
            </Link>
          </div>

          {/* Model cards placeholder */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { name: "GPT-5", slug: "gpt-5", desc: "Most advanced model with improved reasoning" },
              { name: "GPT-5 Mini", slug: "gpt-5-mini", desc: "Compact version for lighter tasks" },
              { name: "GPT-5 Pro", slug: "gpt-5-pro", desc: "Optimized for complex reasoning tasks" },
            ].map((model) => (
              <Link
                key={model.slug}
                href={`/models/${STATIC_MODEL.author.id}/${model.slug}`}
                className="p-4 bg-bg-200 rounded-xl border border-border-200 hover:border-border-300 transition-colors"
              >
                <h3 className="text-text-100 font-medium mb-2">{model.name}</h3>
                <p className="text-text-400 text-sm line-clamp-2">{model.desc}</p>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
