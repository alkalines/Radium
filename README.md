# 🌟 Radium

<div align="center">

**An OpenAI-Compatible AI Gateway with Multi-Provider Support and Credit-Based Billing**

[![Next.js](https://img.shields.io/badge/Next.js-16.0.5-black?logo=next.js)](https://nextjs.org/)
[![Convex](https://img.shields.io/badge/Convex-1.29.3-ff6b35?logo=convex)](https://convex.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Vercel AI SDK](https://img.shields.io/badge/AI_SDK-5.0.104-black?logo=vercel)](https://sdk.vercel.ai/)

</div>

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Architecture](#-architecture)
- [Features](#-features)
- [Getting Started](#-getting-started)
- [Contributing](#-contributing)

---

## 🎯 Overview

Radium is an **AI Gateway** that provides a unified, OpenAI-compatible API endpoint for routing LLM (Large Language Model) requests through various providers. Think of it as a self-hostable alternative to services like OpenRouter or LiteLLM, with built-in:

- **Credit-based billing system**
- **API key management**
- **Usage tracking and analytics**
- **Multi-provider load balancing**
- **Streaming (SSE) and non-streaming responses**

The project leverages **Vercel AI SDK** for seamless integration with different AI providers while maintaining OpenAI API compatibility.

---

## 🏗 Architecture

### Request Flow

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant Gateway as Radium Gateway
    participant AISDK as Vercel AI SDK
    participant LLM as LLM Provider

    Client->>Gateway: OpenAI-Compatible Request
    Gateway->>Gateway: Validate API Key & Credits
    Gateway->>AISDK: streamText / generateText
    AISDK->>LLM: Provider SDK Request
    LLM-->>AISDK: Provider Response
    AISDK-->>Gateway: UIMessageStream (Custom Chunks)
    Gateway-->>Client: OpenAI-Compatible Response<br/>(SSE Chunks or JSON)
```

---

## ✨ Features

### Core Features

| Feature               | Status | Description                                                                    |
| --------------------- | ------ | ------------------------------------------------------------------------------ |
| OpenAI-Compatible API | ✅     | Near-full compatibility with `/v1/chat/completions` and `/v1/models` endpoints |
| Streaming (SSE)       | ✅     | Server-Sent Events for real-time streaming responses                           |
| Credit System         | ✅     | Pay-per-token billing with user credits                                        |
| API Key Management    | ✅     | Secure hashed API keys with optional limits                                    |
| Usage Tracking        | ✅     | Detailed logging of all completions with timing metrics                        |
| Tool Calling          | ✅     | Full support for function calling and custom tools                             |
| Reasoning Support     | ✅     | Extended thinking/reasoning token support                                      |
| Multi-Provider        | 🔄     | Currently OpenRouter, more providers planned                                   |
| BYOK                  | 🔄     | Bring Your Own Key support (planned)                                           |
| Load Balancing        | 🔄     | Intelligent provider routing (planned)                                         |
| Embeddings            | 🔄     | Embedding model support (planned)                                              |

### Supported Model Features

- **Reasoning Modes**: `high`, `medium`, `low`, (flags such as `minimal`, `none` can be limited to only a few models)
- **Input Modalities**: Text, Image, Audio, Video, File
- **Output Modalities**: Text, Image

---

## 🚀 Getting Started

### Prerequisites

- **Bun** or **Node.js** (v18+)
- **Convex** account and project
- **OpenRouter** API key (or other supported provider)

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/alkalines/Radium.git
   cd Radium
   ```

2. **Install dependencies**

   ```bash
   bun install
   # or
   npm install
   ```

3. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your configuration:

   ```env
   Openrouter_API_Key="your-openrouter-api-key"
   AISDK_MaxRetries="0"
   CONVEX_DEPLOYMENT="your-convex-deployment"
   NEXT_PUBLIC_CONVEX_URL="https://your-deployment.convex.cloud"
   NEXT_PUBLIC_CONVEX_SITE_URL="https://your-deployment.convex.site"
   ```

4. **Set up Convex**

   ```bash
   npx convex dev
   ```

5. **Start the development server**

   ```bash
   bun dev
   # or
   npm run dev
   ```

6. **Open the application**

   Navigate to [http://localhost:3000](http://localhost:3000)

---

## ⚙️ Configuration

### Environment Variables

| Variable               | Required | Description                        |
| ---------------------- | -------- | ---------------------------------- |
| `Openrouter_API_Key`   | Yes      | Your OpenRouter API key            |
| `AISDK_MaxRetries`     | No       | Max retry attempts (default: 0)    |
| `CONVEX_DEPLOYMENT`    | Yes      | Convex deployment identifier       |
| `VITE_CONVEX_URL`      | Yes      | Convex cloud URL                   |
| `VITE_CONVEX_SITE_URL` | Yes      | Convex site URL for HTTP endpoints |

---

## 🐳 Containers

Two production images are supported:

- `Dockerfile`: full self-hosted image with the TanStack Start server and a local Convex backend in one container.
- `Dockerfile.frontend`: frontend/server image only, intended to point at Convex Cloud or a separately hosted Convex backend.

Build the full image:

```bash
docker build -t radium:local .
```

Or use Docker Compose:

```bash
SECRET_STORE_KEYS="1:$(openssl rand -base64 32)" docker compose up --build
```

Run the full image:

```bash
docker run --rm \
  -p 3000:3000 \
  -p 3210:3210 \
  -p 3211:3211 \
  -v radium-convex-data:/convex/data \
  -e SITE_URL=http://localhost:3000 \
  -e SECRET_STORE_KEYS='1:<openssl rand -base64 32>' \
  radium:local
```

The full image starts Convex first, generates a self-hosted admin key if one was not provided through `CONVEX_SELF_HOSTED_ADMIN_KEY`, deploys the bundled `convex/` functions, then starts the TanStack server on port `3000`. Convex listens on `3210`, and HTTP actions listen on `3211`.

Convex self-hosted instance credentials are generated into `/convex/data/credentials` on first boot. For reproducible production deployments, provide a persistent volume and optionally set `INSTANCE_NAME` plus a 32-byte hex `INSTANCE_SECRET`.

Build the frontend-only image:

```bash
docker build \
  -f Dockerfile.frontend \
  --build-arg VITE_CONVEX_URL=https://your-deployment.convex.cloud \
  --build-arg VITE_CONVEX_SITE_URL=https://your-deployment.convex.site \
  -t radium-frontend:local .
```

Or use Docker Compose:

```bash
VITE_CONVEX_URL=https://your-deployment.convex.cloud \
VITE_CONVEX_SITE_URL=https://your-deployment.convex.site \
docker compose -f docker-compose.frontend.yml up --build
```

Run the frontend-only image:

```bash
docker run --rm \
  -p 3000:3000 \
  -e CONVEX_URL=https://your-deployment.convex.cloud \
  -e CONVEX_SITE_URL=https://your-deployment.convex.site \
  radium-frontend:local
```

For hosted deployments, set `CONVEX_CLOUD_ORIGIN`, `CONVEX_SITE_ORIGIN`, `CONVEX_URL`, `CONVEX_SITE_URL`, `VITE_CONVEX_URL`, and `VITE_CONVEX_SITE_URL` to externally reachable URLs. The Vite variables are build-time values, so rebuild the image when those public URLs change.

---

## 🚢 Releases

Releases are tag-based and use the `version` field in `package.json` as the source of truth.

1. Update `package.json` to the next semver version, for example `0.2.0`.
2. Merge the version bump to the default branch.
3. Create and push a matching tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The release workflow builds and pushes these images to GitHub Container Registry:

- `ghcr.io/alkalines/radium:<version>` and `latest` from `Dockerfile`
- `ghcr.io/alkalines/radium-frontend:<version>` and `latest` from `Dockerfile.frontend`

It also creates a GitHub Release using generated release notes, which include merged pull requests since the previous release. You can also run the workflow manually with a version input; it will create the `v<version>` tag after verifying it matches `package.json`.

### Provider Configuration

To add a new provider, implement the `AIProviderConfig` interface:

```typescript
const NewProvider: AIProviderConfig = {
  name: "Provider Name",
  slug: "provider-slug",
  defaultBaseURL: "https://api.provider.com/v1/",
  policies: {
    trainingOnFree: false,
    trainingOnPaid: false,
    privacy_policy: "https://provider.com/privacy",
    tos: "https://provider.com/terms",
  },
  connector: (Config) => {
    return (model: string, settings?: AIProviderSDK_ModelSettings) => {
      // Return LanguageModel instance
    };
  },
};
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

This project is open source. See the repository for license details.

---

<div align="center">

**Made with ❤️ and 😡 by [Alkalines Team](https://github.com/alkalines)**

</div>
