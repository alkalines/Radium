"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
// Static model data
const STATIC_MODELS = [
  {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    provider: "Anthropic",
    description:
      "Anthropic's most capable model for complex reasoning, analysis, and creative tasks. Excels at nuanced understanding and multi-step problem solving.",
    contextLength: 200000,
    inputPrice: 15,
    outputPrice: 75,
    tags: ["reasoning", "coding", "analysis"],
    modalities: { input: ["text", "image"], output: ["text"] },
    isNew: true,
    isFeatured: true,
  },
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    provider: "Anthropic",
    description:
      "Best balance of intelligence and speed. Ideal for enterprise workloads requiring both performance and efficiency.",
    contextLength: 200000,
    inputPrice: 3,
    outputPrice: 15,
    tags: ["coding", "analysis", "general"],
    modalities: { input: ["text", "image"], output: ["text"] },
    isNew: true,
    isFeatured: true,
  },
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    provider: "OpenAI",
    description:
      "OpenAI's flagship model with improved reasoning, coding abilities, and instruction following. Enhanced performance across all benchmarks.",
    contextLength: 128000,
    inputPrice: 2.5,
    outputPrice: 10,
    tags: ["reasoning", "coding", "general"],
    modalities: { input: ["text", "image"], output: ["text"] },
    isNew: false,
    isFeatured: true,
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    provider: "OpenAI",
    description:
      "Smaller, faster, and more affordable version of GPT-4.1. Great for tasks that don't require the full power of the flagship model.",
    contextLength: 128000,
    inputPrice: 0.4,
    outputPrice: 1.6,
    tags: ["general", "fast"],
    modalities: { input: ["text", "image"], output: ["text"] },
    isNew: false,
    isFeatured: false,
  },
  {
    id: "openai/o3",
    name: "o3",
    provider: "OpenAI",
    description:
      "OpenAI's advanced reasoning model with extended thinking capabilities. Designed for complex mathematical and scientific problems.",
    contextLength: 200000,
    inputPrice: 10,
    outputPrice: 40,
    tags: ["reasoning", "math", "science"],
    modalities: { input: ["text", "image"], output: ["text"] },
    isNew: true,
    isFeatured: true,
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    provider: "OpenAI",
    description:
      "Compact reasoning model optimized for speed while maintaining strong logical capabilities. Cost-effective for reasoning tasks.",
    contextLength: 128000,
    inputPrice: 1.1,
    outputPrice: 4.4,
    tags: ["reasoning", "fast"],
    modalities: { input: ["text", "image"], output: ["text"] },
    isNew: true,
    isFeatured: false,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "Google",
    description:
      "Google's most advanced multimodal model with strong reasoning, coding, and analysis capabilities. Supports long context windows.",
    contextLength: 1000000,
    inputPrice: 1.25,
    outputPrice: 5,
    tags: ["multimodal", "reasoning", "coding"],
    modalities: { input: ["text", "image", "video", "audio"], output: ["text"] },
    isNew: true,
    isFeatured: true,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "Google",
    description:
      "Fast and efficient model for high-volume tasks. Optimized for speed while maintaining good quality across various tasks.",
    contextLength: 1000000,
    inputPrice: 0.075,
    outputPrice: 0.3,
    tags: ["fast", "multimodal", "general"],
    modalities: { input: ["text", "image", "video", "audio"], output: ["text"] },
    isNew: false,
    isFeatured: false,
  },
  {
    id: "deepseek/deepseek-v3",
    name: "DeepSeek V3",
    provider: "DeepSeek",
    description:
      "Open-weight model with exceptional reasoning and coding capabilities. Competitive with top proprietary models at a fraction of the cost.",
    contextLength: 64000,
    inputPrice: 0.27,
    outputPrice: 1.1,
    tags: ["reasoning", "coding", "open-weight"],
    modalities: { input: ["text"], output: ["text"] },
    isNew: false,
    isFeatured: true,
  },
  {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek R1",
    provider: "DeepSeek",
    description:
      "Advanced reasoning model with chain-of-thought capabilities. Excels at mathematical reasoning and complex problem-solving tasks.",
    contextLength: 64000,
    inputPrice: 0.55,
    outputPrice: 2.19,
    tags: ["reasoning", "math", "open-weight"],
    modalities: { input: ["text"], output: ["text"] },
    isNew: true,
    isFeatured: true,
  },
  {
    id: "meta/llama-4-maverick",
    name: "Llama 4 Maverick",
    provider: "Meta",
    description:
      "Meta's latest open-weight model with strong performance across benchmarks. Fully open-source and customizable.",
    contextLength: 128000,
    inputPrice: 0.2,
    outputPrice: 0.6,
    tags: ["open-weight", "general", "coding"],
    modalities: { input: ["text", "image"], output: ["text"] },
    isNew: true,
    isFeatured: false,
  },
  {
    id: "meta/llama-4-scout",
    name: "Llama 4 Scout",
    provider: "Meta",
    description:
      "Smaller Llama 4 variant optimized for efficiency. Great balance of performance and resource usage for various applications.",
    contextLength: 128000,
    inputPrice: 0.1,
    outputPrice: 0.3,
    tags: ["open-weight", "fast", "efficient"],
    modalities: { input: ["text", "image"], output: ["text"] },
    isNew: true,
    isFeatured: false,
  },
  {
    id: "mistral/mistral-large",
    name: "Mistral Large",
    provider: "Mistral",
    description:
      "Mistral's flagship model with excellent multilingual capabilities and strong reasoning. Built for enterprise applications.",
    contextLength: 128000,
    inputPrice: 2,
    outputPrice: 6,
    tags: ["multilingual", "reasoning", "enterprise"],
    modalities: { input: ["text"], output: ["text"] },
    isNew: false,
    isFeatured: false,
  },
  {
    id: "mistral/codestral",
    name: "Codestral",
    provider: "Mistral",
    description:
      "Specialized coding model with extensive training on code. Excels at code generation, completion, and explanation.",
    contextLength: 32000,
    inputPrice: 0.3,
    outputPrice: 0.9,
    tags: ["coding", "specialized"],
    modalities: { input: ["text"], output: ["text"] },
    isNew: false,
    isFeatured: false,
  },
  {
    id: "xai/grok-3",
    name: "Grok 3",
    provider: "xAI",
    description:
      "xAI's latest model with real-time information access and strong reasoning capabilities. Known for direct and engaging responses.",
    contextLength: 131072,
    inputPrice: 3,
    outputPrice: 15,
    tags: ["reasoning", "real-time", "general"],
    modalities: { input: ["text", "image"], output: ["text"] },
    isNew: true,
    isFeatured: false,
  },
  {
    id: "cohere/command-r-plus",
    name: "Command R+",
    provider: "Cohere",
    description:
      "Enterprise-grade model optimized for RAG applications with strong citation and grounding capabilities.",
    contextLength: 128000,
    inputPrice: 2.5,
    outputPrice: 10,
    tags: ["rag", "enterprise", "grounded"],
    modalities: { input: ["text"], output: ["text"] },
    isNew: false,
    isFeatured: false,
  },
];

