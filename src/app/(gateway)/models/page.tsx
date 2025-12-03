"use client";

import { api } from "@/../convex/_generated/api";
import { Doc } from "@/../convex/_generated/dataModel";
import {
  CategoryIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GridIcon,
  InputModalityIcon,
  ListIcon,
  OutputModalityIcon,
  ProviderIcon,
  SearchIcon,
} from "@/components/ui/Icons";
import { MultiplyFunction, RemFunction } from "@/utils/math";
import Providers from "@/utils/providers";
import { useQuery } from "convex/react";
import NextImage from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";

type SortOption = "newest" | "price-low" | "price-high" | "context-high";

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

// Skeleton Components for Loading State
function ModelCardSkeleton({ viewMode }: { viewMode: "grid" | "list" }) {
  if (viewMode === "list") {
    return (
      <div className="block border-b border-border-200 py-5 px-2 animate-pulse">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <div className="h-6 w-48 bg-bg-300 rounded" />
            </div>
            <div className="space-y-2 mb-2">
              <div className="h-4 w-full bg-bg-300 rounded" />
              <div className="h-4 w-3/4 bg-bg-300 rounded" />
            </div>
            <div className="flex items-center gap-4">
              <div className="h-4 w-24 bg-bg-300 rounded" />
              <div className="h-4 w-20 bg-bg-300 rounded" />
              <div className="h-4 w-20 bg-bg-300 rounded" />
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="h-6 w-14 bg-bg-300 rounded" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="block p-5 border border-border-200 rounded-xl animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-bg-300" />
          <div className="h-4 w-20 bg-bg-300 rounded" />
        </div>
      </div>

      <div className="h-6 w-3/4 bg-bg-300 rounded mb-2" />

      <div className="space-y-2 mb-4">
        <div className="h-4 w-full bg-bg-300 rounded" />
        <div className="h-4 w-full bg-bg-300 rounded" />
        <div className="h-4 w-2/3 bg-bg-300 rounded" />
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        <div className="h-5 w-16 bg-bg-300 rounded-full" />
        <div className="h-5 w-20 bg-bg-300 rounded-full" />
        <div className="h-5 w-14 bg-bg-300 rounded-full" />
      </div>

      <div className="pt-3 border-t border-border-200">
        <div className="flex items-center justify-between">
          <div className="h-4 w-16 bg-bg-300 rounded" />
          <div className="h-4 w-32 bg-bg-300 rounded" />
        </div>
      </div>
    </div>
  );
}

function ModelsLoadingSkeleton({ viewMode }: { viewMode: "grid" | "list" }) {
  const skeletonCount = viewMode === "grid" ? 9 : 6;

  return (
    <>
      {/* Results Count Skeleton */}
      <div className="flex items-center justify-between mb-4">
        <div className="h-4 w-20 bg-bg-300 rounded animate-pulse" />
      </div>

      {/* Models Grid/List Skeleton */}
      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: skeletonCount }).map((_, index) => (
            <ModelCardSkeleton key={index} viewMode={viewMode} />
          ))}
        </div>
      ) : (
        <div className="border-t border-border-200">
          {Array.from({ length: skeletonCount }).map((_, index) => (
            <ModelCardSkeleton key={index} viewMode={viewMode} />
          ))}
        </div>
      )}
    </>
  );
}