const PROVIDERS = [
  "All",
  "Anthropic",
  "OpenAI",
  "Google",
  "DeepSeek",
  "Meta",
  "Mistral",
  "xAI",
  "Cohere",
];

const MODALITY_FILTERS = ["text", "image", "video", "audio"];

const TAGS = [
  "reasoning",
  "coding",
  "general",
  "fast",
  "multimodal",
  "open-weight",
  "math",
  "enterprise",
];

type SortOption =
  | "featured"
  | "newest"
  | "price-low"
  | "price-high"
  | "context-high";

function formatContextLength(length: number): string {
  if (length >= 1000000) {
    return `${(length / 1000000).toFixed(1)}M`;
  }
  return `${(length / 1000).toFixed(0)}K`;
}

function formatPrice(price: number): string {
  if (price === 0) return "Free";
  if (price < 0.01) return `$${price.toFixed(4)}`;
  if (price < 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(2)}`;
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 9l-7 7-7-7"
      />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5l7 7-7 7"
      />
    </svg>
  );
}

// Filter section icons
function InputModalityIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
    </svg>
  );
}

function OutputModalityIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function CategoryIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
    </svg>
  );
}

function ProviderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  );
}

// Collapsible Filter Section Component
function FilterSection({
  title,
  icon,
  isOpen,
  onToggle,
  children,
  badge,
}: {
  title: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  badge?: number;
}) {
  return (
    <div className="border-b border-border-200 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between py-3 px-1 text-sm font-medium text-text-100 hover:text-text-000 transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon}
          <span>{title}</span>
          {badge !== undefined && badge > 0 && (
            <span className="px-1.5 py-0.5 text-xs bg-accent-main-100/20 text-accent-main-100 rounded-full">
              {badge}
            </span>
          )}
        </div>
        <ChevronRightIcon
          className={`w-4 h-4 text-text-500 transition-transform duration-200 ${
            isOpen ? "rotate-90" : ""
          }`}
        />
      </button>
      <div
        className={`overflow-hidden transition-all duration-200 ${
          isOpen ? "max-h-96 opacity-100 pb-3" : "max-h-0 opacity-0"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function GridIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
      />
    </svg>
  );
}

function ListIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6h16M4 12h16M4 18h16"
      />
    </svg>
  );
}

function ModelCard({
  model,
  viewMode,
}: {
  model: (typeof STATIC_MODELS)[0];
  viewMode: "grid" | "list";
}) {
  if (viewMode === "list") {
    return (
      <Link
        href={`/models/${model.id}`}
        className="block border-b border-border-200 py-5 px-2 hover:bg-bg-200/50 transition-colors"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-semibold text-text-100">
                {model.provider}: {model.name}
              </h3>
              {model.isNew && (
                <span className="px-2 py-0.5 text-xs font-medium bg-accent-main-100/20 text-accent-main-100 rounded-full">
                  New
                </span>
              )}
            </div>
            <p className="text-sm text-text-300 line-clamp-2 mb-2">
              {model.description}
            </p>
            <div className="flex items-center gap-4 text-sm text-text-500">
              <span className="text-text-200">
                {formatContextLength(model.contextLength)} context
              </span>
              <span>
                {formatPrice(model.inputPrice)}/M input
              </span>
              <span>
                {formatPrice(model.outputPrice)}/M output
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {model.modalities.input.includes("image") && (
              <span className="text-xs px-2 py-1 bg-bg-300 rounded text-text-300">
                Vision
              </span>
            )}
            {model.modalities.input.includes("audio") && (
              <span className="text-xs px-2 py-1 bg-bg-300 rounded text-text-300">
                Audio
              </span>
            )}
          </div>
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={`/models/${model.id}`}
      className="block p-5 border border-border-200 rounded-xl hover:border-border-300 hover:bg-bg-200/30 transition-all group"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-bg-300 flex items-center justify-center">
            <span className="text-sm font-bold text-text-200">
              {model.provider.charAt(0)}
            </span>
          </div>
          <span className="text-sm text-text-300">{model.provider}</span>
        </div>
        {model.isNew && (
          <span className="px-2 py-0.5 text-xs font-medium bg-accent-main-100/20 text-accent-main-100 rounded-full">
            New
          </span>
        )}
      </div>

      <h3 className="text-lg font-semibold text-text-100 mb-2 group-hover:text-accent-main-100 transition-colors">
        {model.name}
      </h3>

      <p className="text-sm text-text-300 line-clamp-3 mb-4">
        {model.description}
      </p>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {model.tags.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="px-2 py-0.5 text-xs bg-bg-300 text-text-300 rounded-full"
          >
            {tag}
          </span>
        ))}
      </div>

      <div className="pt-3 border-t border-border-200">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-200">
            {formatContextLength(model.contextLength)} ctx
          </span>
          <div className="text-text-500">
            <span className="text-text-300">{formatPrice(model.inputPrice)}</span>
            <span className="mx-1">/</span>
            <span className="text-text-300">{formatPrice(model.outputPrice)}</span>
            <span className="text-text-500 ml-1">per M tokens</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

/**
 * Models page
 */

export default function ModelsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("All");
  const [selectedModalities, setSelectedModalities] = useState<string[]>([]);
  const [selectedOutputModalities, setSelectedOutputModalities] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<SortOption>("featured");
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [showFilters, setShowFilters] = useState(true);
  
  // Collapsible filter sections state
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    inputModalities: true,
    outputModalities: false,
    categories: false,
    providers: false,
  });

  const toggleSection = (section: string) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const filteredModels = useMemo(() => {
    let filtered = [...STATIC_MODELS];

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (model) =>
          model.name.toLowerCase().includes(query) ||
          model.provider.toLowerCase().includes(query) ||
          model.description.toLowerCase().includes(query) ||
          model.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    }

    // Provider filter
    if (selectedProvider !== "All") {
      filtered = filtered.filter(
        (model) => model.provider === selectedProvider
      );
    }

    // Modality filter
    if (selectedModalities.length > 0) {
      filtered = filtered.filter((model) =>
        selectedModalities.every(
          (modality) =>
            model.modalities.input.includes(modality) ||
            model.modalities.output.includes(modality)
        )
      );
    }

    // Tags filter
    if (selectedTags.length > 0) {
      filtered = filtered.filter((model) =>
        selectedTags.some((tag) => model.tags.includes(tag))
      );
    }

    // Sorting
    switch (sortBy) {
      case "featured":
        filtered.sort((a, b) => {
          if (a.isFeatured && !b.isFeatured) return -1;
          if (!a.isFeatured && b.isFeatured) return 1;
          return 0;
        });
        break;
      case "newest":
        filtered.sort((a, b) => {
          if (a.isNew && !b.isNew) return -1;
          if (!a.isNew && b.isNew) return 1;
          return 0;
        });
        break;
      case "price-low":
        filtered.sort((a, b) => a.inputPrice - b.inputPrice);
        break;
      case "price-high":
        filtered.sort((a, b) => b.inputPrice - a.inputPrice);
        break;
      case "context-high":
        filtered.sort((a, b) => b.contextLength - a.contextLength);
        break;
    }

    return filtered;
  }, [searchQuery, selectedProvider, selectedModalities, selectedTags, sortBy]);

  const toggleModality = (modality: string) => {
    setSelectedModalities((prev) =>
      prev.includes(modality)
        ? prev.filter((m) => m !== modality)
        : [...prev, modality]
    );
  };

  const toggleOutputModality = (modality: string) => {
    setSelectedOutputModalities((prev) =>
      prev.includes(modality)
        ? prev.filter((m) => m !== modality)
        : [...prev, modality]
    );
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const clearFilters = () => {
    setSearchQuery("");
    setSelectedProvider("All");
    setSelectedModalities([]);
    setSelectedOutputModalities([]);
    setSelectedTags([]);
    setSortBy("featured");
  };

  const hasActiveFilters =
    searchQuery ||
    selectedProvider !== "All" ||
    selectedModalities.length > 0 ||
    selectedOutputModalities.length > 0 ||
    selectedTags.length > 0;

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-text-000 mb-2">Models</h1>
          <p className="text-text-300">
            Browse AI Models available
          </p>
        </div>

        <div className="flex gap-8">
          {/* Sidebar Filters */}
          {showFilters && (
            <aside className="w-56 flex-shrink-0 hidden lg:block">
              <div className="sticky top-24">
                {/* Input Modalities */}
                <FilterSection
                  title="Input Modalities"
                  icon={<InputModalityIcon className="w-4 h-4" />}
                  isOpen={openSections.inputModalities}
                  onToggle={() => toggleSection("inputModalities")}
                  badge={selectedModalities.length}
                >
                  <div className="space-y-0.5 pl-6">
                    {MODALITY_FILTERS.map((modality) => (
                      <button
                        key={modality}
                        onClick={() => toggleModality(modality)}
                        className={`w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors capitalize ${
                          selectedModalities.includes(modality)
                            ? "bg-accent-main-100/20 text-accent-main-100"
                            : "text-text-300 hover:bg-bg-200 hover:text-text-100"
                        }`}
                      >
                        {modality}
                      </button>
                    ))}
                  </div>
                </FilterSection>

                {/* Output Modalities */}
                <FilterSection
                  title="Output Modalities"
                  icon={<OutputModalityIcon className="w-4 h-4" />}
                  isOpen={openSections.outputModalities}
                  onToggle={() => toggleSection("outputModalities")}
                  badge={selectedOutputModalities.length}
                >
                  <div className="space-y-0.5 pl-6">
                    {["text", "image"].map((modality) => (
                      <button
                        key={modality}
                        onClick={() => toggleOutputModality(modality)}
                        className={`w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors capitalize ${
                          selectedOutputModalities.includes(modality)
                            ? "bg-accent-main-100/20 text-accent-main-100"
                            : "text-text-300 hover:bg-bg-200 hover:text-text-100"
                        }`}
                      >
                        {modality}
                      </button>
                    ))}
                  </div>
                </FilterSection>

                {/* Categories */}
                <FilterSection
                  title="Categories"
                  icon={<CategoryIcon className="w-4 h-4" />}
                  isOpen={openSections.categories}
                  onToggle={() => toggleSection("categories")}
                  badge={selectedTags.length}
                >
                  <div className="space-y-0.5 pl-6">
                    {TAGS.map((tag) => (
                      <button
                        key={tag}
                        onClick={() => toggleTag(tag)}
                        className={`w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors capitalize ${
                          selectedTags.includes(tag)
                            ? "bg-accent-main-100/20 text-accent-main-100"
                            : "text-text-300 hover:bg-bg-200 hover:text-text-100"
                        }`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </FilterSection>

                {/* Providers */}
                <FilterSection
                  title="Providers"
                  icon={<ProviderIcon className="w-4 h-4" />}
                  isOpen={openSections.providers}
                  onToggle={() => toggleSection("providers")}
                  badge={selectedProvider !== "All" ? 1 : 0}
                >
                  <div className="space-y-0.5 pl-6">
                    {PROVIDERS.map((provider) => (
                      <button
                        key={provider}
                        onClick={() => setSelectedProvider(provider)}
                        className={`w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors ${
                          selectedProvider === provider
                            ? "bg-accent-main-100/20 text-accent-main-100"
                            : "text-text-300 hover:bg-bg-200 hover:text-text-100"
                        }`}
                      >
                        {provider}
                      </button>
                    ))}
                  </div>
                </FilterSection>

                {/* Clear Filters */}
                {hasActiveFilters && (
                  <div className="pt-4">
                    <button
                      onClick={clearFilters}
                      className="text-sm text-accent-main-100 hover:text-accent-main-200 transition-colors"
                    >
                      Reset Filters
                    </button>
                  </div>
                )}
              </div>
            </aside>
          )}

          {/* Main Content */}
          <div className="flex-1 min-w-0">
            {/* Search and Controls */}
            <div className="flex flex-col sm:flex-row gap-4 mb-6">
              {/* Search */}
              <div className="relative flex-1">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-500" />
                <input
                  type="text"
                  placeholder="Filter models..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-bg-200 border border-border-200 rounded-lg text-text-100 placeholder-text-500 focus:outline-none focus:border-accent-main-100 focus:ring-1 focus:ring-accent-main-100 transition-colors"
                />
              </div>

              {/* Sort Dropdown */}
              <div className="relative">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  className="appearance-none pl-4 pr-10 py-2.5 bg-bg-200 border border-border-200 rounded-lg text-text-100 focus:outline-none focus:border-accent-main-100 cursor-pointer"
                >
                  <option value="featured">Featured</option>
                  <option value="newest">Newest</option>
                  <option value="price-low">Price: Low to High</option>
                  <option value="price-high">Price: High to Low</option>
                  <option value="context-high">Context: High to Low</option>
                </select>
                <ChevronDownIcon className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-500 pointer-events-none" />
              </div>

              {/* View Toggle */}
              <div className="flex border border-border-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setViewMode("grid")}
                  className={`p-2.5 transition-colors ${
                    viewMode === "grid"
                      ? "bg-bg-300 text-text-100"
                      : "bg-bg-200 text-text-500 hover:text-text-100"
                  }`}
                  title="Grid view"
                >
                  <GridIcon className="w-5 h-5" />
                </button>
                <button
                  onClick={() => setViewMode("list")}
                  className={`p-2.5 transition-colors ${
                    viewMode === "list"
                      ? "bg-bg-300 text-text-100"
                      : "bg-bg-200 text-text-500 hover:text-text-100"
                  }`}
                  title="List view"
                >
                  <ListIcon className="w-5 h-5" />
                </button>
              </div>

              {/* Toggle Filters (mobile) */}
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="lg:hidden p-2.5 bg-bg-200 border border-border-200 rounded-lg text-text-300 hover:text-text-100 transition-colors"
              >
                Filters
              </button>
            </div>

            {/* Results Count */}
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-text-500">
                <span className="text-text-200 font-medium">
                  {filteredModels.length}
                </span>{" "}
                models
              </p>
            </div>

            {/* Models Grid/List */}
            {viewMode === "grid" ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {filteredModels.map((model) => (
                  <ModelCard key={model.id} model={model} viewMode={viewMode} />
                ))}
              </div>
            ) : (
              <div className="border-t border-border-200">
                {filteredModels.map((model) => (
                  <ModelCard key={model.id} model={model} viewMode={viewMode} />
                ))}
              </div>
            )}

            {/* Empty State */}
            {filteredModels.length === 0 && (
              <div className="text-center py-16">
                <p className="text-text-300 mb-4">
                  No models found matching your filters
                </p>
                <button
                  onClick={clearFilters}
                  className="px-4 py-2 bg-accent-main-100 text-white rounded-lg hover:bg-accent-main-200 transition-colors"
                >
                  Clear Filters
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