function ModelCard({
  model,
  authors,
  viewMode,
}: {
  model: Doc<"models">;
  authors: Doc<"authors">[];
  viewMode: "grid" | "list";
}) {
  const author = authors.find((a) => a._id === model.author);
  if (viewMode === "list") {
    return (
      <Link
        href={`/models/${model.slug}`}
        className="block border-b border-border-200 py-5 px-2 hover:bg-bg-200/50 transition-colors"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-semibold text-text-100">
                {author?.name}: {model.name}
              </h3>
              {Date.now() - model.launch_date < 864000 && ( // 3 days is new
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
                {formatContextLength(model.providers[0].context)} context
              </span>
              <span>
                {formatPrice(
                  MultiplyFunction([
                    parseFloat(model.providers[0].pricing.input),
                    1000000,
                  ])
                )}
                /M input
              </span>
              <span>
                {formatPrice(
                  MultiplyFunction([
                    parseFloat(model.providers[0].pricing.output),
                    1000000,
                  ])
                )}
                /M output
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {model.architecture.input_modalities.includes("image") && (
              <span className="text-xs px-2 py-1 bg-bg-300 rounded text-text-300">
                Vision
              </span>
            )}
            {model.architecture.input_modalities.includes("audio") && (
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
      href={`/models/${model.slug}`}
      className="block p-5 border border-border-200 rounded-xl hover:border-border-300 hover:bg-bg-200/30 transition-all group"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-bg-300 flex items-center justify-center overflow-hidden">
            {author?.icon ? (
              <NextImage
                src={author.icon}
                alt={`${author.name} icon`}
                width={32}
                height={32}
                className="w-full h-full object-cover"
                unoptimized
              />
            ) : (
              <span className="text-sm font-bold text-text-200">
                {author?.name?.charAt(0) ?? "?"}
              </span>
            )}
          </div>
          <span className="text-sm text-text-300">{author?.name}</span>
        </div>
        {Date.now() - model.launch_date < 864000 && ( // 3 days is new
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
        {model.providers[0].supported_parameters.slice(0, 3).map((tag) => (
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
            {formatContextLength(model.providers[0].context)} ctx
          </span>
          <div className="text-text-500">
            <span className="text-text-300">
              {formatPrice(
                MultiplyFunction([
                  parseFloat(model.providers[0].pricing.input),
                  1000000,
                ])
              )}
            </span>
            <span className="mx-1">/</span>
            <span className="text-text-300">
              {formatPrice(
                MultiplyFunction([
                  parseFloat(model.providers[0].pricing.input),
                  1000000,
                ])
              )}
            </span>
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
  const [selectedInputModalities, setSelectedInputModalities] = useState<
    string[]
  >([]);
  const [selectedOutputModalities, setSelectedOutputModalities] = useState<
    string[]
  >([]);
  const [selectedParameters, setSelectedParameters] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<SortOption>("newest");
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [showFilters, setShowFilters] = useState(true);

  // Data
  const convexModels = useQuery(api.models.availableModels);
  const convexAuthors = useQuery(api.authors.listAuthors);

  // Dynamic data
  const modelInputModalities = [] as string[];
  const modelOutputModalities = [] as string[];
  convexModels?.forEach((m) => {
    // Modalities
    // Input
    m.architecture.input_modalities.forEach((i) => {
      if (!modelInputModalities.includes(i)) modelInputModalities.push(i);
    });
    // Output
    m.architecture.output_modalities.forEach((i) => {
      if (!modelOutputModalities.includes(i)) modelOutputModalities.push(i);
    });
  });

  // More or less, static data
  const configuredProviders = [] as string[];
  for (const [key, value] of Object.entries(Providers)) {
    configuredProviders.push(key);
  }
  const supportedParameters = [
    "temperature",
    "top_p",
    "top_k",
    "frequency_penalty",
    "presence_penalty",
    "repetition_penalty",
    "min_p",
    "top_a",
    "seed",
    "max_tokens",
    "logit_bias",
    "logprobs",
    "top_logprobs",
    "response_format",
    "structured_outputs",
    "stop",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "verbosity",
  ];

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

  // Check if data is loading (Convex useQuery returns undefined while loading)
  const isLoading = convexModels === undefined;

  const filteredModels = useMemo(() => {
    if (!convexModels) return [];

    let filtered = [...convexModels];

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (model) =>
          model.name.toLowerCase().includes(query) ||
          model.description.toLowerCase().includes(query)
      );
    }

    // Provider filter
    if (selectedProvider !== "All") {
      filtered = filtered.filter((model) =>
        model.providers.filter((p) => p.id === selectedProvider)
      );
    }

    // Input Modality filter
    if (selectedInputModalities.length > 0) {
      filtered = filtered.filter((model) =>
        selectedInputModalities.every((modality) =>
          model.architecture.input_modalities.includes(modality)
        )
      );
    }

    // TODO: Output

    // Parameters filter
    if (selectedParameters.length > 0) {
      filtered = filtered.filter((model) =>
        model.providers.some((p) =>
          selectedParameters.some((parameter) =>
            p.supported_parameters.includes(parameter as any)
          )
        )
      );
    }

    // Sorting
    // @todo: Not Use first provider
    switch (sortBy) {
      case "newest":
        filtered.sort((a, b) => {
          if (a._creationTime > b._creationTime) return -1;
          if (a._creationTime < b._creationTime) return 1;
          return 0; // ==
        });
        break;
      case "price-low":
        filtered.sort((a, b) =>
          RemFunction([
            parseFloat(a.providers[0].pricing.input),
            parseFloat(b.providers[0].pricing.input),
          ])
        );
        break;
      case "price-high":
        filtered.sort((a, b) =>
          RemFunction([
            parseFloat(b.providers[0].pricing.input),
            parseFloat(a.providers[0].pricing.input),
          ])
        );
        break;
      case "context-high":
        filtered.sort(
          (a, b) => b.providers[0].context - a.providers[0].context
        );
        break;
    }

    return filtered;
  }, [
    convexModels,
    searchQuery,
    selectedProvider,
    selectedInputModalities,
    selectedParameters,
    sortBy,
  ]);

  const toggleModality = (modality: string) => {
    setSelectedInputModalities((prev) =>
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

  const toggleParameter = (tag: string) => {
    setSelectedParameters((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const clearFilters = () => {
    setSearchQuery("");
    setSelectedProvider("All");
    setSelectedInputModalities([]);
    setSelectedOutputModalities([]);
    setSelectedParameters([]);
  };

  const hasActiveFilters =
    searchQuery ||
    selectedProvider !== "All" ||
    selectedInputModalities.length > 0 ||
    selectedOutputModalities.length > 0 ||
    selectedParameters.length > 0;

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-text-000 mb-2">Models</h1>
          <p className="text-text-300">Browse AI Models available</p>
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
                  badge={selectedInputModalities.length}
                >
                  <div className="space-y-0.5 pl-6">
                    {modelInputModalities.map((modality) => (
                      <button
                        key={modality}
                        onClick={() => toggleModality(modality)}
                        className={`w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors capitalize ${
                          selectedInputModalities.includes(modality)
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
                    {modelOutputModalities.map((modality) => (
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
                  title="Parameters"
                  icon={<CategoryIcon className="w-4 h-4" />}
                  isOpen={openSections.categories}
                  onToggle={() => toggleSection("categories")}
                  badge={selectedParameters.length}
                >
                  <div className="space-y-0.5 pl-6">
                    {supportedParameters.map((parameter) => (
                      <button
                        key={parameter}
                        onClick={() => toggleParameter(parameter)}
                        className={`w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors capitalize ${
                          selectedParameters.includes(parameter)
                            ? "bg-accent-main-100/20 text-accent-main-100"
                            : "text-text-300 hover:bg-bg-200 hover:text-text-100"
                        }`}
                      >
                        {parameter}
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
                    {configuredProviders.map((provider) => (
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

            {/* Loading State */}
            {isLoading ? (
              <ModelsLoadingSkeleton viewMode={viewMode} />
            ) : (
              <>
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
                      <ModelCard
                        key={model._id}
                        model={model}
                        authors={convexAuthors ?? []}
                        viewMode={viewMode}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="border-t border-border-200">
                    {filteredModels.map((model) => (
                      <ModelCard
                        key={model._id}
                        model={model}
                        authors={convexAuthors ?? []}
                        viewMode={viewMode}
                      />
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
